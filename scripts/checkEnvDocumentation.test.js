'use strict';
/**
 * Focused tests for scripts/checkEnvDocumentation.js -- the CI gate
 * proving every PROD_REQUIRED credential is both documented in
 * render.yaml AND never given as plaintext there.
 *
 * Run: node --test scripts/checkEnvDocumentation.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const checkEnvDocumentation = require('./checkEnvDocumentation');

test('a key present with sync: false is fully clean -- neither undocumented nor leaked', () => {
  const yaml = `
      - key: STRIPE_SECRET_KEY
        sync: false
`;
  const { undocumented, leakedAsPlaintext } = checkEnvDocumentation(yaml, ['STRIPE_SECRET_KEY']);
  assert.deepEqual(undocumented, []);
  assert.deepEqual(leakedAsPlaintext, []);
});

test('a key missing from render.yaml entirely is reported as undocumented', () => {
  const yaml = `
      - key: SOME_OTHER_VAR
        sync: false
`;
  const { undocumented } = checkEnvDocumentation(yaml, ['STRIPE_WEBHOOK_SECRET']);
  assert.deepEqual(undocumented, ['STRIPE_WEBHOOK_SECRET']);
});

test('a key given a literal value: instead of sync: false is flagged as leaked, not as undocumented', () => {
  const yaml = `
      - key: MONGODB_URI
        value: mongodb+srv://this-should-never-be-here
`;
  const { undocumented, leakedAsPlaintext } = checkEnvDocumentation(yaml, ['MONGODB_URI']);
  assert.deepEqual(undocumented, []);
  assert.deepEqual(leakedAsPlaintext, ['MONGODB_URI']);
});

test('multiple keys are each checked independently', () => {
  const yaml = `
      - key: STRIPE_SECRET_KEY
        sync: false
      - key: STRIPE_WEBHOOK_SECRET
        value: whsec_this_should_not_be_committed
`;
  const { undocumented, leakedAsPlaintext } = checkEnvDocumentation(yaml, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MONGODB_URI']);
  assert.deepEqual(undocumented, ['MONGODB_URI']);
  assert.deepEqual(leakedAsPlaintext, ['STRIPE_WEBHOOK_SECRET']);
});

test('the REAL render.yaml in this repo passes cleanly for the REAL current PROD_REQUIRED list', () => {
  const fs = require('fs');
  const path = require('path');
  const validateEnv = require('../config/validateEnv');
  const renderYamlText = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  const { undocumented, leakedAsPlaintext } = checkEnvDocumentation(renderYamlText, validateEnv.PROD_REQUIRED.map((e) => e.key));
  assert.deepEqual(undocumented, [], 'every PROD_REQUIRED key must have a render.yaml entry');
  assert.deepEqual(leakedAsPlaintext, [], 'no PROD_REQUIRED key may ever have a literal value: in render.yaml');
});
