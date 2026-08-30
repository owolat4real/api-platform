'use strict';
/**
 * Real behavioral tests for services/fabricationGuard.js. Run with:
 * node services/fabricationGuard.test.js
 *
 * No test framework dependency -- same plain-assert convention as
 * middleware/errorContract.test.js and cql/cql.test.js.
 */
const assert = require('assert');
const { checkFabrication } = require('./fabricationGuard');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✕ ${name}`); console.log(`    ${e.stack || e}`); }
}

console.log('checkFabrication');

test('the real live-caught bug: invented metrics with no source, tagged [VERIFIED], are flagged', () => {
  const cv = 'Ada Okonkwo\nBackend Developer at Tech Solutions Ltd (2021-2023)\nSoftware Engineer at Innovate Labs (2023-2026)';
  const jd = 'Backend engineer experienced with Python and FastAPI for our payments infrastructure team.';
  const generated = 'delivering sub-second latency for over 2 million daily transactions [VERIFIED], supporting a 1.8x increase in client integrations [VERIFIED].';
  const result = checkFabrication(generated, [cv, jd, 'Stripe', 'Ada Okonkwo']);
  assert.strictEqual(result.flagged, true);
  assert.ok(result.suspiciousEntities.some(e => e.includes('2m')), 'should flag the invented 2 million figure');
});

test('a real employer name fabricated with no basis in the CV is flagged, but a genuinely sourced one is not', () => {
  const cv = 'John Doe\nSoftware Engineer\nExperience: Senior Developer at Acme Corp (2020-2024)';
  const jd = 'We need a backend engineer experienced with Python and FastAPI for our payments team.';
  const generated = 'At Paystack, I engineered and deployed microservices using Python and FastAPI.';
  // "Paystack" DOES appear in the external-fact source text here, so it's
  // sourced -- this proves the guard distinguishes "mentioned somewhere
  // real" from "invented from nothing", not just "contains this string
  // anywhere in my head". Python/FastAPI are sourced via the JD.
  const result = checkFabrication(generated, [cv, jd, 'Stripe acquired Paystack in 2020', 'Stripe']);
  assert.strictEqual(result.flagged, false, 'Paystack is legitimately sourced from the acquisition fact');

  const resultUnsourced = checkFabrication(generated, [cv, jd, 'Stripe']);
  assert.strictEqual(resultUnsourced.flagged, true, 'Paystack has no source at all here -- must be flagged');
});

test('a company name and job-description terms legitimately woven in are NOT flagged', () => {
  const cv = 'Ada Okonkwo\nBackend Developer at Tech Solutions Ltd (2021-2023)';
  const jd = 'We need a backend engineer for our Payments Infrastructure team at Stripe Connect.';
  const generated = 'I am excited to apply my backend experience to Stripe Connect and your Payments Infrastructure team.';
  const result = checkFabrication(generated, [cv, jd, 'Stripe', 'Ada Okonkwo']);
  assert.strictEqual(result.flagged, false);
});

test('a real number from the CV, reformatted (spelled-out -> symbol), is not mistaken for a new claim', () => {
  const cv = 'Reduced latency by 22 percent while leading a team of 5.';
  const generated = 'Reduced latency by 22% while leading a team of 5.';
  const result = checkFabrication(generated, [cv]);
  assert.strictEqual(result.flagged, false);
});

test('a genuinely different number than anything in source IS flagged', () => {
  const cv = 'Reduced latency by 22 percent.';
  const generated = 'Reduced latency by 45%.';
  const result = checkFabrication(generated, [cv]);
  assert.strictEqual(result.flagged, true);
});

test('bare single-digit numbers (list numbering, small counts) are not treated as claims needing a source', () => {
  const cv = 'Managed a team of 4 engineers.';
  const generated = '1. Led backend development\n2. Owned deployment pipeline\nManaged a team of 4 engineers.';
  const result = checkFabrication(generated, [cv]);
  assert.strictEqual(result.flagged, false);
});

test('a sentence-initial word is never mistaken for a fabricated entity, even when unsourced', () => {
  const cv = 'Software Engineer with backend experience.';
  const jd = 'Looking for someone to join our Platform Engineering team.';
  const generated = 'Excited to bring my Software Engineer background to your Platform Engineering team.';
  const result = checkFabrication(generated, [cv, jd]);
  assert.strictEqual(result.flagged, false);
});

test('a genuinely new multi-word entity name with no source anywhere is flagged (tightened: any one is enough, not just several)', () => {
  const cv = 'Software Engineer.';
  const generated = 'I previously worked at Quantum Dynamics Corp.';
  const result = checkFabrication(generated, [cv]);
  assert.strictEqual(result.flagged, true);
});

test('empty generated text is never flagged (nothing to fabricate)', () => {
  const result = checkFabrication('', ['some source text']);
  assert.strictEqual(result.flagged, false);
  assert.deepStrictEqual(result.suspiciousEntities, []);
});

test('empty/missing source texts are handled without throwing', () => {
  const result = checkFabrication('Some generated text with Acme Corp.', [null, undefined, '']);
  assert.strictEqual(result.flagged, true);
});

test('checkNumbers:false (the /cv/optimise add_metrics case) skips new numbers but still catches a new employer name', () => {
  const cv = 'Reduced latency while working at Tech Solutions Ltd.';
  const withInventedMetricOnly = 'Reduced latency by 30% while working at Tech Solutions Ltd.';
  const numbersOn = checkFabrication(withInventedMetricOnly, [cv]);
  assert.strictEqual(numbersOn.flagged, true, 'default (checkNumbers:true) should catch the invented 30%');
  const numbersOff = checkFabrication(withInventedMetricOnly, [cv], { checkNumbers: false });
  assert.strictEqual(numbersOff.flagged, false, 'checkNumbers:false should let the advertised "add metrics" behavior through');

  const withInventedEmployer = 'Reduced latency by 30% while working at Quantum Dynamics Corp.';
  const stillCatchesEmployer = checkFabrication(withInventedEmployer, [cv], { checkNumbers: false });
  assert.strictEqual(stillCatchesEmployer.flagged, true, 'a fabricated employer name must still be caught even with checkNumbers:false');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
