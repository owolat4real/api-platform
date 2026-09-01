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
const nodemailer = require('nodemailer');

const FREE_TIER_MONTHLY_KEY_LIMIT = 3;
const FREE_TIER_MONTHLY_TOKEN_LIMIT = 100000;

function _startOfUTCMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function _yearMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * @param {object} args
 * @param {object} [args.extraFilter] - merged into the count query, e.g.
 *   { environment: 'live' } so test/sandbox key creation (2026-09-01) is
 *   exempt from this cap entirely -- see keyManager.js's create(), which
 *   skips calling this altogether for environment:'test' rather than
 *   passing a filter that would still block it.
 */
async function assertMonthlyKeyGenerationAllowed({ developerId, isFreeTier, extraFilter = {} }) {
  if (!isFreeTier) return { allowed: true, count: 0, limit: null };
  const db = getDB();
  const count = await db.collection('api_keys').countDocuments({
    developerId,
    createdAt: { $gte: _startOfUTCMonth() },
    'metadata.rotatedFrom': { $exists: false },
    ...extraFilter,
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

// Same canonical-domain guard keyManager.js's own email functions already
// apply to EMAIL_FROM -- duplicated here (not imported) because keyManager.js
// requires this file, not the other way around, and a circular require
// would be a worse fix than 5 duplicated lines.
function _canonicalDomain(val, fallback) {
  if (!val) return fallback;
  const fixed = val.replace(/careerstudio\.ai|career-studio\.ai/gi, 'careerstudiomax.com');
  return fixed;
}

// Reuses the exact same 80%/100% real-usage-crossed email pattern already
// shipped this session for cs_fixed's 4 in-repo platforms
// (services/devPlatformQuota.js) -- same one-time-per-month semantics via
// an atomic conditional updateOne, same two-tier subject/copy. Developer
// Cloud is a separate repo/DB/mailer (nodemailer direct here, not
// services/devPlatformEmailBus.js, which cs_fixed's version reuses), so
// the templates are inlined rather than shared, but the actual logic is
// the same, not reinvented.
async function _sendThresholdEmail(kind, { developerId, used, limit }) {
  if (!process.env.SMTP_HOST) return;
  try {
    const db = getDB();
    const dev = await db.collection('developers').findOne({ developerId });
    if (!dev?.email) return;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const from = _canonicalDomain(process.env.EMAIL_FROM, 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>');
    if (kind === 'notified100') {
      await transport.sendMail({
        from, to: dev.email,
        subject: 'Monthly quota reached — new requests are blocked until reset',
        html: `<p>Your CareerStudioMax Developer Cloud account has reached its free-tier limit of ${limit.toLocaleString()} tokens this month — new requests are being rejected until the quota resets next billing cycle.</p><p style="color:#888;font-size:12px">Upgrade your plan from your dashboard to keep making requests now.</p>`,
      });
    } else {
      const pct = Math.round((used / limit) * 100);
      await transport.sendMail({
        from, to: dev.email,
        subject: `You've used ${pct}% of your monthly quota — CareerStudioMax Developer Cloud`,
        html: `<p>${used.toLocaleString()} of ${limit.toLocaleString()} tokens used this month on CareerStudioMax Developer Cloud.</p><p style="color:#888;font-size:12px">This resets at the start of your next billing cycle. Upgrade your plan from your dashboard for more headroom now.</p>`,
      });
    }
  } catch (e) {
    console.warn(`[DevPlatformQuota] threshold email (${kind}) skipped:`, e.message?.slice(0, 80));
  }
}

/**
 * Fire-and-forget increment. Also fires a one-time-per-month 80%/100%
 * warning email once the real new total crosses either threshold
 * (2026-09-01), guarded by an atomic conditional updateOne so concurrent
 * requests never double-send -- see cs_fixed/services/devPlatformQuota.js's
 * own recordTokenUsage for the identical logic against Mongoose instead
 * of the raw driver.
 */
function recordTokenUsage({ developerId, tokens }) {
  if (!tokens || tokens <= 0) return;
  const db = getDB();
  db.collection('dev_platform_token_usage').findOneAndUpdate(
    { developerId, yearMonth: _yearMonth() },
    { $inc: { tokenCount: tokens } },
    { upsert: true, returnDocument: 'after' },
  ).then((result) => {
    // MongoDB driver v4+ findOneAndUpdate returns { value }; older
    // driver/mongodb-memory-server test doubles may return the doc
    // directly -- handle both without assuming either shape.
    const updated = result?.value !== undefined ? result.value : result;
    if (!updated) return;
    const used = updated.tokenCount;
    if (used >= FREE_TIER_MONTHLY_TOKEN_LIMIT && !updated.notified100) {
      db.collection('dev_platform_token_usage').updateOne(
        { _id: updated._id, notified100: { $ne: true } },
        { $set: { notified100: true } },
      ).then((r) => {
        if (r.matchedCount) _sendThresholdEmail('notified100', { developerId, used, limit: FREE_TIER_MONTHLY_TOKEN_LIMIT });
      }).catch(() => {});
    } else if (used >= FREE_TIER_MONTHLY_TOKEN_LIMIT * 0.8 && !updated.notified80) {
      db.collection('dev_platform_token_usage').updateOne(
        { _id: updated._id, notified80: { $ne: true } },
        { $set: { notified80: true } },
      ).then((r) => {
        if (r.matchedCount) _sendThresholdEmail('notified80', { developerId, used, limit: FREE_TIER_MONTHLY_TOKEN_LIMIT });
      }).catch(() => {});
    }
  }).catch(() => {});
}

module.exports = {
  FREE_TIER_MONTHLY_KEY_LIMIT,
  FREE_TIER_MONTHLY_TOKEN_LIMIT,
  assertMonthlyKeyGenerationAllowed,
  checkTokenBudget,
  recordTokenUsage,
};
