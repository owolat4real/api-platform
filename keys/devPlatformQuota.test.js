'use strict';
/**
 * Real behavioral test for keys/devPlatformQuota.js -- the free-tier
 * monthly key-generation cap and token-budget controls, parallel to
 * cs_fixed/services/devPlatformQuota.js's own tested logic. Mocks
 * db/connection.js's getDB() by patching its cached CommonJS export
 * directly (same technique already proven in this repo for
 * keyManager.test.js's nodemailer mock -- no test framework dependency
 * beyond Node's built-in node:test/node:assert).
 *
 * Run: node --test keys/devPlatformQuota.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dbConnection = require('../db/connection');

function fakeDb(collections) {
  return { collection: (name) => collections[name] };
}

function loadFresh() {
  delete require.cache[require.resolve('./devPlatformQuota')];
  return require('./devPlatformQuota');
}

test('assertMonthlyKeyGenerationAllowed — always allows when not free tier, no query at all', async (t) => {
  const countDocuments = async () => { throw new Error('should not be called'); };
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ api_keys: { countDocuments } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed } = loadFresh();
  const result = await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: false });
  assert.deepEqual(result, { allowed: true, count: 0, limit: null });
});

test('assertMonthlyKeyGenerationAllowed — allows under the free-tier limit', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ api_keys: { countDocuments: async () => 1 } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed, FREE_TIER_MONTHLY_KEY_LIMIT } = loadFresh();
  const result = await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: true });
  assert.equal(result.allowed, true);
  assert.equal(result.count, 1);
  assert.equal(result.limit, FREE_TIER_MONTHLY_KEY_LIMIT);
});

test('assertMonthlyKeyGenerationAllowed — blocks once the free-tier limit is reached, excludes rotated-in keys', async (t) => {
  let capturedFilter = null;
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    api_keys: {
      countDocuments: async (filter) => { capturedFilter = filter; return 3; },
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed } = loadFresh();
  const result = await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: true });
  assert.equal(result.allowed, false);
  assert.deepEqual(capturedFilter['metadata.rotatedFrom'], { $exists: false });
});

test('checkTokenBudget — real, honest zero for a developer with no usage doc yet', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ dev_platform_token_usage: { findOne: async () => null } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { checkTokenBudget, FREE_TIER_MONTHLY_TOKEN_LIMIT } = loadFresh();
  const result = await checkTokenBudget({ developerId: 'dev_1', isFreeTier: true });
  assert.deepEqual(result, { allowed: true, used: 0, limit: FREE_TIER_MONTHLY_TOKEN_LIMIT });
});

test('checkTokenBudget — blocks once the free-tier budget is exhausted', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ dev_platform_token_usage: { findOne: async () => ({ tokenCount: 999999 }) } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { checkTokenBudget } = loadFresh();
  const result = await checkTokenBudget({ developerId: 'dev_1', isFreeTier: true });
  assert.equal(result.allowed, false);
});

test('recordTokenUsage — upserts a real $inc into the real yearMonth document', async (t) => {
  let capturedArgs = null;
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      updateOne: async (filter, update, opts) => { capturedArgs = { filter, update, opts }; return {}; },
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 400 });
  await new Promise((r) => setImmediate(r));

  assert.equal(capturedArgs.filter.developerId, 'dev_1');
  assert.deepEqual(capturedArgs.update, { $inc: { tokenCount: 400 } });
  assert.equal(capturedArgs.opts.upsert, true);
});

test('recordTokenUsage — never writes for a zero token count', async (t) => {
  let called = false;
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({ dev_platform_token_usage: { updateOne: async () => { called = true; return {}; } } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(called, false);
});
