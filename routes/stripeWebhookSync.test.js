'use strict';
/**
 * Direct unit tests for routes/stripeWebhook.js's subscription-sync
 * business logic (ownership verification, price->tier integrity,
 * entitlement synchronization, cancellation/downgrade, failed-payment
 * handling) -- bypasses HTTP/signature verification (covered separately
 * in routes/stripeWebhookSecurity.test.js) to focus purely on: given a
 * real Stripe event payload shape, does this service update the RIGHT
 * developer, with the RIGHT fields, and refuse to act on anything it
 * can't verify.
 *
 * Run: node --test routes/stripeWebhookSync.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dbConnection = require('../db/connection');

function fakeDb(state) {
  return {
    collection: (name) => {
      if (name === 'developers') {
        return {
          findOne: async (filter) => state.developers.find((d) => d.stripeCustomerId === filter.stripeCustomerId) || null,
          updateOne: async (filter, update) => {
            const dev = state.developers.find((d) => d.developerId === filter.developerId);
            if (dev) Object.assign(dev, update.$set);
            return { matchedCount: dev ? 1 : 0 };
          },
        };
      }
      if (name === 'api_keys') {
        return {
          updateMany: async (filter, update) => {
            const matched = state.apiKeys.filter((k) => k.developerId === filter.developerId && (!filter.status || k.status === filter.status));
            matched.forEach((k) => Object.assign(k, update.$set));
            return { matchedCount: matched.length };
          },
        };
      }
      throw new Error(`fakeDb: unexpected collection "${name}"`);
    },
  };
}

function loadFresh() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'b'.repeat(32);
  delete require.cache[require.resolve('./stripeWebhook')];
  delete require.cache[require.resolve('./developerRoutes')];
  const mod = require('./stripeWebhook');
  const developerRoutes = require('./developerRoutes');
  developerRoutes._STRIPE_PRICE_IDS.PRO = 'price_pro_test';
  developerRoutes._STRIPE_PRICE_IDS.PLUS = 'price_plus_test';
  return mod;
}

function baseState() {
  return {
    developers: [{ developerId: 'dev_1', email: 'dev1@example.com', tier: 'FREE', stripeCustomerId: 'cus_1' }],
    apiKeys: [{ developerId: 'dev_1', status: 'active', tier: 'FREE', dailyLimit: 1000 }],
  };
}

test('customer.subscription.updated with a known price applies the matching tier to the developer AND their active keys', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  const db = fakeDb(state);
  await _syncSubscription(db, { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_pro_test' } }] }, metadata: {} });

  assert.equal(state.developers[0].tier, 'PRO');
  assert.equal(state.developers[0].stripeSubscriptionId, 'sub_1');
  assert.equal(state.developers[0].subscriptionStatus, 'active');
  assert.equal(state.apiKeys[0].tier, 'PRO');
});

test('an unknown/unrecognised Stripe customer id is ignored -- no developer exists to mutate', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  const db = fakeDb(state);
  await _syncSubscription(db, { id: 'sub_x', customer: 'cus_does_not_exist', status: 'active', items: { data: [{ price: { id: 'price_pro_test' } }] }, metadata: {} });
  assert.equal(state.developers[0].tier, 'FREE', 'the only real developer in the fixture must be untouched');
});

test('an unrecognised price id grants no entitlement, even though the customer is real and status is active', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  const db = fakeDb(state);
  await _syncSubscription(db, { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_NOT_OURS' } }] }, metadata: {} });
  assert.equal(state.developers[0].tier, 'FREE', 'an arbitrary/unknown price must never grant a tier');
});

test('a metadata.developer_id that disagrees with the customer-id-owning developer is refused, not trusted', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  state.developers.push({ developerId: 'dev_2', email: 'dev2@example.com', tier: 'FREE', stripeCustomerId: 'cus_2' });
  state.apiKeys.push({ developerId: 'dev_2', status: 'active', tier: 'FREE' });
  const db = fakeDb(state);
  // subscription.customer says cus_1 (dev_1's real customer id), but the
  // metadata claims dev_2 -- a forged/stale/mismatched value. Must not
  // upgrade EITHER developer off the strength of that metadata alone.
  await _syncSubscription(db, { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_pro_test' } }] }, metadata: { developer_id: 'dev_2' } });
  assert.equal(state.developers[0].tier, 'FREE');
  assert.equal(state.developers[1].tier, 'FREE');
});

test('a matching metadata.developer_id (the normal, honest case) does not block the real update', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  const db = fakeDb(state);
  await _syncSubscription(db, { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_pro_test' } }] }, metadata: { developer_id: 'dev_1' } });
  assert.equal(state.developers[0].tier, 'PRO');
});

test('a past_due status records the real status but does NOT touch tier or key limits', async () => {
  const { _syncSubscription } = loadFresh();
  const state = baseState();
  state.developers[0].tier = 'PRO';
  state.apiKeys[0].tier = 'PRO';
  const db = fakeDb(state);
  await _syncSubscription(db, { id: 'sub_1', customer: 'cus_1', status: 'past_due', items: { data: [{ price: { id: 'price_pro_test' } }] }, metadata: {} });
  assert.equal(state.developers[0].tier, 'PRO', 'tier must not change on a payment blip');
  assert.equal(state.developers[0].subscriptionStatus, 'past_due');
  assert.equal(state.apiKeys[0].tier, 'PRO', 'existing key limits must be untouched');
});

test('customer.subscription.deleted downgrades to FREE but PRESERVES the existing API key (not deleted)', async () => {
  const { _handleSubscriptionDeleted } = loadFresh();
  const state = baseState();
  state.developers[0].tier = 'PRO';
  state.developers[0].stripeSubscriptionId = 'sub_1';
  state.apiKeys[0].tier = 'PRO';
  const db = fakeDb(state);
  await _handleSubscriptionDeleted(db, { id: 'sub_1', customer: 'cus_1' });

  assert.equal(state.developers[0].tier, 'FREE');
  assert.equal(state.developers[0].subscriptionStatus, 'canceled');
  assert.equal(state.apiKeys.length, 1, 'the key record itself must still exist -- cancellation downgrades entitlements, it does not delete keys');
  assert.equal(state.apiKeys[0].tier, 'FREE');
  assert.equal(state.apiKeys[0].status, 'active', 'the key stays active, just on FREE-tier limits');
});

test('a stale subscription.deleted event (for a subscription the developer has since replaced) does not downgrade the current one', async () => {
  const { _handleSubscriptionDeleted } = loadFresh();
  const state = baseState();
  state.developers[0].tier = 'PLUS';
  state.developers[0].stripeSubscriptionId = 'sub_NEW_current';
  const db = fakeDb(state);
  await _handleSubscriptionDeleted(db, { id: 'sub_OLD_replaced', customer: 'cus_1' });
  assert.equal(state.developers[0].tier, 'PLUS', 'deleting an old, already-replaced subscription must not touch the current active one');
});

test('invoice.paid records subscriptionStatus active and a paid timestamp, no tier mutation', async () => {
  const { _handleInvoicePaid } = loadFresh();
  const state = baseState();
  const db = fakeDb(state);
  await _handleInvoicePaid(db, { id: 'in_1', customer: 'cus_1' });
  assert.equal(state.developers[0].subscriptionStatus, 'active');
  assert.ok(state.developers[0].lastInvoicePaidAt instanceof Date);
});

test('invoice.payment_failed records past_due status but does not touch tier or delete/revoke keys', async () => {
  const { _handleInvoicePaymentFailed } = loadFresh();
  const state = baseState();
  state.developers[0].tier = 'PRO';
  state.apiKeys[0].tier = 'PRO';
  state.apiKeys[0].status = 'active';
  const db = fakeDb(state);
  await _handleInvoicePaymentFailed(db, { id: 'in_2', customer: 'cus_1' });
  assert.equal(state.developers[0].tier, 'PRO', 'a single failed invoice must not immediately destroy entitlements');
  assert.equal(state.developers[0].subscriptionStatus, 'past_due');
  assert.equal(state.apiKeys[0].status, 'active', 'keys must not be revoked on a failed payment');
});

test('_priceIdToTier only recognises this service\'s own configured price ids, case-sensitive exact match', () => {
  const { _priceIdToTier } = loadFresh();
  assert.equal(_priceIdToTier('price_pro_test'), 'PRO');
  assert.equal(_priceIdToTier('price_plus_test'), 'PLUS');
  assert.equal(_priceIdToTier('price_totally_made_up'), null);
  assert.equal(_priceIdToTier(null), null);
  assert.equal(_priceIdToTier(undefined), null);
});
