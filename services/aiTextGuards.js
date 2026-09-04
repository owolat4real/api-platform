'use strict';
/* Shared placeholder-detection helpers. Ported into api-platform
   (2026-09-04), byte-identical logic to cs_fixed/services/aiTextGuards.js. */

const _LEGIT_MARKERS = /^(PAUSE_SHORT|PAUSE_MEDIUM|PAUSE_LONG|TONE_WARM|TONE_PROBE|EMPHASIS|\/EMPHASIS|LIVE DATA|ESTIMATED|INFERRED|VERIFIED)$/;
function hasUnresolvedPlaceholder(text) {
  const s = String(text || '');
  if (/\{\{[^}]+\}\}/.test(s)) return true;
  const brackets = s.match(/\[([^\[\]]+)\]/g) || [];
  return brackets.some(b => !_LEGIT_MARKERS.test(b.slice(1, -1)));
}

const _GENERIC_PLACEHOLDER_COMPANY_RE = /\b(?:XYZ|ABC|Acme|Example)\s+(?:Company|Corp(?:oration)?|Inc\.?|Ltd\.?)\b|\bYour\s+Company\b|\bCompany\s+(?:Name|X|Y|Z)\b|\b(?:Company|Employer)\s+A\b/i;
function hasGenericPlaceholderCompany(text) {
  return _GENERIC_PLACEHOLDER_COMPANY_RE.test(String(text || ''));
}

module.exports = { hasUnresolvedPlaceholder, hasGenericPlaceholderCompany };
