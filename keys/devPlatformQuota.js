'use strict';
/**
 * Free-tier controls for Developer Cloud's own keys, parallel to
 * cs_fixed/services/devPlatformQuota.js (same constants/logic, reimplemented
 * against the raw mongodb driver since this is a separate repo/deploy/DB —
 * can't require() across repos). Same two independent controls:
 *   1. Monthly key-GENERATION cap — real countDocuments off api_keys'
 *      own createdAt. KeyManager.rotate() tags the new doc's
 *      metadata.rotatedFrom so a rotation never counts against this.
 *   2. Monthly TOKEN budget — a real, disclosed starting number, tracked
 *      in the dev_platform_token_usage collection, one yearMonth document
 *      per developer per calendar month (see db/connection.js's index).
 */
const { getDB } = require('../db/connection');

const FREE_TIER_MONTHLY_KEY_LIMIT = 3;
const FREE_TIER_MONTHLY_TOKEN_LIMIT = 100000;

function _startOfUTCMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function _yearMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function assertMonthlyKeyGenerationAllowed({ developerId, isFreeTier }) {
  if (!isFreeTier) return { allowed: true, count: 0, limit: null };
  const db = getDB();
  const count = await db.collection('api_keys').countDocuments({
    developerId,
    createdAt: { $gte: _startOfUTCMonth() },
    'metadata.rotatedFrom': { $exists: false },
  });
  return { allowed: count < FREE_TIER_MONTHLY_KEY_LIMIT, count, limit: FREE_TIER_MONTHLY_KEY_LIMIT };
}

async function checkTokenBudget({ developerId, isFreeTier }) {
  if (!isFreeTier) return { allowed: true, used: 0, limit: null };
  const db = getDB();
  const doc = await db.collection('dev_platform_token_usage').findOne({ developerId, yearMonth: _yearMonth() });
  const used = doc?.tokenCount || 0;
  return { allowed: used < FREE_TIER_MONTHLY_TOKEN_LIMIT, used, limit: FREE_TIER_MONTHLY_TOKEN_LIMIT };
}

function recordTokenUsage({ developerId, tokens }) {
  if (!tokens || tokens <= 0) return;
  const db = getDB();
  db.collection('dev_platform_token_usage').updateOne(
    { developerId, yearMonth: _yearMonth() },
    { $inc: { tokenCount: tokens } },
    { upsert: true },
  ).catch(() => {});
}

module.exports = {
  FREE_TIER_MONTHLY_KEY_LIMIT,
  FREE_TIER_MONTHLY_TOKEN_LIMIT,
  assertMonthlyKeyGenerationAllowed,
  checkTokenBudget,
  recordTokenUsage,
};
