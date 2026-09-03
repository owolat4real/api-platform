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
const nodemailer = require('nodemailer');

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

test('assertMonthlyKeyGenerationAllowed — blocks once the free-tier limit is reached', async (t) => {
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    api_keys: { countDocuments: async () => 5 },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed, FREE_TIER_MONTHLY_KEY_LIMIT } = loadFresh();
  const result = await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: true });
  assert.equal(FREE_TIER_MONTHLY_KEY_LIMIT, 5);
  assert.equal(result.allowed, false);
});

/* CRITICAL REGRESSION (2026-09-03): this used to exclude any key doc
   with metadata.rotatedFrom set, AND KeyManager.rotate() separately
   skipped this whole check (_skipGenerationCap) -- together, rotation
   was completely unlimited, a real bypass of this cap (the same class
   of bug fixed the same day across all 4 of cs_fixed's in-repo
   developer platforms). Locks in that a rotated key is now counted
   exactly like any other real key. */
test('assertMonthlyKeyGenerationAllowed — rotated keys now count toward the cap, never excluded', async (t) => {
  let capturedFilter = null;
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    api_keys: { countDocuments: async (filter) => { capturedFilter = filter; return 5; } },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed } = loadFresh();
  const result = await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: true });
  assert.equal(result.allowed, false); // 5 real keys (rotations included) hits the real cap
  assert.equal(capturedFilter['metadata.rotatedFrom'], undefined); // no longer excluded from the query
});

test('assertMonthlyKeyGenerationAllowed — extraFilter merges into the real query (environment:"live" exemption)', async (t) => {
  let capturedFilter = null;
  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    api_keys: { countDocuments: async (filter) => { capturedFilter = filter; return 0; } },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { assertMonthlyKeyGenerationAllowed } = loadFresh();
  await assertMonthlyKeyGenerationAllowed({ developerId: 'dev_1', isFreeTier: true, extraFilter: { environment: 'live' } });
  assert.equal(capturedFilter.environment, 'live');
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
      findOneAndUpdate: async (filter, update, opts) => {
        capturedArgs = { filter, update, opts };
        return { _id: 'doc1', tokenCount: 400, notified80: false, notified100: false };
      },
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
  dbConnection.getDB = () => fakeDb({ dev_platform_token_usage: { findOneAndUpdate: async () => { called = true; return null; } } });
  t.after(() => { dbConnection.getDB = originalGetDB; });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(called, false);
});

// ── 80%/100% threshold warning emails (2026-09-01) ──────────────────────
function mockTransport(capture) {
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = (opts) => ({
    sendMail: async (mailOpts) => { capture.push(mailOpts); return { messageId: 'fake' }; },
  });
  return () => { nodemailer.createTransport = originalCreateTransport; };
}

test('recordTokenUsage — crossing 80% atomically flips notified80 and sends a warning email', async (t) => {
  const originalEnv = { ...process.env };
  process.env.SMTP_HOST = 'smtp.test.example.com';
  const sent = [];
  const restoreTransport = mockTransport(sent);

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc2', tokenCount: 85000, notified80: false, notified100: false }),
      updateOne: async (filter) => {
        assert.deepEqual(filter, { _id: 'doc2', notified80: { $ne: true } });
        return { matchedCount: 1 };
      },
    },
    developers: { findOne: async () => ({ email: 'dev@example.com' }) },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; process.env = originalEnv; restoreTransport(); });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 5000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dev@example.com');
  // 85000/100000 = 85% -- the email reports the real crossed percentage,
  // not a hardcoded "80%" (which would misreport a call that jumped
  // straight from e.g. 70% to 85% in one increment).
  assert.match(sent[0].subject, /85% of your monthly quota/);
});

test('recordTokenUsage — crossing 100% sends the limit-reached email, not the 80% one', async (t) => {
  const originalEnv = { ...process.env };
  process.env.SMTP_HOST = 'smtp.test.example.com';
  const sent = [];
  const restoreTransport = mockTransport(sent);

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc3', tokenCount: 120000, notified80: false, notified100: false }),
      updateOne: async () => ({ matchedCount: 1 }),
    },
    developers: { findOne: async () => ({ email: 'dev@example.com' }) },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; process.env = originalEnv; restoreTransport(); });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 120000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Monthly quota reached/);
});

test('recordTokenUsage — a concurrent duplicate flip (updateOne matches nothing) never double-sends', async (t) => {
  const originalEnv = { ...process.env };
  process.env.SMTP_HOST = 'smtp.test.example.com';
  const sent = [];
  const restoreTransport = mockTransport(sent);

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc4', tokenCount: 85000, notified80: false, notified100: false }),
      updateOne: async () => ({ matchedCount: 0 }), // another concurrent request already won the flip
    },
    developers: { findOne: async () => ({ email: 'dev@example.com' }) },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; process.env = originalEnv; restoreTransport(); });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 5000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 0);
});

test('recordTokenUsage — already-notified80 this month is never re-checked or re-sent', async (t) => {
  const sent = [];
  const restoreTransport = mockTransport(sent);
  let updateOneCalled = false;

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc5', tokenCount: 90000, notified80: true, notified100: false }),
      updateOne: async () => { updateOneCalled = true; return { matchedCount: 1 }; },
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; restoreTransport(); });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 1000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(updateOneCalled, false);
  assert.equal(sent.length, 0);
});

test('recordTokenUsage — under 80% never touches updateOne or email at all', async (t) => {
  const sent = [];
  const restoreTransport = mockTransport(sent);
  let updateOneCalled = false;

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc6', tokenCount: 50000, notified80: false, notified100: false }),
      updateOne: async () => { updateOneCalled = true; return { matchedCount: 1 }; },
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; restoreTransport(); });

  const { recordTokenUsage } = loadFresh();
  recordTokenUsage({ developerId: 'dev_1', tokens: 1000 });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(updateOneCalled, false);
  assert.equal(sent.length, 0);
});

test('recordTokenUsage — no SMTP_HOST configured, no createTransport call, no throw', async (t) => {
  const originalEnv = { ...process.env };
  delete process.env.SMTP_HOST;
  let transportCalled = false;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => { transportCalled = true; return { sendMail: async () => {} }; };

  const originalGetDB = dbConnection.getDB;
  dbConnection.getDB = () => fakeDb({
    dev_platform_token_usage: {
      findOneAndUpdate: async () => ({ _id: 'doc7', tokenCount: 120000, notified80: false, notified100: false }),
      updateOne: async () => ({ matchedCount: 1 }),
    },
  });
  t.after(() => { dbConnection.getDB = originalGetDB; process.env = originalEnv; nodemailer.createTransport = originalCreateTransport; });

  const { recordTokenUsage } = loadFresh();
  assert.doesNotThrow(() => recordTokenUsage({ developerId: 'dev_1', tokens: 120000 }));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(transportCalled, false);
});
