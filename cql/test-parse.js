'use strict';
// Ad-hoc script to demonstrate the parser against the three brief
// example queries, plus a malformed one — run directly with `node
// cql/test-parse.js` from api-platform/. Not the real test suite (that's
// cql/cql.test.js, added once the interpreter lands); this is the
// "show me the parser working" checkpoint before wiring up execution.
const { parse, CQLSyntaxError } = require('./parser');

const examples = [
  `cv("resume.pdf")
     | score(job: "senior-pm-listing.txt")
     | when(ats_score > 75)
     | cover_letter(mode: "achievement-led")`,

  `candidate("jane@example.com")
     | graph()
     | diff(since: "3 months ago")
     | match(job: job_id)
     | explain()`,

  `salary("Data Engineer", country: "NG", city: "Lagos", currency: "NGN")`,
];

const malformed = `cv("resume.pdf") | score(job: )`; // dangling colon, no value

for (const [i, src] of examples.entries()) {
  console.log(`\n--- Example ${i + 1} ---`);
  console.log(src);
  console.log('=>');
  console.log(JSON.stringify(parse(src), null, 2));
}

console.log('\n--- Malformed query ---');
console.log(malformed);
console.log('=>');
try {
  parse(malformed);
  console.log('DID NOT THROW — bug');
} catch (e) {
  if (e instanceof CQLSyntaxError) {
    console.log(`CQLSyntaxError: ${e.message}`);
    console.log('location:', JSON.stringify(e.location));
  } else {
    throw e;
  }
}
