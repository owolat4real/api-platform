'use strict';
/**
 * CareerStudioMax Developer Cloud — Environment Validator (2026-09-16,
 * Developer Cloud hardening PASS 3)
 *
 * A prior production-readiness audit found this service had NO env-var
 * validation at all: boot proceeded even with a missing/placeholder
 * Stripe secret or database URI, and the real failure only surfaced the
 * first time a request actually needed it (a checkout call throwing at
 * request time, or /register 500ing on a dead DB connection) instead of
 * being visible and loud at boot.
 *
 * Deliberately NOT a copy of cs_fixed/config/validateEnv.js (read-only
 * reference for the pattern, not the content) -- this service has no
 * JWT/session auth layer of its own (its entire auth model is the raw
 * API key + its SHA-256 hash), doesn't call any AI provider directly
 * (only proxies to careercamp-ai, which already has safe fallback
 * defaults), and has no retired-domain history to guard against. Only
 * what's genuinely applicable to THIS service is kept.
 *
 * `exit` is injectable (defaults to the real process.exit) purely so
 * tests can assert on the missing/warnings result without actually
 * killing the test runner -- mirrors the same injectable-dependency
 * pattern server.js's createShutdownHandler already uses.
 */

// Hard-required ONLY in production. Note this validates that the
// CONFIGURATION itself is present and not an obvious placeholder -- it
// does not change db/connection.js's existing, deliberate tolerance of a
// transient connection failure at runtime (server.js's boot() already
// logs a warning and keeps serving static routes if Mongo is briefly
// unreachable; that resilience choice is untouched here).
const PROD_REQUIRED = [
  { key: 'MONGODB_URI', feature: 'the developer/key/usage database' },
  { key: 'STRIPE_SECRET_KEY', feature: 'payment processing (paid tier upgrades)' },
  { key: 'STRIPE_WEBHOOK_SECRET', feature: 'Stripe webhook signature verification (routes/stripeWebhook.js)' },
];

// Soft warnings only -- every one of these already has a safe fallback
// or graceful-degradation path elsewhere in the existing code (never
// made mandatory here just because a stricter check would be easy to
// add; see each comment for exactly where the existing fallback lives).
const OPTIONAL = [
  { key: 'STRIPE_PUBLISHABLE_KEY', feature: 'client-side Stripe.js checkout' },
  { key: 'STRIPE_PRICE_PRO', feature: 'PRO tier pricing (auto-created at boot by developerRoutes.js\'s ensureStripePrices() if unset)' },
  { key: 'STRIPE_PRICE_PLUS', feature: 'PLUS tier pricing (auto-created at boot if unset)' },
  { key: 'STRIPE_PRICE_ENTERPRISE', feature: 'ENTERPRISE tier pricing (auto-created at boot if unset)' },
  { key: 'SMTP_HOST', feature: 'developer welcome/admin-alert emails (keys/keyManager.js already no-ops without it)' },
  { key: 'SMTP_USER', feature: 'developer welcome/admin-alert emails' },
  { key: 'SMTP_PASS', feature: 'developer welcome/admin-alert emails' },
  { key: 'CAREERCAMP_URL', feature: 'the internal CareerCamp AI proxy (proxy/campProxy.js already falls back to http://localhost:3002)' },
  { key: 'CS_TRANSFORMER_API_KEY', feature: 'authenticating to the internal CareerCamp AI proxy (already falls back to an empty string)' },
  { key: 'ALLOWED_ORIGINS', feature: 'browser CORS allowlist (server.js already falls back to *)' },
];

function _isPlaceholder(val) {
  return !val || val.trim() === '' || val.includes('your-');
}

/**
 * @param {{exit?: (code:number)=>void}} [opts]
 * @returns {{missing: string[], warnings: string[]}}
 */
function validateEnv({ exit = (code) => process.exit(code) } = {}) {
  const missing = [];
  const warnings = [];

  PROD_REQUIRED.forEach(({ key, feature }) => {
    if (!_isPlaceholder(process.env[key])) return;
    if (process.env.NODE_ENV === 'production') {
      missing.push(`${key} (required in production — ${feature})`);
    } else {
      warnings.push(`${key} not set — ${feature} will be unavailable`);
    }
  });

  if (process.env.MONGODB_URI && !_isPlaceholder(process.env.MONGODB_URI) && !process.env.MONGODB_URI.startsWith('mongodb')) {
    missing.push('MONGODB_URI (invalid format — must start with mongodb:// or mongodb+srv://)');
  }

  OPTIONAL.forEach(({ key, feature }) => {
    if (_isPlaceholder(process.env[key])) warnings.push(`${key} not set — ${feature}`);
  });

  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
    warnings.push('NODE_ENV not set — defaulting to development');
  }
  if (!process.env.PORT) process.env.PORT = '3005';

  // Never print an actual secret VALUE anywhere below -- only key names
  // and feature descriptions.
  if (warnings.length && process.env.NODE_ENV !== 'test') {
    console.warn('\n⚠  ENV WARNINGS (non-fatal):');
    warnings.forEach((w) => console.warn('   •', w));
    console.warn('');
  }

  if (missing.length) {
    console.error('\n❌  MISSING/INVALID REQUIRED ENV VARS — server cannot start:\n');
    missing.forEach((k) => console.error('   MISSING:', k));
    console.error('\nSet these in Render\'s dashboard (Environment tab) or your local .env, then restart.\n');
    exit(1);
  } else if (process.env.NODE_ENV !== 'test') {
    console.log('✅ Environment validated');
  }

  return { missing, warnings };
}

module.exports = validateEnv;
// Exposed for scripts/checkEnvDocumentation.js (the CI gate that confirms
// every one of these has a matching entry in render.yaml) -- same
// attach-extra-properties-to-the-exported-function pattern already used
// elsewhere in this codebase (routes/developerRoutes.js's router export).
module.exports.PROD_REQUIRED = PROD_REQUIRED;
module.exports.OPTIONAL = OPTIONAL;
