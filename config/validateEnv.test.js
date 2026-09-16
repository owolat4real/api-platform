'use strict';
/**
 * Focused tests for config/validateEnv.js (2026-09-16, Developer Cloud
 * hardening PASS 3) -- proves production fails fast and loudly on a
 * genuinely missing/placeholder mandatory credential, while development/
 * test stay fully usable without any real production secrets, and no
 * secret VALUE is ever printed.
 *
 * `exit` is injected as a plain function that records it was called
 * rather than actually calling process.exit() -- never terminates the
 * test runner.
 *
 * Run: node --require ../test/setupTestEnv.js --test config/validateEnv.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['NODE_ENV', 'MONGODB_URI', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PORT'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function loadFresh() {
  delete require.cache[require.resolve('./validateEnv')];
  return require('./validateEnv');
}

test('production with all mandatory credentials present: no missing entries, exit never called', () => {
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://real-cluster/careerlm_api',
    STRIPE_SECRET_KEY: 'sk_live_realkeyvalue',
    STRIPE_WEBHOOK_SECRET: 'whsec_realsecretvalue',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.deepEqual(result.missing, []);
    assert.equal(exitCode, null, 'exit must never be called when everything mandatory is configured');
  });
});

test('production missing STRIPE_WEBHOOK_SECRET: exit(1) is called and the specific key is reported', () => {
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://real-cluster/careerlm_api',
    STRIPE_SECRET_KEY: 'sk_live_realkeyvalue',
    STRIPE_WEBHOOK_SECRET: '',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, 1);
    assert.ok(result.missing.some((m) => m.startsWith('STRIPE_WEBHOOK_SECRET')));
  });
});

test('production with an obviously-placeholder secret (contains "your-") is treated as missing', () => {
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://real-cluster/careerlm_api',
    STRIPE_SECRET_KEY: 'sk_test_your-stripe-key-here',
    STRIPE_WEBHOOK_SECRET: 'whsec_realsecretvalue',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, 1);
    assert.ok(result.missing.some((m) => m.startsWith('STRIPE_SECRET_KEY')));
  });
});

test('production with a malformed MONGODB_URI (does not start with mongodb) fails', () => {
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'postgres://not-actually-mongo',
    STRIPE_SECRET_KEY: 'sk_live_realkeyvalue',
    STRIPE_WEBHOOK_SECRET: 'whsec_realsecretvalue',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, 1);
    assert.ok(result.missing.some((m) => m.startsWith('MONGODB_URI')));
  });
});

test('development with NO mandatory secrets set: usable, only soft warnings, exit never called', () => {
  withEnv({
    NODE_ENV: 'development',
    MONGODB_URI: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, null, 'development must remain usable without any real production secret');
    assert.ok(result.warnings.length > 0, 'missing mandatory-in-prod vars should still surface as warnings, just not fatal ones');
  });
});

test('test environment with NO mandatory secrets set: usable, exit never called', () => {
  withEnv({
    NODE_ENV: 'test',
    MONGODB_URI: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
  }, () => {
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, null, 'test environment must remain usable without any real production secret');
  });
});

test('an unset NODE_ENV defaults to development in-process and does not crash', () => {
  withEnv({ NODE_ENV: '', MONGODB_URI: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }, () => {
    delete process.env.NODE_ENV;
    const validateEnv = loadFresh();
    let exitCode = null;
    validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(process.env.NODE_ENV, 'development');
    assert.equal(exitCode, null);
  });
});

test('optional providers (SMTP, CareerCamp proxy, price IDs) are never reported as missing/fatal in production', () => {
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://real-cluster/careerlm_api',
    STRIPE_SECRET_KEY: 'sk_live_realkeyvalue',
    STRIPE_WEBHOOK_SECRET: 'whsec_realsecretvalue',
  }, () => {
    delete process.env.SMTP_HOST;
    delete process.env.CAREERCAMP_URL;
    delete process.env.STRIPE_PRICE_PRO;
    const validateEnv = loadFresh();
    let exitCode = null;
    const result = validateEnv({ exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, null, 'optional providers must never become mandatory');
    assert.ok(!result.missing.some((m) => /SMTP_HOST|CAREERCAMP_URL|STRIPE_PRICE_PRO/.test(m)));
  });
});

test('never prints an actual secret value -- only key names/feature descriptions appear in missing/warnings', () => {
  const REAL_SECRET = 'SYNTHETIC_SECRET_VALUE_THAT_MUST_NEVER_APPEAR';
  withEnv({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://real-cluster/careerlm_api',
    STRIPE_SECRET_KEY: REAL_SECRET,
    STRIPE_WEBHOOK_SECRET: '', // force a missing entry alongside a REAL, present secret elsewhere
  }, () => {
    const validateEnv = loadFresh();
    const result = validateEnv({ exit: () => {} });
    const allText = JSON.stringify(result);
    assert.ok(!allText.includes(REAL_SECRET), 'a configured secret\'s real value must never appear in the validator\'s own output, even when reporting an unrelated missing var');
  });
});
