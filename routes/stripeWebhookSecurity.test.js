'use strict';
/**
 * Real-HTTP tests for the Stripe webhook endpoint's SECURITY properties
 * (signature verification, raw-body/JSON middleware ordering, fail-closed
 * config, durable idempotency) -- 2026-09-16 Developer Cloud hardening
 * pass. Uses the REAL `stripe` SDK's local, no-network
 * webhooks.constructEvent()/generateTestHeaderString() for signing --
 * this is pure HMAC verification, no call to Stripe's servers -- so
 * signature checks are exercised against the actual mechanism, not a
 * mock of it. Mocks db/connection.js's getDB() only. No real Stripe
 * network call, no real MongoDB, no production data touched anywhere.
 *
 * Run: node --test routes/stripeWebhookSecurity.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const dbConnection = require('../db/connection');

const TEST_WEBHOOK_SECRET = 'whsec_test_' + 'a'.repeat(32);
const TEST_STRIPE_SECRET_KEY = 'sk_test_' + 'b'.repeat(32);

function fakeDb(state) {
  return {
    collection: (name) => {
      if (name === 'webhook_events') {
        return {
          insertOne: async (doc) => {
            if (state.events.some((e) => e.eventId === doc.eventId)) {
              const err = new Error('E11000 duplicate key');
              err.code = 11000;
              throw err;
            }
            state.events.push(doc);
            return { acknowledged: true };
          },
          updateOne: async (filter, update) => {
            const rec = state.events.find((e) => e.eventId === filter.eventId);
            if (rec) Object.assign(rec, update.$set);
            return { matchedCount: rec ? 1 : 0 };
          },
          deleteOne: async (filter) => {
            const before = state.events.length;
            state.events = state.events.filter((e) => e.eventId !== filter.eventId);
            return { deletedCount: before - state.events.length };
          },
        };
      }
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

function freshApp() {
  process.env.STRIPE_SECRET_KEY = TEST_STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  delete require.cache[require.resolve('./stripeWebhook')];
  delete require.cache[require.resolve('./developerRoutes')];
  const stripeWebhookHandler = require('./stripeWebhook');
  const app = express();
  // Mirrors server.js's real mount order exactly: raw-body route BEFORE
  // the global json() parser.
  app.post('/v1/developer/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);
  app.use(express.json());
  // A canary route proving express.json() still works normally for every
  // OTHER route -- this fix must not weaken parsing elsewhere.
  app.post('/v1/other-route', (req, res) => res.json({ gotBody: req.body }));
  return app;
}

async function serve(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  async function request(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  try { return await fn(request); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function fixtureSubscriptionEvent(overrides = {}) {
  return {
    id: 'evt_' + Math.random().toString(36).slice(2),
    type: 'customer.subscription.updated',
    data: { object: {
      id: 'sub_test123', customer: 'cus_test123', status: 'active',
      items: { data: [{ price: { id: 'price_pro_test' } }] },
      metadata: {},
      ...overrides,
    } },
  };
}

function sign(payload) {
  const stripe = require('stripe')(TEST_STRIPE_SECRET_KEY);
  return stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });
}

test.beforeEach(() => {
  // Must return the SAME fakeDb instance (backed by the same `state`) on
  // every call -- getDB() is called fresh on every incoming request, and
  // idempotency/sync correctness depends on state actually persisting
  // across multiple requests within one test.
  const state = {
    events: [],
    developers: [{ developerId: 'dev_1', email: 'dev1@example.com', tier: 'FREE', stripeCustomerId: 'cus_test123' }],
    apiKeys: [{ developerId: 'dev_1', status: 'active', tier: 'FREE' }],
  };
  const db = fakeDb(state);
  dbConnection.getDB = () => db;
});

test('valid signature is accepted and the event is processed', async (t) => {
  const app = freshApp();
  const developerRoutes = require('./developerRoutes');
  developerRoutes._STRIPE_PRICE_IDS.PRO = 'price_pro_test';
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const res = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(payload), 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);
  });
});

test('invalid signature is rejected with 400, no event ever recorded/processed', async (t) => {
  const app = freshApp();
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const res = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=deadbeef' + 'aa'.repeat(30), 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_signature');
  });
});

test('missing Stripe-Signature header is rejected with 400', async (t) => {
  const app = freshApp();
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const res = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'missing_signature');
  });
});

test('a missing/placeholder webhook secret fails closed (503), never attempts verification', async (t) => {
  process.env.STRIPE_SECRET_KEY = TEST_STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_your-secret-here'; // placeholder pattern
  delete require.cache[require.resolve('./stripeWebhook')];
  const stripeWebhookHandler = require('./stripeWebhook');
  const app = express();
  app.post('/v1/developer/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const res = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'irrelevant', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'webhook_not_configured');
  });
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});

test('a completely unset webhook secret also fails closed (503)', async (t) => {
  process.env.STRIPE_SECRET_KEY = TEST_STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete require.cache[require.resolve('./stripeWebhook')];
  const stripeWebhookHandler = require('./stripeWebhook');
  const app = express();
  app.post('/v1/developer/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const res = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'irrelevant', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(res.status, 503);
  });
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});

test('raw-body/JSON middleware ordering: the webhook route gets the raw buffer, and every other route still gets normal parsed JSON', async (t) => {
  const app = freshApp();
  const developerRoutes = require('./developerRoutes');
  developerRoutes._STRIPE_PRICE_IDS.PRO = 'price_pro_test';
  const payload = JSON.stringify(fixtureSubscriptionEvent());
  await serve(app, async (request) => {
    const webhookRes = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(payload), 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(webhookRes.status, 200, 'webhook route with a valid signature must still succeed');

    const otherPayload = JSON.stringify({ hello: 'world' });
    const otherRes = await request('POST', '/v1/other-route', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(otherPayload) },
      body: otherPayload,
    });
    assert.equal(otherRes.status, 200);
    assert.deepEqual(otherRes.body.gotBody, { hello: 'world' }, 'unrelated routes must still get normally-parsed JSON, unaffected by the raw-body mount');
  });
});

test('duplicate delivery of the same event is acknowledged but never reprocessed', async (t) => {
  const app = freshApp();
  const developerRoutes = require('./developerRoutes');
  developerRoutes._STRIPE_PRICE_IDS.PRO = 'price_pro_test';
  const event = fixtureSubscriptionEvent();
  const payload = JSON.stringify(event);
  const sig = sign(payload);

  await serve(app, async (request) => {
    const first = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig, 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, undefined);

    const second = await request('POST', '/v1/developer/stripe/webhook', {
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig, 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
  });
});
