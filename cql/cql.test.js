'use strict';
/**
 * CQL test suite. Run with: node cql/cql.test.js
 *
 * No test framework dependency was added — api-platform has none configured
 * and this suite is small enough not to need one. Split the same way
 * cs_fixed's own CI does: fast/pure tests that always run, and one live
 * integration test that needs a running server + real API key + real AI
 * backend, which SKIPS (not fails) when that's not available rather than
 * pretending it passed.
 */
const assert = require('assert');
const { parse, CQLSyntaxError } = require('./parser');
const { execute, evaluateWhen } = require('./interpreter');
const { CQLSemanticError } = require('./errors');

let passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  return fn().then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(e => {
      if (e && e.__skip) { skipped++; console.log(`  - ${name} (skipped: ${e.message})`); return; }
      failed++; console.log(`  ✕ ${name}`); console.log(`    ${e.stack || e}`);
    });
}
function skip(reason) { const e = new Error(reason); e.__skip = true; throw e; }

async function run() {
  console.log('\nParser — single-verb query (salary)');
  await test('parses salary(...) with positional + named args', async () => {
    const ast = parse('salary("Data Engineer", country: "NG", city: "Lagos", currency: "NGN")');
    assert.strictEqual(ast.name, 'salary');
    assert.strictEqual(ast.positional.value, 'Data Engineer');
    assert.strictEqual(ast.args.country.value, 'NG');
    assert.strictEqual(ast.next, null);
  });

  console.log('\nParser — multi-step pipeline');
  await test('parses cv | score | when | cover_letter into a 4-node linked list', async () => {
    const ast = parse(`cv("resume.pdf")
      | score(job: "senior-pm-listing.txt")
      | when(ats_score > 75)
      | cover_letter(mode: "achievement-led")`);
    assert.strictEqual(ast.name, 'cv');
    assert.strictEqual(ast.next.name, 'score');
    assert.strictEqual(ast.next.next.name, 'when');
    assert.strictEqual(ast.next.next.positional.type, 'condition');
    assert.strictEqual(ast.next.next.positional.left, 'ats_score');
    assert.strictEqual(ast.next.next.positional.op, '>');
    assert.strictEqual(ast.next.next.positional.right.value, 75);
    assert.strictEqual(ast.next.next.next.name, 'cover_letter');
    assert.strictEqual(ast.next.next.next.next, null);
  });

  console.log('\nParser — malformed query');
  await test('a dangling colon with no value throws CQLSyntaxError with a location', async () => {
    assert.throws(() => parse('cv("resume.pdf") | score(job: )'), (e) => {
      assert.ok(e instanceof CQLSyntaxError);
      assert.strictEqual(e.kind, 'syntax_error');
      assert.ok(e.location && e.location.start && typeof e.location.start.line === 'number');
      return true;
    });
  });

  console.log('\nInterpreter — when() guard, both outcomes');
  await test('when() passes when the condition is true', async () => {
    const passed = evaluateWhen({ positional: { type: 'condition', left: 'ats_score', op: '>', right: { value: 75 } } }, { ats_score: 87 });
    assert.strictEqual(passed, true);
  });
  await test('when() fails when the condition is false', async () => {
    const passed = evaluateWhen({ positional: { type: 'condition', left: 'ats_score', op: '>', right: { value: 75 } } }, { ats_score: 60 });
    assert.strictEqual(passed, false);
  });
  await test('when() referring to an undefined context var is a semantic error', async () => {
    assert.throws(() => evaluateWhen({ positional: { type: 'condition', left: 'nope', op: '>', right: { value: 1 } } }, {}), CQLSemanticError);
  });

  console.log('\nInterpreter — semantic errors (no network needed, fail before any HTTP call)');
  await test('an unknown verb (e.g. the dropped graph()) is a clear semantic error, not a crash', async () => {
    const ast = parse('cv("resume.pdf") | graph()');
    await assert.rejects(() => execute(ast, 'csk_free_v1_test'), (e) => {
      assert.ok(e instanceof CQLSemanticError);
      assert.match(e.message, /unknown verb or noun "graph"/);
      return true;
    });
  });
  await test('an unrecognised noun (e.g. the dropped candidate()) fails fast, before graph() is even reached', async () => {
    const ast = parse('candidate("jane@example.com") | graph()');
    await assert.rejects(() => execute(ast, 'csk_free_v1_test'), (e) => {
      assert.ok(e instanceof CQLSemanticError);
      assert.match(e.message, /unknown verb or noun "candidate"/);
      return true;
    });
  });
  await test('a bare identifier used as a value is a clear semantic error, not silently accepted', async () => {
    // Deliberately uses interview_questions (no prior noun needed) so this
    // fails on the identifier itself, not on a missing-cv_text check first.
    const ast = parse('interview_questions(role: senior_pm)');
    await assert.rejects(() => execute(ast, 'csk_free_v1_test'), (e) => {
      assert.ok(e instanceof CQLSemanticError);
      assert.match(e.message, /"senior_pm" is not a recognised value/);
      return true;
    });
  });
  await test('a verb needing cv_text with no preceding cv(...) noun is a clear semantic error', async () => {
    const ast = parse('score(job: "some listing")');
    await assert.rejects(() => execute(ast, 'csk_free_v1_test'), (e) => {
      assert.ok(e instanceof CQLSemanticError);
      assert.match(e.message, /needs "cv_text"/);
      return true;
    });
  });

  console.log('\nInterpreter — live end-to-end pipeline (requires a running server + real API key)');
  await test('cv | score | when | cover_letter runs against the real endpoints', async () => {
    if (!process.env.CQL_TEST_API_KEY) {
      skip('set CQL_TEST_API_KEY (and run `node server.js`) to exercise this against a live server');
    }
    const ast = parse(`cv("Ada Okonkwo, Senior Engineer, 8 years React/Node...")
      | score(job: "Senior Product Manager, fintech, 5+ years")
      | when(ats_score > 0)
      | cover_letter(mode: "achievement-led")`);
    const result = await execute(ast, process.env.CQL_TEST_API_KEY);
    assert.strictEqual(result.status, 'ok');
    assert.ok(typeof result.context.ats_score === 'number');
    assert.ok(typeof result.context.content === 'string');
  });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed > 0) process.exit(1);
}

run();
