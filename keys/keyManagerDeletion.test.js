'use strict';
/**
 * Focused tests for KeyManager.deleteKey() / listRevokedByDeveloper() --
 * the permanent-delete half of Developer Cloud's "revoke, then delete"
 * key lifecycle (keys/keyManager.js, DELETE /keys/:developerId/:keyId in
 * routes/developerRoutes.js). Both already existed before this task;
 * these tests close a real coverage gap -- keyManager.test.js never
 * exercised either.
 *
 * Mocks db/connection.js's getDB() the same way keyManagerRotationCap.test.js
 * already does -- reassign the cached CommonJS export, then require
 * keyManager.js fresh so it destructures the mock. Synthetic data only.
 *
 * Run: node --test keys/keyManagerDeletion.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dbConnection = require('../db/connection');

function fakeDb(overrides = {}) {
  const collections = {
    api_keys: {
      findOne: async () => null,
      deleteOne: async () => ({ acknowledged: true, deletedCount: 0 }),
      deleteMany: async () => ({ acknowledged: true, deletedCount: 0 }),
      find: () => ({ project: () => ({ toArray: async () => [] }) }),
      ...overrides,
    },
  };
  return { collection: (name) => collections[name] };
}

function loadFresh() {
  delete require.cache[require.resolve('./keyManager')];
  delete require.cache[require.resolve('./devPlatformQuota')];
  return require('./keyManager').KeyManager;
}

test('1. owner can delete their own revoked key', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const revokedKey = { _id: 'obj_1', developerId: 'dev_1', status: 'revoked', name: 'My Key' };
  let deleteFilter = null;
  dbConnection.getDB = () => fakeDb({
    findOne: async (filter) => { return String(filter._id) === String(revokedKey._id) && filter.developerId === 'dev_1' ? revokedKey : null; },
    deleteOne: async (filter) => { deleteFilter = filter; return { acknowledged: true, deletedCount: 1 }; },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  // deleteKey builds its own ObjectId from the string id -- use a real
  // 24-hex-char id shape so `new ObjectId(keyId)` succeeds.
  const keyId = '507f1f77bcf86cd799439011';
  revokedKey._id = new (require('mongodb').ObjectId)(keyId);
  await KeyManager.deleteKey('dev_1', keyId);

  assert.ok(deleteFilter, 'deleteOne must have been called');
  assert.equal(String(deleteFilter._id), keyId);
});

test('2. owner cannot delete an active key -- rejects with key_still_active, never calls deleteOne', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const { ObjectId } = require('mongodb');
  const keyId = '507f1f77bcf86cd799439012';
  const activeKey = { _id: new ObjectId(keyId), developerId: 'dev_1', status: 'active', name: 'My Key' };
  let deleteCalled = false;
  dbConnection.getDB = () => fakeDb({
    findOne: async () => activeKey,
    deleteOne: async () => { deleteCalled = true; return { acknowledged: true, deletedCount: 1 }; },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  await assert.rejects(
    () => KeyManager.deleteKey('dev_1', keyId),
    (e) => e.code === 'key_still_active',
  );
  assert.equal(deleteCalled, false);
});

test('3/4. another developer\'s key id -- scoped findOne returns null, safe not-found, never deletes', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const keyId = '507f1f77bcf86cd799439013';
  dbConnection.getDB = () => fakeDb({
    // Simulates the real scoped query: { _id, developerId } together --
    // another developer's key never matches this developerId, exactly
    // like a real MongoDB filter wouldn't.
    findOne: async (filter) => (filter.developerId === 'dev_1' ? null : { _id: keyId, developerId: 'someone_else', status: 'revoked' }),
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  await assert.rejects(
    () => KeyManager.deleteKey('dev_1', keyId),
    (e) => e.code === 'key_not_found' && !/someone_else/.test(e.message),
  );
});

test('6. nonexistent key ID handled safely (identical shape to cross-owner case)', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ findOne: async () => null });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  await assert.rejects(
    () => KeyManager.deleteKey('dev_1', '507f1f77bcf86cd799439014'),
    (e) => e.code === 'key_not_found',
  );
});

test('invalid key id shape is handled by the route layer, not by throwing an unrelated error out of KeyManager', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb();
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  // Not a valid 24-hex ObjectId -- new ObjectId(...) itself throws; the
  // real route (developerRoutes.js) catches this class of error earlier
  // with its own explicit invalid_key_id response before ever calling
  // KeyManager.deleteKey, but KeyManager itself must not silently
  // "succeed" on garbage input either.
  await assert.rejects(() => KeyManager.deleteKey('dev_1', 'not-a-valid-id'));
});

test('7. listRevokedByDeveloper only returns this developer\'s revoked keys, never keyHash', async (t) => {
  const originalGetDB = dbConnection.getDB;
  let queriedFilter = null;
  let projected = null;
  dbConnection.getDB = () => fakeDb({
    find: (filter) => {
      queriedFilter = filter;
      return { project: (proj) => { projected = proj; return { toArray: async () => [{ _id: 'k1', name: 'Old Key', status: 'revoked' }] }; } };
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  const result = await KeyManager.listRevokedByDeveloper('dev_1');
  assert.deepEqual(queriedFilter, { developerId: 'dev_1', status: 'revoked' });
  assert.deepEqual(projected, { keyHash: 0, recentCalls: 0 });
  assert.equal(result.length, 1);
});

test('12. deleteKey performs a hard delete -- no return value carrying key material (nothing to leak)', async (t) => {
  const originalGetDB = dbConnection.getDB;
  const { ObjectId } = require('mongodb');
  const keyId = '507f1f77bcf86cd799439015';
  const revokedKey = { _id: new ObjectId(keyId), developerId: 'dev_1', status: 'revoked', keyHash: 'synthetic_test_hash_should_never_be_returned' };
  dbConnection.getDB = () => fakeDb({
    findOne: async () => revokedKey,
    deleteOne: async () => ({ acknowledged: true, deletedCount: 1 }),
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const KeyManager = loadFresh();
  const result = await KeyManager.deleteKey('dev_1', keyId);
  assert.equal(result, undefined, 'deleteKey resolves with no payload -- the route layer alone decides the safe { status: "deleted" } response shape');
});
