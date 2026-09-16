'use strict';
/**
 * CI gate (2026-09-16, Developer Cloud hardening PASS 3): confirms every
 * env var config/validateEnv.js's PROD_REQUIRED list actually enforces at
 * boot also has a matching entry in render.yaml. Catches the case where a
 * new mandatory credential is added to the validator but the person
 * forgets to also register it with Render -- which would make a real
 * production deploy hard-crash on first boot (by design, per
 * validateEnv.js) with no advance warning from CI that it was ever going
 * to happen.
 *
 * Also flags the reverse mistake: a PROD_REQUIRED key given a literal
 * `value:` in render.yaml instead of `sync: false` -- every one of these
 * is a secret and must only ever be set directly in Render's dashboard,
 * never committed as plaintext.
 *
 * Plain text/regex scan, not a real YAML parse -- render.yaml's structure
 * here is simple and flat enough that this is reliable, and it avoids
 * adding a new runtime dependency (no YAML parser is in package.json
 * today) purely for one CI script.
 *
 * Run: node scripts/checkEnvDocumentation.js
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {string} renderYamlText
 * @param {string[]} prodRequiredKeys
 * @returns {{undocumented: string[], leakedAsPlaintext: string[]}}
 */
function checkEnvDocumentation(renderYamlText, prodRequiredKeys) {
  const undocumented = prodRequiredKeys.filter((key) => !new RegExp(`-\\s*key:\\s*${key}\\b`).test(renderYamlText));

  const leakedAsPlaintext = prodRequiredKeys.filter((key) => {
    const m = renderYamlText.match(new RegExp(`-\\s*key:\\s*${key}\\b[\\s\\S]*?\\n(\\s*)(sync:\\s*false|value:.*)`, 'm'));
    return m && /^\s*value:/.test(m[2]);
  });

  return { undocumented, leakedAsPlaintext };
}

function main() {
  const validateEnv = require('../config/validateEnv');
  const renderYamlPath = path.join(__dirname, '..', 'render.yaml');
  const renderYamlText = fs.readFileSync(renderYamlPath, 'utf8');
  const prodRequiredKeys = validateEnv.PROD_REQUIRED.map((e) => e.key);

  const { undocumented, leakedAsPlaintext } = checkEnvDocumentation(renderYamlText, prodRequiredKeys);
  let failed = false;

  if (undocumented.length) {
    failed = true;
    console.error('❌ PROD_REQUIRED env var(s) in config/validateEnv.js with no matching entry in render.yaml:');
    undocumented.forEach((k) => console.error('   -', k));
  }
  if (leakedAsPlaintext.length) {
    failed = true;
    console.error('❌ PROD_REQUIRED secret(s) given a literal "value:" in render.yaml instead of "sync: false" (must only ever be set in Render\'s dashboard):');
    leakedAsPlaintext.forEach((k) => console.error('   -', k));
  }

  if (failed) process.exit(1);
  console.log(`✅ All ${prodRequiredKeys.length} PROD_REQUIRED env var(s) are documented in render.yaml as secrets (sync: false), never plaintext.`);
}

module.exports = checkEnvDocumentation;
if (require.main === module) main();
