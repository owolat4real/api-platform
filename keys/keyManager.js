'use strict';
const crypto      = require('crypto');
const nodemailer  = require('nodemailer');
const { getDB }   = require('../db/connection');
const PORTAL_URL  = process.env.PORTAL_URL || 'https://careerstudiomax.com';

/* ── TIER CONFIG ──────────────────────────────────────────────
   Single source of truth for all tier limits and features.    */
const API_TIERS = {
  FREE: {
    name:           'Free',
    price:          0,
    daily_requests: 1000,
    rpm:            10,
    models:         ['cs-haiku'],
    features:       ['basic_career', 'cv_score', 'quick_advice'],
    max_tokens:     300,
    support:        'community',
  },
  PRO: {
    name:           'Pro',
    price:          19,
    daily_requests: 10000,
    rpm:            60,
    models:         ['cs-haiku', 'cs-sonnet'],
    features:       ['all_career', 'cv_optimise', 'cover_letter', 'interview_prep', 'salary_bench'],
    max_tokens:     1500,
    support:        'email',
  },
  PLUS: {
    name:           'Plus',
    price:          49,
    daily_requests: 100000,
    rpm:            200,
    models:         ['cs-haiku', 'cs-sonnet', 'cs-opus'],
    features:       ['all_career', 'all_features', 'batch_processing', 'webhooks', 'custom_system_prompts'],
    max_tokens:     2048,
    support:        'priority_email',
  },
  ENTERPRISE: {
    name:           'Enterprise',
    price:          199,
    daily_requests: Infinity,
    rpm:            1000,
    models:         ['cs-haiku', 'cs-sonnet', 'cs-opus'],
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
      from:    process.env.EMAIL_FROM || 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>',
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
          <p style="color:#888;font-size:12px">CareerStudioMax Developer Cloud — The world's first career intelligence API<br>
          Free tier: 1,000 requests/day forever. <a href="${PORTAL_URL}/pricing" style="color:#6366f1">Upgrade anytime →</a></p>
        </div>`,
    });
  } catch (e) {
    console.warn('[KeyManager] Welcome email skipped:', e.message?.slice(0, 80));
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

module.exports = { KeyManager, API_TIERS };
