'use strict';
/**
 * Preloaded via `node --require` before any test file (or anything a test
 * file requires, e.g. server.js) executes -- forces NODE_ENV=test
 * regardless of what this machine's real .env file says.
 *
 * Real, live-caught gap (2026-09-16, added alongside config/validateEnv.js):
 * this machine's actual local .env has NODE_ENV=production set. dotenv's
 * default `override:false` means a value already present in process.env
 * BEFORE .config() runs is never replaced by the .env file's value -- so
 * setting it here, before server.js (or anything requiring it) is ever
 * loaded, is what makes validateEnv()'s PROD_REQUIRED checks correctly
 * soft-warn instead of hard-crashing a routine local/CI test run. Without
 * this, `node --test server.gracefulShutdown.test.js` (or any file that
 * requires ./server) hard-exits the whole test process the moment
 * config/validateEnv.js sees NODE_ENV=production with a missing/
 * placeholder STRIPE_WEBHOOK_SECRET.
 *
 * Same purpose as cs_fixed's own test/jestSetupEnv.js, adapted to
 * node:test's --require preload hook since this repo has no Jest/
 * setupFiles equivalent.
 */
process.env.NODE_ENV = 'test';
