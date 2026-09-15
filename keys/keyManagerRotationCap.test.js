'use strict';
/**
 * Real behavioral test for KeyManager.rotate()'s monthly generation-cap
 * enforcement (2026-09-03).
 *
 * Real gap closed: rotate() used to call create({..., _skipGenerationCap:
 * true, metadata: {rotatedFrom: oldKeyHash}}), and devPlatformQuota's own
 * count query separately excluded any doc with metadata.rotatedFrom set --
 * together, a free-tier developer could rotate the same key unlimited
 * times per month, completely bypassing the monthly generation cap this
 * repo otherwise enforces. Same class of bug fixed the same day across
 * all 4 of cs_fixed's in-repo developer platforms (CAMP, CSTM-2, CSVM,
 * Transformer).
 *
 * Mocks db/connection.js's getDB() the same way devPlatformQuota.test.js
 * and keyManager.test.js already do -- reassign the cached CommonJS
 * export, then require keyManager.js fresh so it destructures the mock.
 *
 * Fixed 2026-09-16 (stale fixture, found during the Developer Cloud
 * delete-reachability task): rotate() started using client.startSession()
 * + session.withTransaction(...) on 2026-09-08 (see keyManager.js's own
 * "Real gap closed" comment on rotate(), db/connection.js's getClient())
 * so the new key and the old key's revocation commit atomically. This
 * file's fakeDb() only ever mocked getDB() -- getClient() was left
 * completely unmocked, so every real MongoClient.startSession() call hit
 * db/connection.js's real getClient(), which throws "Database not
 * connected" outside a real Mongo process. This is a stale-test-fixture
 * gap only: the assertions themselves (cap enforcement, revoke-on-
 * rotate, live-environment default) were never wrong and are unchanged
 * below -- fakeClient() just gives the transaction machinery something to
 * call so the code under test can actually run.
 *
 * Run: node --test keys/keyManagerRotationCap.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dbConnection = require('../db/connection');

function fakeDb(overrides = {}) {
  const collections = {
    api_keys: {
      findOne: async () => null,
      insertOne: async () => ({ acknowledged: true }),
      updateOne: async () => ({ acknowledged: true }),
      countDocuments: async () => 0,
      ...overrides,
    },
  };
  return { collection: (name) => collections[name] };
}

// A minimal stand-in for the real MongoClient session API rotate() drives:
// startSession() -> { withTransaction(fn), endSession() }. withTransaction
// just awaits and runs the callback directly -- no real cross-document
// atomicity is meaningful against an in-memory fake collection, so there's
// nothing to simulate beyond "the callback actually executes".
function fakeClient() {
  return {
    startSession: () => ({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    }),
  };
}

function loadFresh() {
  delete require.cache[require.resolve('./keyManager')];
  delete require.cache[require.resolve('./devPlatformQuota')];
  return require('./keyManager').KeyManager;
}

test('rotate — under the cap, rotation succeeds and revokes the old key', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const originalGetClient = dbConnection.getClient;
  const oldKey = { keyHash: 'old_hash', developerId: 'dev_1', tier: 'FREE', name: 'My Key', metadata: {} };
  let revokedFilter = null;
  let inserted = null;
  dbConnection.getDB = () => fakeDb({
    findOne: async () => oldKey,
    countDocuments: async () => 1, // 1 real key so far this month -- well under the cap
    insertOne: async (doc) => { inserted = doc; return { acknowledged: true }; },
    updateOne: async (filter) => { revokedFilter = filter; return { acknowledged: true }; },
  });
  dbConnection.getClient = fakeClient;
  t.after(() => { dbConnection.getDB = originalGetDB; dbConnection.getClient = originalGetClient; });

  const KeyManager = loadFresh();
  const result = await KeyManager.rotate('old_hash', 'dev_1');

  assert.ok(result.key.startsWith('csk_'));
  assert.equal(inserted.metadata.rotatedFrom, 'old_hash');
  assert.equal(inserted.developerId, 'dev_1');
  assert.deepEqual(revokedFilter, { keyHash: 'old_hash' });
});

/* CRITICAL REGRESSION (2026-09-03): the exact live gap this fix closes --
   a developer who has already used up their real monthly cap (via prior
   creates and/or prior rotations, all now counted the same way) must be
   blocked from rotating again, not given an unconditional pass. */
test('CRITICAL REGRESSION: rotate — blocked once the free-tier monthly cap is already reached, no longer an unconditional bypass', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const originalGetClient = dbConnection.getClient;
  const oldKey = { keyHash: 'old_hash', developerId: 'dev_1', tier: 'FREE', name: 'My Key', metadata: {} };
  let insertCalled = false;
  dbConnection.getDB = () => fakeDb({
    findOne: async () => oldKey,
    countDocuments: async () => 5, // already at the real cap this month
    insertOne: async () => { insertCalled = true; return { acknowledged: true }; },
  });
  dbConnection.getClient = fakeClient;
  t.after(() => { dbConnection.getDB = originalGetDB; dbConnection.getClient = originalGetClient; });

  const KeyManager = loadFresh();
  await assert.rejects(
    () => KeyManager.rotate('old_hash', 'dev_1'),
    /Free tier is limited to 5 new live keys per calendar month/,
  );
  assert.equal(insertCalled, false, 'no new key document was ever created once the cap was reached');
});

test('rotate — a rotated key is created with environment defaulting to "live", so it is correctly counted by the live-only cap filter', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const originalGetClient = dbConnection.getClient;
  const oldKey = { keyHash: 'old_hash', developerId: 'dev_1', tier: 'FREE', name: 'My Key', metadata: {} };
  let inserted = null;
  dbConnection.getDB = () => fakeDb({
    findOne: async () => oldKey,
    countDocuments: async () => 0,
    insertOne: async (doc) => { inserted = doc; return { acknowledged: true }; },
  });
  dbConnection.getClient = fakeClient;
  t.after(() => { dbConnection.getDB = originalGetDB; dbConnection.getClient = originalGetClient; });

  const KeyManager = loadFresh();
  await KeyManager.rotate('old_hash', 'dev_1');
  assert.equal(inserted.environment, 'live');
});
