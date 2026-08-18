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
  ]);
  return _db;
}

function getDB() {
  if (!_db) throw new Error('Database not connected — call connect() first');
  return _db;
}

async function disconnect() {
  if (_client) { await _client.close(); _db = null; _client = null; }
}

module.exports = { connect, getDB, disconnect };
