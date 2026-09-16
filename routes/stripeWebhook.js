'use strict';
/**
 * DEVELOPER CLOUD — STRIPE WEBHOOK (2026-09-16 hardening pass)
 *
 * Closes a real gap found in a production-readiness audit: this service's
 * only path to a paid tier was the synchronous /upgrade + /upgrade/confirm
 * flow in routes/developerRoutes.js -- no webhook at all, so a renewal
 * failure, a dispute, or a subscription cancelled directly in the Stripe
 * dashboard never reached this service; a developer's tier could silently
 * drift from their real Stripe subscription state indefinitely.
 *
 * Mounted directly in server.js with its own express.raw() middleware,
 * BEFORE the app-wide express.json() call -- stripe.webhooks.constructEvent()
 * needs the exact raw request bytes to verify the HMAC signature; once
 * express.json() has parsed the body into an object, those bytes are gone.
 * See server.js's own comment at that mount point.
 *
 * Ownership rule (never relaxed): every handler below looks the developer
 * up by the Stripe customer id Stripe itself reports on the event object
 * (subscription.customer / invoice.customer) -- never by trusting
 * metadata.developer_id as sole authority. Metadata is used only as a
 * defensive cross-check that must AGREE with the customer-id lookup; a
 * mismatch refuses the event rather than guessing.
 *
 * Entitlement rule (never relaxed): a price id is only ever mapped to a
 * tier via STRIPE_PRICE_IDS -- the exact set of prices this service itself
 * created/configured (routes/developerRoutes.js's ensureStripePrices()).
 * An unrecognised price id grants nothing, regardless of what
 * metadata.tier might claim.
 */
const { getDB } = require('../db/connection');
const { API_TIERS, alertAdmin } = require('../keys/keyManager');
const developerRoutes = require('./developerRoutes');

const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('your-')
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

function _webhookSecretConfigured() {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  return !!s && !s.includes('your-');
}

function _priceIdToTier(priceId) {
  if (!priceId) return null;
  for (const [tier, id] of Object.entries(developerRoutes._STRIPE_PRICE_IDS)) {
    if (id && id === priceId) return tier;
  }
  return null;
}

async function _findDeveloperByCustomerId(db, customerId) {
  if (!customerId) return null;
  return db.collection('developers').findOne({ stripeCustomerId: customerId });
}

// Same field set /upgrade's _applyTierUpgrade already writes to
// developers/api_keys -- reused verbatim below via developerRoutes.
// _applyTierUpgrade, so entitlement enforcement/quota checks/the
// dashboard (all of which read those exact fields) never see a
// webhook-vs-API divergence.
async function _downgradeToFree(db, developerId) {
  const free = API_TIERS.FREE;
  await db.collection('developers').updateOne(
    { developerId },
    { $set: { tier: 'FREE', subscriptionStatus: 'canceled', downgradedAt: new Date() } }
  );
  // Preserve existing API keys -- a cancelled subscription downgrades
  // entitlements, it does not delete the developer's account/keys. Only
  // the tier/limit fields on each active key change, same as any other
  // tier transition.
  await db.collection('api_keys').updateMany(
    { developerId, status: 'active' },
    { $set: {
      tier: 'FREE',
      dailyLimit: free.daily_requests === Infinity ? Number.MAX_SAFE_INTEGER : free.daily_requests,
      rpm: free.rpm, maxTokens: free.max_tokens, models: free.models, features: free.features,
    } }
  );
}

async function _syncSubscription(db, subscription) {
  const developer = await _findDeveloperByCustomerId(db, subscription.customer);
  if (!developer) {
    console.warn('[stripe-webhook] subscription event for unrecognised customer, ignoring:', subscription.customer);
    return;
  }

  const metaDeveloperId = subscription.metadata?.developer_id;
  if (metaDeveloperId && metaDeveloperId !== developer.developerId) {
    console.error('[stripe-webhook] metadata.developer_id does not match the developer owning this Stripe customer -- refusing to apply', { customer: subscription.customer });
    return;
  }

  const status = subscription.status;
  if (status === 'active' || status === 'trialing') {
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const tier = _priceIdToTier(priceId);
    if (!tier) {
      console.error('[stripe-webhook] subscription price is not a recognised Developer Cloud tier -- refusing to grant any entitlement', { customer: subscription.customer, priceId });
      return;
    }
    await developerRoutes._applyTierUpgrade(db, developer.developerId, tier, subscription.customer, subscription.id);
    await db.collection('developers').updateOne({ developerId: developer.developerId }, { $set: { subscriptionStatus: status } });
  } else if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') {
    // Do not touch tier/keys on a payment blip -- Stripe's own dunning
    // retries happen before a subscription actually reaches 'canceled'
    // (customer.subscription.deleted, handled separately below). Just
    // record the real status.
    await db.collection('developers').updateOne({ developerId: developer.developerId }, { $set: { subscriptionStatus: status } });
  } else if (status === 'canceled' || status === 'incomplete_expired') {
    await _downgradeToFree(db, developer.developerId);
  }
}

async function _handleSubscriptionDeleted(db, subscription) {
  const developer = await _findDeveloperByCustomerId(db, subscription.customer);
  if (!developer) return;
  // Guard against downgrading a developer who has since moved to a
  // different, still-active subscription -- only act if this deleted
  // subscription is actually the one on record.
  if (developer.stripeSubscriptionId && developer.stripeSubscriptionId !== subscription.id) return;
  await _downgradeToFree(db, developer.developerId);
}

async function _handleInvoicePaid(db, invoice) {
  const developer = await _findDeveloperByCustomerId(db, invoice.customer);
  if (!developer) return;
  await db.collection('developers').updateOne({ developerId: developer.developerId }, { $set: { subscriptionStatus: 'active', lastInvoicePaidAt: new Date() } });
}

async function _handleInvoicePaymentFailed(db, invoice) {
  const developer = await _findDeveloperByCustomerId(db, invoice.customer);
  if (!developer) return;
  // "Don't nuke access on a payment blip" -- same principle as the main
  // platform's own Stripe handling (cs_fixed/routes/payments.js, used
  // read-only as a reference here). Record the real status and alert
  // admin; the actual downgrade only happens if/when Stripe later fires
  // customer.subscription.deleted after its own dunning retries are
  // exhausted.
  await db.collection('developers').updateOne({ developerId: developer.developerId }, { $set: { subscriptionStatus: 'past_due', lastInvoiceFailedAt: new Date() } });
  alertAdmin(
    `Developer Cloud payment failed: ${developer.email}`,
    `Developer ID: ${developer.developerId}\nTier: ${developer.tier}\nInvoice: ${invoice.id}`,
  ).catch(() => {});
}

async function _processEvent(db, event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // This service's real upgrade flow (/upgrade, /upgrade/confirm)
      // creates subscriptions directly rather than via a Stripe Checkout
      // Session, so this is unlikely to fire today -- handled defensively
      // in case Checkout is ever wired in, following the same
      // customer-id-first ownership rule as every handler above.
      if (session.mode !== 'subscription' || !session.subscription) return;
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await _syncSubscription(db, subscription);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await _syncSubscription(db, event.data.object);
      return;
    case 'customer.subscription.deleted':
      await _handleSubscriptionDeleted(db, event.data.object);
      return;
    case 'invoice.paid':
      await _handleInvoicePaid(db, event.data.object);
      return;
    case 'invoice.payment_failed':
      await _handleInvoicePaymentFailed(db, event.data.object);
      return;
    default:
      // Unrecognised/irrelevant event type -- acknowledge without
      // mutating anything. Stripe retries any event whose webhook
      // response isn't a 2xx, so silently ignoring types we don't act on
      // (rather than 400ing them) avoids pointless retry storms.
      return;
  }
}

/**
 * Express handler -- expects req.body to be the RAW Buffer (mounted with
 * express.raw({type:'application/json'}) in server.js, before the global
 * express.json()).
 */
async function stripeWebhookHandler(req, res) {
  if (!stripe || !_webhookSecretConfigured()) {
    // Fails closed: with no real signing secret there is no way to verify
    // stripe-signature at all, so nothing gets processed -- in
    // production most of all, but this applies unconditionally since
    // verification is genuinely impossible without it in any environment.
    console.error('[stripe-webhook] rejecting: billing or webhook secret not configured');
    return res.status(503).json({ error: { code: 'webhook_not_configured', message: 'Webhook processing is not configured.' } });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: { code: 'missing_signature', message: 'Missing Stripe-Signature header.' } });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Never logs the signature or the webhook secret -- only the
    // (non-sensitive) verification-library error message.
    console.warn('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: { code: 'invalid_signature', message: 'Webhook signature verification failed.' } });
  }

  const db = getDB();
  const events = db.collection('webhook_events');

  // Durable idempotency, same insert-first/unique-index pattern this
  // service's own middleware/idempotency.js already uses for
  // Idempotency-Key requests (see that file's header) -- adapted here to
  // Stripe's own globally-unique event.id instead of a composite key. The
  // unique index (db/connection.js) is what actually makes concurrent
  // duplicate delivery safe: only ONE of two simultaneous inserts for the
  // same event.id can ever succeed.
  try {
    await events.insertOne({ eventId: event.id, type: event.type, status: 'in_progress', createdAt: new Date() });
  } catch (e) {
    if (e.code === 11000) {
      // Already recorded -- either a genuine duplicate delivery of an
      // already-completed event, or a concurrent delivery currently being
      // processed by another request. Either way, never re-run the
      // mutation a second time; just acknowledge so Stripe stops retrying.
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error('[stripe-webhook] could not record event:', e.message);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Could not record webhook event.' } });
  }

  try {
    await _processEvent(db, event);
    await events.updateOne({ eventId: event.id }, { $set: { status: 'completed', completedAt: new Date() } });
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[stripe-webhook] processing failed:', event.id, event.type, e.message);
    // Delete rather than leave stuck at 'in_progress' forever -- lets a
    // genuine Stripe retry (it retries on any non-2xx response) actually
    // reprocess this event instead of being permanently blocked by the
    // unique index against a record that never completed.
    await events.deleteOne({ eventId: event.id }).catch(() => {});
    return res.status(500).json({ error: { code: 'processing_failed', message: 'Could not process webhook event.' } });
  }
}

module.exports = stripeWebhookHandler;
// Exposed for tests only -- exercising the sync/downgrade logic directly
// without needing a full signed Stripe payload for every case.
module.exports._syncSubscription = _syncSubscription;
module.exports._handleSubscriptionDeleted = _handleSubscriptionDeleted;
module.exports._handleInvoicePaid = _handleInvoicePaid;
module.exports._handleInvoicePaymentFailed = _handleInvoicePaymentFailed;
module.exports._priceIdToTier = _priceIdToTier;
