'use strict';
/**
 * Structural regression tests for .github/workflows/ci.yml and
 * render.yaml's deploy-safety properties (2026-09-16, Developer Cloud
 * hardening PASS 3). Plain text/regex assertions against the real
 * committed files -- not a real YAML parse (no YAML parser dependency
 * exists in this repo) -- proving the actual safety properties this
 * whole pass exists to establish, so a future edit that accidentally
 * removes the `needs:` gate, adds a hardcoded credential, or flips
 * autoDeploy back on gets caught here rather than discovered live.
 *
 * Run: node --test .github/ciWorkflowStructure.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, 'workflows', 'ci.yml');
const renderYamlPath = path.join(__dirname, '..', 'render.yaml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const renderYaml = fs.readFileSync(renderYamlPath, 'utf8');

test('the deploy job depends on the test job succeeding first', () => {
  const deployJobMatch = workflow.match(/deploy:\n([\s\S]*)/);
  assert.ok(deployJobMatch, 'a deploy: job must exist');
  assert.match(deployJobMatch[1], /needs:\s*\[test\]/, 'deploy must declare needs: [test]');
});

test('the deploy job only runs on a real push to master, never on a pull_request', () => {
  const deployJobMatch = workflow.match(/deploy:\n([\s\S]*)/);
  assert.match(deployJobMatch[1], /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);
});

test('the deploy credential is referenced only through GitHub Actions secret storage, never hardcoded', () => {
  assert.match(workflow, /secrets\.RENDER_DEPLOY_HOOK_URL/, 'must reference the secret by name');
  // No literal Render deploy-hook-shaped URL (which embeds its own auth
  // token) anywhere in the file.
  assert.doesNotMatch(workflow, /api\.render\.com\/deploy\/srv-[a-zA-Z0-9]+\?key=/, 'a real, usable deploy hook URL must never be hardcoded in the workflow');
});

test('no Render API key, Stripe key, or Mongo credential is hardcoded anywhere in the workflow file', () => {
  assert.doesNotMatch(workflow, /rnd_[a-zA-Z0-9]{20,}/, 'a real Render API key must never appear');
  assert.doesNotMatch(workflow, /sk_live_[a-zA-Z0-9]{10,}/, 'a real live Stripe secret key must never appear');
  assert.doesNotMatch(workflow, /whsec_[a-zA-Z0-9]{20,}/, 'a real Stripe webhook secret must never appear');
  assert.doesNotMatch(workflow, /mongodb\+srv:\/\/[^\s]*:[^\s@]*@/, 'a real credentialed MongoDB Atlas URI must never appear (only the disposable local CI container URI is expected)');
});

test('the test job runs the env-documentation gate and the full test suite', () => {
  assert.match(workflow, /node scripts\/checkEnvDocumentation\.js/);
  assert.match(workflow, /npm test/);
});

test('the smoke-test job never configures a real Stripe secret (billing routes must gracefully 503 instead)', () => {
  const testJobSection = workflow.split('deploy:')[0];
  assert.doesNotMatch(testJobSection, /STRIPE_SECRET_KEY:\s*\S/, 'no Stripe secret should be set for ordinary CI');
});

test('render.yaml: autoDeploy is false (the whole point of this pass)', () => {
  assert.match(renderYaml, /autoDeploy:\s*false/);
});

test('render.yaml: every PROD_REQUIRED-shaped secret key is sync:false, never a literal value', () => {
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MONGODB_URI']) {
    const m = renderYaml.match(new RegExp(`-\\s*key:\\s*${key}\\b[\\s\\S]*?\\n(\\s*)(sync:\\s*false|value:.*)`, 'm'));
    assert.ok(m, `${key} must exist in render.yaml`);
    assert.match(m[2], /^sync:\s*false/, `${key} must be sync:false, never a committed value`);
  }
});
