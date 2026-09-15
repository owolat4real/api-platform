'use strict';
const { MongoClient } = require('mongodb');

let _db     = null;
let _client = null;

async function connect() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  _client   = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await _client.connect();
  _db = _client.db(process.env.MONGODB_DB || 'careerlm_api');
  console.log('[DB] Connected to MongoDB →', process.env.MONGODB_DB || 'careerlm_api');

  // Ensure indexes
  await Promise.all([
    _db.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true }),
    _db.collection('api_keys').createIndex({ developerId: 1 }),
    _db.collection('developers').createIndex({ email: 1 }, { unique: true }),
    _db.collection('career_contexts').createIndex({ contextId: 1, developerId: 1 }),
    _db.collection('usage_logs').createIndex({ developerId: 1, timestamp: -1 }),
    // Idempotency-Key support (middleware/idempotency.js) -- unique so a
    // race between two concurrent requests with the same key can only
    // ever insert one record; TTL so 24h-old records clean up on their own.
    _db.collection('idempotency_records').createIndex({ compositeKey: 1 }, { unique: true }),
    _db.collection('idempotency_records').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Free-tier monthly token budget (keys/devPlatformQuota.js) -- one doc
    // per developer per calendar month, same yearMonth-document-per-month
    // pattern cs_fixed's Cstm2Usage already uses.
    _db.collection('dev_platform_token_usage').createIndex({ developerId: 1, yearMonth: 1 }, { unique: true }),
    // Short-lived, single-use deletion capability (keys/keyManager.js's
    // issueDeletionToken/consumeDeletionToken, 2026-09-16) -- see that
    // file's own header comment for why this exists: Developer Cloud has
    // no session/password account layer, only the API key itself, so once
    // a key is revoked there is no way to re-authenticate as that
    // developer to permanently delete its record. Minted once, at revoke
    // time, while the key being revoked can still prove ownership one
    // last time -- never a second permanent credential. TTL index means
    // an unused token simply expires (the key just waits out the existing
    // 90-day grace-period cleanup instead); unique on tokenHash so two
    // tokens can never collide.
    _db.collection('key_deletion_tokens').createIndex({ tokenHash: 1 }, { unique: true }),
    _db.collection('key_deletion_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return _db;
}

function getDB() {
  if (!_db) throw new Error('Database not connected — call connect() first');
  return _db;
}

// Real gap closed (2026-09-08): KeyManager.rotate() (keys/keyManager.js)
// does two independent writes -- insert the new key, then mark the old
// one revoked -- with nothing wrapping them. A crash/error between the
// two could leave a developer with two active keys (old never revoked)
// or, less likely, a moment with neither yet committed. Exposes the raw
// client so rotate() can run both writes in one real transaction.
// Requires a replica set to support multi-document transactions --
// confirmed safe here: this cluster is MongoDB Atlas (see getAuditDB()'s
// own comment on the shared-cluster setup), which is always a replica
// set even on the free tier, never a standalone instance.
function getClient() {
  if (!_client) throw new Error('Database not connected — call connect() first');
  return _client;
}

// Shared cluster, separate database: this service's own data lives in
// MONGODB_DB (careerlm_api by default), but the main platform's admin
// audit log (cs_fixed/models/AuditLog.js) lives in the "careerstudio" db
// on the SAME Atlas cluster -- confirmed by comparing both services'
// MONGODB_URI host segments. Reuses the already-connected client rather
// than opening a second connection, so an admin gets one unified,
// cross-platform activity feed instead of api-platform's events being
// invisible outside this service's own database.
function getAuditDB() {
  if (!_client) throw new Error('Database not connected — call connect() first');
  return _client.db('careerstudio');
}

async function disconnect() {
  if (_client) { await _client.close(); _db = null; _client = null; }
}

module.exports = { connect, getDB, getAuditDB, getClient, disconnect };
