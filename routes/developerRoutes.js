'use strict';
const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { KeyManager, API_TIERS, MODEL_DISPLAY_NAMES } = require('../keys/keyManager');
const { getDB } = require('../db/connection');

// Only create stripe if key is configured — avoids startup crash in dev without billing
const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('your-')
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Real gap: these fell back to placeholder strings ('price_starter_monthly'
// etc.) that are not real Stripe price IDs — every /upgrade call would have
// failed with a genuine Stripe "No such price" error the moment a real
// STRIPE_SECRET_KEY made it past the `stripe` null-check above, since
// nothing had ever created PRO/PLUS/ENTERPRISE as real Stripe
// products. Auto-create them on boot (mirrors cs_fixed/routes/payments.js's
// ensureDeveloperStripePrices() pattern) whenever the env vars aren't set.
const STRIPE_PRICE_IDS = {
  PRO:          process.env.STRIPE_PRICE_PRO        || null,
  PLUS:         process.env.STRIPE_PRICE_PLUS       || null,
  ENTERPRISE:   process.env.STRIPE_PRICE_ENTERPRISE || null,
};

async function ensureStripePrices() {
  if (!stripe) return;
  const needed = ['PRO', 'PLUS', 'ENTERPRISE'].filter(t => !STRIPE_PRICE_IDS[t]);
  if (!needed.length) return;
  try {
    for (const t of needed) {
      const cfg = API_TIERS[t];
      const product = await stripe.products.create({ name: `CareerStudioMax Developer Cloud — ${cfg.name}`, description: `CareerStudioMax Developer Cloud ${cfg.name} tier — ${cfg.daily_requests === Infinity ? 'unlimited' : cfg.daily_requests.toLocaleString()} requests/day` });
      const price = await stripe.prices.create({ unit_amount: cfg.price * 100, currency: 'usd', recurring: { interval: 'month' }, product: product.id, nickname: `${cfg.name} Monthly` });
      STRIPE_PRICE_IDS[t] = price.id;
      console.log(`  [Stripe] Created ${t} price: ${price.id}`);
    }
    console.log('  ⚠  Add these to api-platform/.env to stop re-creating them on every restart:');
    needed.forEach(t => console.log(`     STRIPE_PRICE_${t}=${STRIPE_PRICE_IDS[t]}`));
  } catch (e) {
    console.warn('  [Stripe] Could not auto-create prices:', e.message);
  }
}
ensureStripePrices();

/* ── REGISTER ─────────────────────────────────────────────── */
router.post('/register', async (req, res) => {
  const { email, name, company, github_username } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: { code: 'missing_fields', message: 'email and name are required' } });
  }

  const db = getDB();
  const existing = await db.collection('developers').findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ error: { code: 'already_registered', message: 'Email already registered — log in or reset your key' } });
  }

  const developerId = crypto.randomUUID();
  await db.collection('developers').insertOne({
    developerId,
    email:           email.toLowerCase(),
    name,
    company:         company || null,
    github_username: github_username || null,
    tier:            'FREE',
    status:          'active',
    createdAt:       new Date(),
  });

  const { key } = await KeyManager.create({ developerId, tier: 'FREE', name: 'Default Key' });

  res.status(201).json({
    developer_id: developerId,
    api_key:      key,
    tier:         'FREE',
    message:      'Welcome to CareerStudioMax Developer Cloud. Your free key is ready — save it now, shown once only.',
    docs:         'https://careerstudiomax.com/api/docs/quickstart',
    daily_limit:  API_TIERS.FREE.daily_requests,
    models:       API_TIERS.FREE.models.map(m => MODEL_DISPLAY_NAMES[m] || m),
  });
});

// Shared by rotate/delete below — neither route previously checked that the
// caller actually owns the developerId in the URL (no auth at all), so
// anyone who saw/guessed a developerId could revoke or rotate someone
// else's key. Reuses the same X-Api-Key ownership pattern already added to
// /upgrade.
async function _requireOwnKey(req, res) {
  const rawKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!rawKey) { res.status(401).json({ error: { code: 'missing_api_key', message: 'Include your CareerStudioMax API key in the X-Api-Key header' } }); return false; }
  const validation = await KeyManager.validate(rawKey);
  if (!validation.valid) { res.status(401).json({ error: { code: validation.reason, message: 'Invalid or expired API key' } }); return false; }
  if (validation.record.developerId !== req.params.developerId) { res.status(403).json({ error: { code: 'forbidden', message: 'This API key does not belong to this developer' } }); return false; }
  return true;
}

/* ── LIST KEYS ────────────────────────────────────────────── */
router.get('/keys/:developerId', async (req, res) => {
  const keys = await KeyManager.listByDeveloper(req.params.developerId);
  // Mask key prefix only — never return keyHash
  res.json({ keys: keys.map(k => ({ ...k, prefix: k.prefix + '_v1_...hidden' })) });
});

/* ── ROTATE KEY ───────────────────────────────────────────── */
router.post('/keys/:developerId/rotate', async (req, res) => {
  if (!await _requireOwnKey(req, res)) return;
  const { key_id } = req.body;
  if (!key_id) return res.status(400).json({ error: { code: 'missing_key_id', message: 'key_id is required' } });
  try {
    const db  = getDB();
    const { ObjectId } = require('mongodb');
    const old = await db.collection('api_keys').findOne({ _id: new ObjectId(key_id), developerId: req.params.developerId });
    if (!old) return res.status(404).json({ error: { code: 'key_not_found', message: 'Key not found or not owned by this developer' } });

    const { key } = await KeyManager.rotate(old.keyHash, req.params.developerId);
    res.json({ new_api_key: key, message: 'Old key revoked. Save your new key — shown once only.' });
  } catch (e) {
    res.status(404).json({ error: { code: 'key_not_found', message: e.message } });
  }
});

/* ── REVOKE KEY ───────────────────────────────────────────── */
router.delete('/keys/:developerId/:keyId', async (req, res) => {
  if (!await _requireOwnKey(req, res)) return;
  const db = getDB();
  const { ObjectId } = require('mongodb');
  let objectId;
  try { objectId = new ObjectId(req.params.keyId); }
  catch { return res.status(400).json({ error: { code: 'invalid_key_id', message: 'Invalid key id' } }); }

  const result = await db.collection('api_keys').updateOne(
    { _id: objectId, developerId: req.params.developerId },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ error: { code: 'key_not_found', message: 'Key not found or not owned by this developer' } });
  res.json({ status: 'revoked' });
});

// Applies a paid-for tier to the developer + all their active keys — shared
// by both the immediate-success path below and /upgrade/confirm (the path
// taken when the card needed 3D Secure and the DB update had to wait until
// after that confirmation actually succeeded).
async function _applyTierUpgrade(db, developerId, tier, customerId, subscriptionId) {
  const tierConfig = API_TIERS[tier];
  await db.collection('developers').updateOne(
    { developerId },
    { $set: { tier, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId, upgradedAt: new Date() } }
  );
  await db.collection('api_keys').updateMany(
    { developerId, status: 'active' },
    { $set: { tier, dailyLimit: tierConfig.daily_requests === Infinity ? Number.MAX_SAFE_INTEGER : tierConfig.daily_requests, rpm: tierConfig.rpm, maxTokens: tierConfig.max_tokens, models: tierConfig.models, features: tierConfig.features } }
  );
}

/* ── UPGRADE TIER ─────────────────────────────────────────── */
router.post('/upgrade', async (req, res) => {
  const { developer_id, tier, payment_method_id } = req.body;
  const tierConfig = API_TIERS[tier];
  if (!tierConfig || tier === 'FREE') {
    return res.status(400).json({ error: { code: 'invalid_tier', message: `tier must be one of: PRO, PLUS, ENTERPRISE` } });
  }
  if (!payment_method_id) {
    return res.status(400).json({ error: { code: 'missing_payment_method', message: 'payment_method_id is required' } });
  }
  if (!stripe) {
    return res.status(503).json({ error: { code: 'billing_unavailable', message: 'Billing not configured — contact api@careerstudiomax.com' } });
  }
  if (!STRIPE_PRICE_IDS[tier]) {
    return res.status(503).json({ error: { code: 'billing_unavailable', message: 'Pricing is still initialising — try again in a few seconds.' } });
  }

  // Real gap: this endpoint took any developer_id in the request body with
  // no proof the caller owns it — anyone who could guess/see a developer_id
  // could change that account's tier and attach a Stripe subscription to
  // it. Require the same X-Api-Key auth the rest of the dashboard already
  // uses, and confirm the key's own developerId matches the one being
  // upgraded.
  const rawKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!rawKey) {
    return res.status(401).json({ error: { code: 'missing_api_key', message: 'Include your CareerStudioMax API key in the X-Api-Key header' } });
  }
  const validation = await KeyManager.validate(rawKey);
  if (!validation.valid) {
    return res.status(401).json({ error: { code: validation.reason, message: 'Invalid or expired API key' } });
  }
  if (validation.record.developerId !== developer_id) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'This API key does not belong to the developer_id being upgraded' } });
  }

  try {
    const db = getDB();
    const developer = await db.collection('developers').findOne({ developerId: developer_id });
    if (!developer) {
      return res.status(404).json({ error: { code: 'developer_not_found', message: 'No developer account found for this ID' } });
    }

    // Reuse an existing Stripe customer for this developer if one already
    // exists (e.g. a prior upgrade or a previous incomplete attempt)
    // instead of creating a fresh one every call.
    let customerId = developer.stripeCustomerId;
    if (customerId) {
      await stripe.paymentMethods.attach(payment_method_id, { customer: customerId }).catch(() => {});
    } else {
      const customer = await stripe.customers.create({ email: developer.email, metadata: { developer_id } });
      customerId = customer.id;
      await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    }
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: payment_method_id } });

    // payment_behavior:'default_incomplete' + expanding the payment intent
    // is the correct pattern for cards that need 3D Secure/SCA — creating
    // the subscription does NOT mean the payment succeeded. The previous
    // version reported `status:'upgraded'` unconditionally right after
    // stripe.subscriptions.create(), which would tell a developer their
    // upgrade worked (and the frontend would treat it as done) even when
    // their bank blocked the charge pending authentication.
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items:    [{ price: STRIPE_PRICE_IDS[tier] }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: { developer_id, tier },
    });

    const paymentIntent = subscription.latest_invoice?.payment_intent;

    // Real gap found via live testing: with payment_behavior:'default_incomplete',
    // Stripe does NOT auto-confirm the invoice's PaymentIntent even though a
    // default_payment_method was set on the customer above — it lands in
    // 'requires_confirmation', not 'succeeded', and needs an explicit
    // stripe.confirmCardPayment() call from the client either way. Only
    // 'requires_action' (a real 3DS challenge) was handled below; a normal
    // US test card with no 3DS requirement was hitting the generic
    // "payment failed" branch and getting its subscription cancelled even
    // though nothing had actually been declined.
    if (paymentIntent?.status === 'requires_action' || paymentIntent?.status === 'requires_confirmation') {
      // DB is NOT updated yet. The frontend must call
      // stripe.confirmCardPayment(client_secret) — which resolves
      // immediately with no UI for a card needing no further authentication,
      // or shows the bank's own challenge for one that does — then hit
      // /upgrade/confirm to actually apply the tier once that succeeds.
      return res.json({
        status: 'requires_action',
        client_secret: paymentIntent.client_secret,
        subscription_id: subscription.id,
        customer_id: customerId,
      });
    }

    if (paymentIntent && paymentIntent.status !== 'succeeded') {
      // Genuinely declined/failed — clean up the unpaid subscription so it
      // doesn't sit around retrying against a card that already failed.
      await stripe.subscriptions.cancel(subscription.id).catch(() => {});
      return res.status(402).json({ error: { code: 'payment_failed', message: `Payment ${paymentIntent.status.replace(/_/g, ' ')} — check your card details and try again.` } });
    }

    // No payment intent at all (e.g. a $0 price in test setups) or already
    // succeeded — safe to apply immediately.
    await _applyTierUpgrade(db, developer_id, tier, customerId, subscription.id);
    res.json({ status: 'upgraded', tier, features: tierConfig.features, daily_limit: tierConfig.daily_requests, price: `$${tierConfig.price}/month` });
  } catch (e) {
    console.error('[billing]', e.message);
    res.status(500).json({ error: { code: 'billing_error', message: e.message } });
  }
});

/* ── CONFIRM UPGRADE (after 3D Secure) ───────────────────────
   Called by the frontend once stripe.confirmCardPayment() has resolved
   successfully for a subscription that came back requires_action above. */
router.post('/upgrade/confirm', async (req, res) => {
  const { developer_id, tier, subscription_id } = req.body;
  const tierConfig = API_TIERS[tier];
  if (!tierConfig || tier === 'FREE') {
    return res.status(400).json({ error: { code: 'invalid_tier', message: 'Invalid tier' } });
  }
  if (!stripe) return res.status(503).json({ error: { code: 'billing_unavailable', message: 'Billing not configured' } });

  const rawKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const validation = rawKey ? await KeyManager.validate(rawKey) : { valid: false };
  if (!validation.valid || validation.record.developerId !== developer_id) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'This API key does not belong to the developer_id being upgraded' } });
  }

  try {
    // Re-check with Stripe directly rather than trusting the client's word
    // that confirmCardPayment succeeded — the DB tier change only happens
    // once Stripe itself confirms the subscription is actually paid.
    const subscription = await stripe.subscriptions.retrieve(subscription_id, { expand: ['latest_invoice.payment_intent'] });
    const status = subscription.latest_invoice?.payment_intent?.status;
    if (subscription.status !== 'active' && subscription.status !== 'trialing' && status !== 'succeeded') {
      return res.status(402).json({ error: { code: 'payment_not_confirmed', message: `Subscription is not active yet (status: ${subscription.status})` } });
    }

    const db = getDB();
    await _applyTierUpgrade(db, developer_id, tier, subscription.customer, subscription.id);
    res.json({ status: 'upgraded', tier, features: tierConfig.features, daily_limit: tierConfig.daily_requests, price: `$${tierConfig.price}/month` });
  } catch (e) {
    console.error('[billing confirm]', e.message);
    res.status(500).json({ error: { code: 'billing_error', message: e.message } });
  }
});

/* ── USAGE STATS ──────────────────────────────────────────── */
// dashboard.html uses this as its sign-in check (a 200 means the API key is
// valid for this developerId) — it previously didn't actually check the
// X-Api-Key header at all, meaning anyone who knew/guessed a developerId
// (a UUID returned from /register and used in dashboard URLs) could pull
// another developer's usage stats. Now that this response also carries the
// developer's name/email (see below), that gap would leak real PII, so it
// gets the same ownership check as /upgrade and the key rotate/delete routes.
router.get('/usage/:developerId', async (req, res) => {
  if (!await _requireOwnKey(req, res)) return;
  const db   = getDB();
  const keys = await db.collection('api_keys').find({ developerId: req.params.developerId }).toArray();
  if (!keys.length) return res.status(404).json({ error: { code: 'not_found', message: 'Developer not found' } });

  const developer = await db.collection('developers').findOne({ developerId: req.params.developerId });

  const stats = keys.reduce((acc, k) => ({
    total_requests: acc.total_requests + (k.totalRequests || 0),
    today_requests: acc.today_requests + (k.todayRequests || 0),
    total_tokens:   acc.total_tokens   + (k.totalTokens   || 0),
  }), { total_requests: 0, today_requests: 0, total_tokens: 0 });

  const activeKey  = keys.find(k => k.status === 'active') || keys[0];
  const dailyLimit = activeKey?.dailyLimit === Number.MAX_SAFE_INTEGER ? 'unlimited' : activeKey?.dailyLimit;

  res.json({
    ...stats,
    developer:   developer ? { name: developer.name, email: developer.email } : null,
    rpm_limit:   activeKey?.rpm ?? null,
    keys:        keys.filter(k => k.status === 'active').map(k => ({
      _id:            k._id,
      name:           k.name,
      prefix:         k.prefix + '_v1_...hidden',
      createdAt:      k.createdAt,
      totalRequests:  k.totalRequests,
    })),
    tier:        activeKey?.tier    || 'FREE',
    daily_limit: dailyLimit,
    remaining:   dailyLimit === 'unlimited' ? 'unlimited' : Math.max(0, dailyLimit - stats.today_requests),
    reset_at:    'midnight UTC',
    recent_calls: (activeKey?.recentCalls || []).slice(-10).map(c => ({
      ...c,
      model: MODEL_DISPLAY_NAMES[c.model] || c.model,
    })),
  });
});

/* ── TIERS INFO (public) ──────────────────────────────────── */
router.get('/tiers', (req, res) => {
  const tiers = Object.entries(API_TIERS).map(([id, t]) => ({
    id,
    name:           t.name,
    price:          t.price,
    price_monthly:  t.price === 0 ? 'Free forever' : `$${t.price}/month`,
    daily_requests: t.daily_requests === Infinity ? 'Unlimited' : t.daily_requests.toLocaleString(),
    rpm:            t.rpm,
    models:         t.models.map(m => MODEL_DISPLAY_NAMES[m] || m),
    features:       t.features,
    support:        t.support,
  }));
  res.json({ tiers });
});

/* ── STRIPE CONFIG (public) ──────────────────────────────────
   Publishable keys are meant to be public, but served dynamically from
   the server's own env rather than hardcoded into a static HTML file. */
router.get('/stripe-config', (req, res) => {
  res.json({
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    billing_enabled: !!stripe,
  });
});

module.exports = router;
