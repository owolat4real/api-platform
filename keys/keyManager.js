'use strict';
const crypto      = require('crypto');
const nodemailer  = require('nodemailer');
const { getDB }   = require('../db/connection');

// Live-caught (2026-08-24): EMAIL_FROM was set directly in this service's
// own Render dashboard to "CareerStudioMax Developer Cloud
// <api@careerstudio.ai>" -- the platform's retired domain (careerstudiomax.com
// is canonical everywhere else) -- silently sending every welcome email
// from an address real mail providers have no reason to trust. Same
// class of bug cs_fixed's config/validateEnv.js has a guard for; this
// mirrors that guard's scope (fix the stored value directly, but also
// never trust it blindly again) for this separate, standalone repo.
function _canonicalDomain(val, fallback) {
  if (!val) return fallback;
  const fixed = val.replace(/careerstudio\.ai|career-studio\.ai/gi, 'careerstudiomax.com');
  if (fixed !== val) console.error(`\n🚨 DOMAIN MISCONFIGURATION AUTO-CORRECTED: was "${val}", using "${fixed}" instead. Fix the real stored value in Render's dashboard.\n`);
  return fixed;
}
const PORTAL_URL = _canonicalDomain(process.env.PORTAL_URL, 'https://careerstudiomax.com');

// Renamed 2026-08-19 (same directive as Transformer's rename in
// cs_fixed/routes/transformer.js): cs-haiku/cs-sonnet/cs-opus ->
// cs-adeife/cs-ademide/cs-demilade. This `models` array is informational
// only (never checked against a request — developers here can't pick a
// model, every endpoint is feature-routed, see careerRoutes.js), so the
// rename is display-identifier-only. Old names are kept recognized
// everywhere they might still surface: existing api_keys.models arrays
// already persisted with the old names, and CareerCamp's own gateway
// (careercamp-ai), which hasn't renamed its Modelfiles and still reports
// data.model as cs-haiku/cs-sonnet/cs-opus at request time.
const MODEL_DISPLAY_NAMES = {
  'cs-adeife':   'careerlm-flash',
  'cs-ademide':  'careerlm-standard',
  'cs-demilade': 'careerlm-deep',
  'cs-haiku':    'careerlm-flash',  // old name, still returned live by careercamp-ai
  'cs-sonnet':   'careerlm-standard',
  'cs-opus':     'careerlm-deep',
};

/* ── TIER CONFIG ──────────────────────────────────────────────
   Single source of truth for all tier limits and features.    */
const API_TIERS = {
  FREE: {
    name:           'Free',
    price:          0,
    daily_requests: 1000,
    rpm:            10,
    models:         ['cs-adeife'],
    features:       ['basic_career', 'cv_score', 'quick_advice'],
    max_tokens:     300,
    support:        'community',
  },
  PRO: {
    name:           'Pro',
    price:          19,
    daily_requests: 10000,
    rpm:            60,
    models:         ['cs-adeife', 'cs-ademide'],
    features:       ['all_career', 'cv_optimise', 'cover_letter', 'interview_prep', 'salary_bench'],
    max_tokens:     1500,
    support:        'email',
  },
  PLUS: {
    name:           'Plus',
    price:          49,
    daily_requests: 100000,
    rpm:            200,
    models:         ['cs-adeife', 'cs-ademide', 'cs-demilade'],
    features:       ['all_career', 'all_features', 'batch_processing', 'webhooks', 'custom_system_prompts'],
    max_tokens:     2048,
    support:        'priority_email',
  },
  ENTERPRISE: {
    name:           'Enterprise',
    price:          199,
    daily_requests: Infinity,
    rpm:            1000,
    models:         ['cs-adeife', 'cs-ademide', 'cs-demilade'],
    features:       ['all', 'fine_tuning', 'private_deployment', 'sla_99_9', 'dedicated_support', 'custom_models'],
    max_tokens:     4096,
    support:        'dedicated_slack',
  },
};

/* ── WELCOME EMAIL ─────────────────────────────────────────── */
async function sendWelcomeEmail(developerId, apiKey, tier) {
  if (!process.env.SMTP_HOST) return;
  try {
    const db  = getDB();
    const dev = await db.collection('developers').findOne({ developerId });
    if (!dev?.email) return;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from:    _canonicalDomain(process.env.EMAIL_FROM, 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>'),
      to:      dev.email,
      subject: 'Your CareerStudioMax Developer Cloud API key is ready',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
          <h2 style="color:#6366f1">Welcome to CareerStudioMax Developer Cloud, ${dev.name}!</h2>
          <p>Your <strong>${tier}</strong> API key — shown once only, store it now:</p>
          <pre style="background:#f5f5f5;padding:14px;border-radius:6px;font-size:13px;word-break:break-all">${apiKey}</pre>
          <h3>Get started in 60 seconds</h3>
          <pre style="background:#0d1117;color:#e2e8f0;padding:14px;border-radius:6px;font-size:13px">npm install careerlm

const { CareerLM } = require('careerlm')
const client = new CareerLM('${apiKey.slice(0,20)}...')

// Score a CV
const score = await client.cv.score(cvText, jobDescription)
console.log(score.ats_score)  // 87</pre>
          <p><a href="https://careerstudiomax.com/api/docs/quickstart" style="color:#6366f1">Full quickstart guide →</a></p>
          <hr style="border:1px solid #eee;margin:24px 0">
          <p style="color:#888;font-size:12px">CareerStudioMax Developer Cloud — a career intelligence API<br>
          Free tier: 1,000 requests/day forever. <a href="${PORTAL_URL}/pricing" style="color:#6366f1">Upgrade anytime →</a></p>
        </div>`,
    });
  } catch (e) {
    console.warn('[KeyManager] Welcome email skipped:', e.message?.slice(0, 80));
  }
}

/* ── ADMIN ALERT ───────────────────────────────────────────────
   Real, honest gap found (2026-08-24): this service's new-signup event
   only ever reached the shared admin audit log (routes/developerRoutes.js's
   getAuditDB() write) -- a passive record admin has to go check. The four
   OTHER developer platforms (cs_fixed's Transformer/CSTM-2/CAMP/CSVM auth
   routes) all additionally fire a real-time Telegram+email ping via
   services/adminAlert.js on every signup. This service has no Telegram
   credentials configured and is a separate codebase from services/
   adminAlert.js, so it can't reuse that module directly -- this is the
   email-only equivalent, reusing the exact SMTP transport sendWelcomeEmail
   above already uses, with the same ADMIN_EMAIL/FOUNDER_EMAIL fallback
   chain services/adminAlert.js uses in the other codebase, so behavior
   matches even though the code can't be shared. */
async function alertAdmin(subject, detail) {
  if (!process.env.SMTP_HOST) return;
  const to = process.env.ADMIN_EMAIL || process.env.FOUNDER_EMAIL || 'owo1232011@gmail.com';
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from:    _canonicalDomain(process.env.EMAIL_FROM, 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>'),
      to,
      subject: `🚨 ${subject}`,
      html:    `<p>${detail.replace(/\n/g, '<br>')}</p><p style="color:#888;font-size:12px">env: ${process.env.NODE_ENV || 'development'}</p>`,
    });
  } catch (e) {
    console.warn('[KeyManager] Admin alert skipped:', e.message?.slice(0, 80));
  }
}

class KeyManager {

  /* ── GENERATE ─────────────────────────────────────────────── */
  static generate(tier = 'FREE', environment = 'live') {
    const prefix  = tier === 'FREE' ? 'csk_free' : `csk_${environment}`;
    const secret  = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    const key     = `${prefix}_v1_${secret}`;
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    return { key, keyHash, prefix };
  }

  /* ── CREATE ───────────────────────────────────────────────── */
  static async create({ developerId, tier, environment = 'live', name = 'Default Key', metadata = {} }) {
    const db         = getDB();
    const tierConfig = API_TIERS[tier];
    if (!tierConfig) throw new Error(`Unknown tier: ${tier}`);

    const { key, keyHash, prefix } = this.generate(tier, environment);
    const dailyLimit = tierConfig.daily_requests === Infinity
      ? Number.MAX_SAFE_INTEGER
      : tierConfig.daily_requests;

    const keyRecord = {
      keyHash,
      prefix,
      developerId,
      tier,
      environment,
      name,
      metadata,
      status:        'active',
      createdAt:     new Date(),
      lastUsedAt:    null,
      totalRequests: 0,
      todayRequests: 0,
      todayDate:     new Date().toDateString(),
      totalTokens:   0,
      dailyLimit,
      rpm:           tierConfig.rpm,
      maxTokens:     tierConfig.max_tokens,
      models:        tierConfig.models,
      features:      tierConfig.features,
      recentCalls:   [],
    };

    await db.collection('api_keys').insertOne(keyRecord);
    // Non-blocking — email failure never blocks key creation
    sendWelcomeEmail(developerId, key, tier).catch(() => {});
    return { key, record: keyRecord };
  }

  /* ── VALIDATE ─────────────────────────────────────────────── */
  static async validate(rawKey) {
    if (!rawKey) return { valid: false, reason: 'no_key' };

    // Format: csk_(live|test|free)_v1_[48 hex chars]
    if (!/^csk_(live|test|free)_v1_[a-f0-9]{48}$/.test(rawKey)) {
      return { valid: false, reason: 'invalid_format' };
    }

    const db      = getDB();
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const record  = await db.collection('api_keys').findOne({ keyHash, status: 'active' });
    if (!record) return { valid: false, reason: 'key_not_found' };

    // Roll daily counter on date change
    const today = new Date().toDateString();
    if (record.todayDate !== today) {
      await db.collection('api_keys').updateOne(
        { keyHash },
        { $set: { todayRequests: 0, todayDate: today } }
      );
      record.todayRequests = 0;
    }

    if (record.dailyLimit !== Number.MAX_SAFE_INTEGER && record.todayRequests >= record.dailyLimit) {
      return { valid: false, reason: 'daily_limit_exceeded', limit: record.dailyLimit, resetAt: 'midnight UTC' };
    }

    return { valid: true, record };
  }

  /* ── RECORD USAGE ─────────────────────────────────────────── */
  static async recordUsage(keyHash, tokens, model, featureId) {
    if (!keyHash) return;
    try {
      const db = getDB();
      await db.collection('api_keys').updateOne(
        { keyHash },
        {
          $inc: { totalRequests: 1, todayRequests: 1, totalTokens: tokens || 0 },
          $set: { lastUsedAt: new Date() },
          $push: {
            recentCalls: {
              $each:  [{ ts: Date.now(), model, featureId, tokens }],
              $slice: -100,
            },
          },
        }
      );
    } catch (_) {}
  }

  /* ── ROTATE ───────────────────────────────────────────────── */
  static async rotate(oldKeyHash, developerId) {
    const db  = getDB();
    const old = await db.collection('api_keys').findOne({ keyHash: oldKeyHash, developerId });
    if (!old) throw new Error('Key not found or not owned by this developer');

    const newKey = await this.create({
      developerId,
      tier:     old.tier,
      name:     old.name + ' (rotated)',
      metadata: old.metadata || {},
    });

    await db.collection('api_keys').updateOne(
      { keyHash: oldKeyHash },
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );

    return newKey;
  }

  /* ── LIST ─────────────────────────────────────────────────── */
  static async listByDeveloper(developerId) {
    const db = getDB();
    return db.collection('api_keys')
      .find({ developerId, status: 'active' })
      .project({ keyHash: 0, recentCalls: 0 })
      .toArray();
  }
}

module.exports = { KeyManager, API_TIERS, MODEL_DISPLAY_NAMES, alertAdmin };
