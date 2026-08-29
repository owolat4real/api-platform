'use strict';
/**
 * Real behavioral tests for middleware/errorContract.js. Run with:
 * node middleware/errorContract.test.js
 *
 * No test framework dependency -- api-platform has none configured
 * (same convention as cql/cql.test.js: plain assert, small custom
 * harness).
 */
const assert = require('assert');
const errorContract = require('./errorContract');
const { applyErrorContract } = errorContract;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✕ ${name}`); console.log(`    ${e.stack || e}`); }
}

function fakeReqRes(id) {
  const req = { id };
  const res = { statusCode: 200, _sent: null };
  res.json = function (body) { res._sent = body; return res; };
  return { req, res };
}

console.log('applyErrorContract (pure function)');

test('absent error field: adds a new error object, already-present fields untouched', () => {
  const body = { code: 'missing_api_key', message: 'API key required' };
  const out = applyErrorContract({ ...body }, 401, 'req_abc123');
  assert.strictEqual(out.code, 'missing_api_key');
  assert.deepStrictEqual(out.error, {
    message: 'API key required',
    code: 'missing_api_key',
    type: 'invalid_request_error',
    requestId: 'req_abc123',
  });
});

test('error already an object (dominant Developer Cloud shape): fills in only missing subfields', () => {
  const body = { error: { code: 'daily_limit_exceeded', message: 'Daily quota exceeded' } };
  const out = applyErrorContract({ error: { ...body.error } }, 429, 'req_xyz789');
  assert.strictEqual(out.error.code, 'daily_limit_exceeded'); // untouched
  assert.strictEqual(out.error.message, 'Daily quota exceeded'); // untouched
  assert.strictEqual(out.error.type, 'rate_limit_error'); // filled in
  assert.strictEqual(out.error.requestId, 'req_xyz789'); // filled in
});

test('cqlRoutes.js divergent {kind,message,step} shape: merged as an object, kind left alone', () => {
  const body = { success: false, error: { kind: 'ParseError', message: 'Unexpected token', step: 1 } };
  const out = applyErrorContract({ success: false, error: { ...body.error } }, 400, 'req_cql1');
  assert.strictEqual(out.error.kind, 'ParseError'); // untouched, not part of the canonical set
  assert.strictEqual(out.error.step, 1); // untouched
  assert.strictEqual(out.error.message, 'Unexpected token'); // untouched
  assert.strictEqual(out.error.code, 'INVALID_REQUEST'); // filled in
  assert.strictEqual(out.error.requestId, 'req_cql1'); // filled in
});

console.log('\nerrorContract() middleware');

test('only acts on statusCode >= 400 -- success responses pass through unchanged', () => {
  const { req, res } = fakeReqRes('req_ok');
  res.statusCode = 200;
  errorContract()(req, res, () => {});
  res.json({ success: true, data: { id: 1 } });
  assert.deepStrictEqual(res._sent, { success: true, data: { id: 1 } });
});

test('enriches a real 401 response shape end-to-end through res.json', () => {
  const { req, res } = fakeReqRes('req_mw401');
  res.statusCode = 401;
  errorContract()(req, res, () => {});
  res.json({ error: { code: 'missing_api_key', message: 'API key required' } });
  assert.strictEqual(res._sent.error.message, 'API key required');
  assert.strictEqual(res._sent.error.requestId, 'req_mw401');
});

test('non-object bodies (e.g. a raw string) are passed through untouched', () => {
  const { req, res } = fakeReqRes('req_string_body');
  res.statusCode = 500;
  errorContract()(req, res, () => {});
  res.json('plain text error');
  assert.strictEqual(res._sent, 'plain text error');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
