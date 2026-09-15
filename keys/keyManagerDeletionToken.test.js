'use strict';
/**
 * Focused tests for KeyManager.issueDeletionToken() /
 * validateAndConsumeDeletionToken() -- the bridge that lets a developer
 * permanently delete an already-revoked Developer Cloud key without ever
 * re-authenticating with that (now-permanently-invalid) API key.
 *
 * Mocks db/connection.js's getDB() the same way the other keys/*.test.js
 * files already do. Synthetic data only.
 *
 * Run: node --test keys/keyManagerDeletionToken.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dbConnection = require('../db/connection');

function fakeDb(overrides = {}) {
  const collections = {
    key_deletion_tokens: {
      insertOne: async () => ({ acknowledged: true }),
      findOneAndDelete: async () => null,
      ...overrides,
    },
  };
  return { collection: (name) => collections[name] };
}

function loadFresh() {
  delete require.cache[require.resolve('./keyManager')];
  return require('./keyManager').KeyManager;
}

test('issueDeletionToken stores a HASH, never the raw token, scoped to the given developer/key', async (t) => {
  const originalGetDB = dbConnection.getDB;
  let inserted = null;
  dbConnection.getDB = () => fakeDb({
    insertOne: async (doc) => { inserted = doc; return { acknowledged: true }; },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  const { token, expiresAt } = await KeyManager.issueDeletionToken('dev_1', 'key_1');

  assert.ok(token.length >= 32, 'token should be high-entropy');
  assert.ok(expiresAt instanceof Date);
  assert.equal(inserted.developerId, 'dev_1');
  assert.equal(inserted.keyId, 'key_1');
  assert.notEqual(inserted.tokenHash, token, 'the stored value must be a hash, never the raw token');
  assert.equal(inserted.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('issueDeletionToken respects KEY_DELETION_TOKEN_TTL_MINUTES', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const originalTtl = process.env.KEY_DELETION_TOKEN_TTL_MINUTES;
  process.env.KEY_DELETION_TOKEN_TTL_MINUTES = '5';
  let inserted = null;
  dbConnection.getDB = () => fakeDb({ insertOne: async (doc) => { inserted = doc; return { acknowledged: true }; } });
  t.after(() => {
    dbConnection.getDB = originalGetDB;
    if (originalTtl === undefined) delete process.env.KEY_DELETION_TOKEN_TTL_MINUTES;
    else process.env.KEY_DELETION_TOKEN_TTL_MINUTES = originalTtl;
  });

  const KeyManager = loadFresh();
  const before = Date.now();
  const { expiresAt } = await KeyManager.issueDeletionToken('dev_1', 'key_1');
  const deltaMinutes = (expiresAt.getTime() - before) / 60000;
  assert.ok(deltaMinutes > 4.9 && deltaMinutes < 5.1, `expected ~5 minutes, got ${deltaMinutes}`);
  assert.equal(inserted.expiresAt.getTime(), expiresAt.getTime());
});

test('validateAndConsumeDeletionToken returns the identity the token carries for a valid, unexpired token', async (t) => {
  const originalGetDB = dbConnection.getDB;
  let queriedFilter = null;
  dbConnection.getDB = () => fakeDb({
    findOneAndDelete: async (filter) => {
      queriedFilter = filter;
      return { developerId: 'dev_1', keyId: 'key_1', tokenHash: filter.tokenHash };
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  const identity = await KeyManager.validateAndConsumeDeletionToken('some_raw_token');

  assert.deepEqual(identity, { developerId: 'dev_1', keyId: 'key_1' });
  assert.ok(queriedFilter.expiresAt.$gt instanceof Date, 'must only match unexpired tokens');
  assert.equal(queriedFilter.tokenHash, crypto.createHash('sha256').update('some_raw_token').digest('hex'));
});

test('3. an expired/unknown/garbage token never authorizes anything', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ findOneAndDelete: async () => null });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  for (const bad of ['expired_or_unknown_token', '', null, undefined, 42, {}]) {
    const identity = await KeyManager.validateAndConsumeDeletionToken(bad);
    assert.equal(identity, null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('single-use: consuming a token deletes it atomically (findOneAndDelete), so the same raw token cannot authorize a second deletion', async (t) => {
  const originalGetDB = dbConnection.getDB;
  let callCount = 0;
  dbConnection.getDB = () => fakeDb({
    findOneAndDelete: async () => {
      callCount += 1;
      // Simulates real Mongo behavior: the document is gone after the
      // first successful findOneAndDelete, so a second call for the same
      // (now nonexistent) document returns null.
      return callCount === 1 ? { developerId: 'dev_1', keyId: 'key_1' } : null;
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  const first = await KeyManager.validateAndConsumeDeletionToken('reused_token');
  const second = await KeyManager.validateAndConsumeDeletionToken('reused_token');

  assert.deepEqual(first, { developerId: 'dev_1', keyId: 'key_1' });
  assert.equal(second, null, 'a second use of the exact same token must not authorize anything');
});
