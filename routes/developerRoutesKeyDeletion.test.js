'use strict';
/**
 * Real-HTTP tests for the Developer Cloud key-deletion flow across BOTH
 * routes in routes/developerRoutes.js:
 *   DELETE /v1/developer/keys/:developerId/:keyId  (legacy: revoke,
 *     authenticated via X-Api-Key/_requireOwnKey; now also issues a
 *     deletion token on successful revoke)
 *   DELETE /v1/developer/keys/:keyId                (new: authorized by
 *     X-Deletion-Token alone, reachable with no API key at all -- the
 *     fix for the confirmed unreachability of the old escalation branch)
 *
 * Mounts routes/developerRoutes.js directly on a minimal Express app (the
 * same mount path server.js itself uses, '/v1/developer'), and mocks
 * db/connection.js's getDB()/getClient()/getAuditDB() -- no real MongoDB,
 * no real server.js boot (which would try to bind a port and connect to
 * Mongo). Synthetic data only.
 *
 * Run: node --test routes/developerRoutesKeyDeletion.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const dbConnection = require('../db/connection');

const { ObjectId } = require('mongodb');
const KEY_1 = new ObjectId('507f1f77bcf86cd799439011'); // dev_1's key -- the one under test
const KEY_2 = new ObjectId('507f1f77bcf86cd799439022'); // dev_2's key -- belongs to someone else, already revoked

// Matches KeyManager.validate()'s required format: csk_(live|test|free)_v1_[48 hex]
const RAW_KEY_1 = 'csk_live_v1_' + 'a'.repeat(48);
const HASH_KEY_1 = crypto.createHash('sha256').update(RAW_KEY_1).digest('hex');
const OWNER_AUTH_HEADERS = { 'X-Api-Key': RAW_KEY_1 }; // dev_1 proving ownership the way _requireOwnKey expects

// Generic in-memory equality matcher -- stands in for the real MongoDB
// filters this route file actually issues ({_id, developerId} and
// {keyHash[, status]}), without hardcoding one specific shape.
function _matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
}

function fakeDb(state) {
  const collections = {
    api_keys: {
      findOne: async (filter) => state.apiKeys.find(k => _matches(k, filter)) || null,
      updateOne: async (filter, update) => {
        const doc = state.apiKeys.find(k => _matches(k, filter));
        if (!doc) return { matchedCount: 0 };
        Object.assign(doc, update.$set);
        return { matchedCount: 1 };
      },
      deleteOne: async (filter) => {
        const before = state.apiKeys.length;
        state.apiKeys = state.apiKeys.filter(k => !_matches(k, filter));
        return { deletedCount: before - state.apiKeys.length };
      },
    },
    key_deletion_tokens: {
      insertOne: async (doc) => { state.tokens.push({ ...doc, _id: crypto.randomUUID() }); return { acknowledged: true }; },
      findOneAndDelete: async (filter) => {
        const idx = state.tokens.findIndex(t => t.tokenHash === filter.tokenHash && t.expiresAt > new Date());
        if (idx === -1) return null;
        const [doc] = state.tokens.splice(idx, 1);
        return doc;
      },
    },
  };
  return { collection: (name) => collections[name] };
}

function loadApp(state) {
  dbConnection.getDB = () => fakeDb(state);
  dbConnection.getClient = () => ({ db: () => ({ collection: () => ({ insertOne: async () => ({}) }) }) });
  dbConnection.getAuditDB = () => ({ collection: () => ({ insertOne: async () => ({ acknowledged: true }) }) });
  delete require.cache[require.resolve('../keys/keyManager')];
  delete require.cache[require.resolve('./developerRoutes')];
  const router = require('./developerRoutes');
  const app = express();
  app.use(express.json());
  app.use('/v1/developer', router);
  return app;
}

async function serve(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  async function request(method, path, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  try { return await fn(request); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function freshState() {
  return {
    apiKeys: [
      {
        _id: KEY_1, developerId: 'dev_1', status: 'active', name: 'Key One',
        keyHash: HASH_KEY_1, dailyLimit: Number.MAX_SAFE_INTEGER,
        todayRequests: 0, todayDate: new Date().toDateString(),
      },
      { _id: KEY_2, developerId: 'dev_2', status: 'revoked', revokedAt: new Date(), name: 'Someone Else Key', keyHash: 'other_hash_never_leak' },
    ],
    tokens: [],
  };
}

test('1/9. revoking an active key (owner-authenticated) succeeds and issues a deletion token; that token then deletes it', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const revokeRes = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS });
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.body.status, 'revoked');
    assert.ok(revokeRes.body.deletion_token, 'a deletion token must be issued on revoke');

    const deleteRes = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': revokeRes.body.deletion_token } });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.body.status, 'deleted');
    assert.equal(state.apiKeys.some(k => String(k._id) === String(KEY_1)), false, '6. deleted key disappears from the underlying store');
  });
});

test('2. an active key cannot be permanently deleted -- no valid token exists for it without a prior revoke', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    // No revoke happened, so no real token for KEY_1 was ever minted --
    // proves an active key can never reach the delete route through the
    // real flow. (A garbage/forged token is covered directly, at the unit
    // level, in keyManagerDeletionToken.test.js -- it can never validate
    // without knowing the exact raw value whose SHA-256 was stored.)
    const res = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': 'not_a_real_token' } });
    assert.equal(res.status, 401);
    assert.equal(state.apiKeys.some(k => String(k._id) === String(KEY_1)), true, 'key must still exist');
  });
});

test('3. the revoked API key itself cannot authorize the deletion request -- the new route never re-validates an API key at all', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS }); // revoke
    const res = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Api-Key': RAW_KEY_1 } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'missing_deletion_token');
  });
});

test('4/5. another developer cannot delete this owner\'s key -- guessed tokens fail, and a token minted for a DIFFERENT key never works against this one', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const revokeRes = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS });
    const dev1Token = revokeRes.body.deletion_token;

    // An attacker (or another developer) has no way to obtain dev_1's real
    // token -- guessing/reusing an arbitrary value fails outright.
    const guess = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': 'someone_elses_guess' } });
    assert.equal(guess.status, 401);

    // A token that IS real, but was minted for a DIFFERENT key (KEY_2,
    // already revoked -- simulating another developer's own legitimately
    // -issued token), must never delete KEY_1 just because the URL asks
    // for KEY_1. Issued directly via KeyManager here to isolate this
    // specific cross-key check from dev_2's own separate auth chain.
    const KeyManager = require('../keys/keyManager').KeyManager;
    const { token: dev2Token } = await KeyManager.issueDeletionToken('dev_2', String(KEY_2));
    const crossKeyAttempt = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': dev2Token } });
    assert.equal(crossKeyAttempt.status, 404, 'a token scoped to a different key must not delete this one');
    assert.equal(state.apiKeys.some(k => String(k._id) === String(KEY_1)), true, 'KEY_1 must be untouched');

    // dev_1's own real token still only ever works for KEY_1, never KEY_2.
    const wrongUrl = await request('DELETE', `/v1/developer/keys/${KEY_2}`, { headers: { 'X-Deletion-Token': dev1Token } });
    assert.equal(wrongUrl.status, 404, 'a token minted for KEY_1 must not delete KEY_2');
    assert.equal(state.apiKeys.some(k => String(k._id) === String(KEY_2)), true, 'KEY_2 must be untouched');
  });
});

test('7/8. deleted key is gone from the store and can never authenticate again (no fallback/master credential)', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const revokeRes = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS });
    await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': revokeRes.body.deletion_token } });

    const KeyManager = require('../keys/keyManager').KeyManager;
    const validationOfDeletedKey = await KeyManager.validate(RAW_KEY_1);
    assert.equal(validationOfDeletedKey.valid, false, 'the exact key that was just deleted must never authenticate again');

    const validationOfAnything = await KeyManager.validate('csk_live_v1_' + 'f'.repeat(48));
    assert.equal(validationOfAnything.valid, false, 'no universal/fallback credential exists for a missing record');
  });
});

test('11. delete response contains no secret/hash material', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const revokeRes = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS });
    const deleteRes = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': revokeRes.body.deletion_token } });
    const serialized = JSON.stringify(deleteRes.body).toLowerCase();
    assert.ok(!serialized.includes(HASH_KEY_1));
    assert.ok(!serialized.includes(RAW_KEY_1));
    assert.ok(!/keyhash|tokenhash/.test(serialized));
  });
});

test('a used deletion token cannot be replayed', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const revokeRes = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`, { headers: OWNER_AUTH_HEADERS });
    const token = revokeRes.body.deletion_token;
    const first = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': token } });
    assert.equal(first.status, 200);
    const replay = await request('DELETE', `/v1/developer/keys/${KEY_1}`, { headers: { 'X-Deletion-Token': token } });
    assert.equal(replay.status, 401, 'a consumed token must never work a second time');
  });
});

test('nonexistent key id on the legacy owner-authenticated route is handled safely', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const fakeId = new ObjectId('507f1f77bcf86cd799439099');
    const res = await request('DELETE', `/v1/developer/keys/dev_1/${fakeId}`, { headers: OWNER_AUTH_HEADERS });
    assert.equal(res.status, 404);
  });
});

test('the legacy route still rejects a request with no API key at all (unchanged pre-existing behavior)', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const res = await request('DELETE', `/v1/developer/keys/dev_1/${KEY_1}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'missing_api_key');
  });
});

// --- On-demand deletion-token minting (POST /keys/:developerId/:keyId/deletion-token) ---
// Covers the case the revoke-time token alone doesn't: a developer who
// rotated a while ago (KeyManager.rotate leaves the old key revoked, no
// token was ever consumed for it) and comes back later, still holding a
// currently-active key, to clean up the old one.

test('on-demand token: an owner authenticated via a DIFFERENT still-active key can mint a fresh token for an older already-revoked key and delete it', async () => {
  const OLD_KEY = new ObjectId('507f1f77bcf86cd799439033');
  const state = freshState();
  state.apiKeys.push({ _id: OLD_KEY, developerId: 'dev_1', status: 'revoked', revokedAt: new Date(), name: 'Old Key' });
  const app = loadApp(state);
  await serve(app, async (request) => {
    const mintRes = await request('POST', `/v1/developer/keys/dev_1/${OLD_KEY}/deletion-token`, { headers: OWNER_AUTH_HEADERS });
    assert.equal(mintRes.status, 200);
    assert.ok(mintRes.body.deletion_token);
    assert.ok(!JSON.stringify(mintRes.body).match(/keyhash|tokenhash/i));

    const deleteRes = await request('DELETE', `/v1/developer/keys/${OLD_KEY}`, { headers: { 'X-Deletion-Token': mintRes.body.deletion_token } });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.body.status, 'deleted');
    assert.equal(state.apiKeys.some(k => String(k._id) === String(OLD_KEY)), false);
  });
});

test('on-demand token: cannot be minted for a still-active key', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const res = await request('POST', `/v1/developer/keys/dev_1/${KEY_1}/deletion-token`, { headers: OWNER_AUTH_HEADERS });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'key_still_active');
  });
});

test('on-demand token: another developer cannot mint a token for a key they don\'t own, even revoked', async () => {
  const state = freshState(); // KEY_2 belongs to dev_2, already revoked
  const app = loadApp(state);
  await serve(app, async (request) => {
    const res = await request('POST', `/v1/developer/keys/dev_1/${KEY_2}/deletion-token`, { headers: OWNER_AUTH_HEADERS });
    assert.equal(res.status, 404, 'KEY_2 is not owned by dev_1');
    assert.equal(state.apiKeys.some(k => String(k._id) === String(KEY_2)), true);
  });
});

test('on-demand token: rejects a request with no valid API key at all', async () => {
  const state = freshState();
  const app = loadApp(state);
  await serve(app, async (request) => {
    const res = await request('POST', `/v1/developer/keys/dev_1/${KEY_2}/deletion-token`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'missing_api_key');
  });
});
