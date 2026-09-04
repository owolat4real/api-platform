'use strict';
/* ═══════════════════════════════════════════════════════════════
   GENERICITY SCORING FIREWALL — ported into api-platform (2026-09-04)

   Real gap closed: services/fabricationGuard.js checks whether a
   generated name/number traces back to a supplied source document, but
   was only wired into 2 of this platform's 9 real developer-facing
   endpoints (/cv/optimise, /cover-letter/generate). Neither
   fabricationGuard nor anything else here does generic-filler-phrase
   detection, self-contradiction detection, or placeholder-leak
   detection. Since ALL 9 endpoints funnel through the single real
   choke point proxy/campProxy.js#callCareerCamp, hooking genericity
   scoring there once gives real coverage across every endpoint this
   platform serves, not just the 2 fabricationGuard already covers.

   Byte-identical scoring logic to cs_fixed/services/genericityFirewall.js
   (Phase 12 + Phase 12.1 signal expansion), composing services/
   careerAdviceGuard.js and services/aiTextGuards.js (both ported
   alongside this file). No LLM anywhere in this file.

   Deliberately observational (logs only) rather than reusing
   fabricationGuard's stronger retry-then-503 behavior -- that behavior
   is proven for the 2 endpoints that already opted into it, but making
   every one of the other 7 endpoints suddenly capable of a new 503
   failure mode they've never had is a materially bigger, riskier change
   than what was asked for here.
═══════════════════════════════════════════════════════════════ */
const { checkSelfContradiction, checkUnearnedCitation } = require('./careerAdviceGuard');
const { hasUnresolvedPlaceholder, hasGenericPlaceholderCompany } = require('./aiTextGuards');

const GENERIC_PHRASES = [
  /\bin today'?s (competitive )?job market\b/i,
  /\bstay ahead of the curve\b/i,
  /\bleverage your network\b/i,
  /\bmake sure to tailor your resume\b/i,
  /\bthink outside the box\b/i,
  /\bunlock your (full )?potential\b/i,
  /\btake your career to the next level\b/i,
  /\bin conclusion,?\b/i,
  /\bvarious factors\b/i,
  /\bat the end of the day\b/i,
  /\ba wide range of\b/i,
  /\bmany opportunities\b/i,
  /\bcontinuously improve\b/i,
  /\bfast[- ]paced (work )?environment\b/i,
  /\bhit the ground running\b/i,
  /\bwear many hats\b/i,
  /\bgo the extra mile\b/i,
  /\bpassionate about (helping|making a difference)\b/i,
  /\bcrucial role in (today'?s|the modern)\b/i,
  /\bever[- ]evolving (landscape|industry|market)\b/i,
  /\bkey takeaway[s]?\b/i,
  /\bto sum up,?\b/i,
  /\boverall,? (it is|this is) (important|essential|crucial)\b/i,
  /\bplays? a (vital|significant|key) role\b/i,
  /\bin order to succeed\b/i,
  /\bit'?s (important|essential|crucial) to (note|remember|understand)\b/i,
  /\bwhether you'?re a (beginner|seasoned|experienced)\b/i,
  /\bwith that (being )?said\b/i,
  /\bhard work and dedication\b/i,
  /\bnavigate the (complex|ever-changing)\b/i,
  /\bopens? (up )?(a )?world of (possibilities|opportunities)\b/i,
];

const GROUNDING_MARKERS = [
  /\[LIVE DATA\]/, /\[ESTIMATED\]/, /\[INFERRED\]/, /\[VERIFIED\]/,
  /\d{1,3}(,\d{3})*(\.\d+)?%/,
  /[$€£¥₦₹]\s?\d[\d,.]*\s?(k|K|M|B)?\b/,
  /\b\d{4}\b/,
];

const HEDGE_PHRASES = [
  /\bit (really )?depends\b/i,
  /\bin general,?\b/i,
  /\bmay vary\b/i,
  /\bthere are many factors\b/i,
  /\bgenerally speaking\b/i,
  /\bin some cases\b/i,
  /\bcould potentially\b/i,
  /\bit'?s worth (noting|mentioning) that\b/i,
];

function _countMatches(text, patterns) {
  return patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

function _typeTokenRatio(text, minWords = 30) {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) || []);
  if (words.length < minWords) return null;
  const unique = new Set(words);
  return unique.size / words.length;
}

function _countRepeatedNGrams(text, n = 4) {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) || []);
  if (words.length < n * 2) return 0;
  const seen = new Map();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(' ');
    seen.set(gram, (seen.get(gram) || 0) + 1);
  }
  let repeats = 0;
  for (const count of seen.values()) if (count > 1) repeats++;
  return repeats;
}

function _countProperNounPhrases(text) {
  const re = /(?<=[a-z0-9,;:]\s)([A-Z][a-zA-Z0-9&.]*(?:\s+[A-Z][a-zA-Z0-9&.]*){1,3})/g;
  const matches = text.match(re) || [];
  return matches.length;
}

function scoreGenericity(text) {
  const s = String(text || '');
  if (!s.trim()) {
    return {
      score: 0, verdict: 'EMPTY',
      signals: {
        genericPhraseHits: 0, groundingMarkerHits: 0, hedgePhraseHits: 0,
        repeatedNGramHits: 0, properNounPhraseHits: 0, vocabDiversity: null,
      },
      flags: [],
      note: 'Empty text -- nothing to score.',
    };
  }

  const genericPhraseHits    = _countMatches(s, GENERIC_PHRASES);
  const groundingMarkerHits  = _countMatches(s, GROUNDING_MARKERS);
  const hedgePhraseHits      = _countMatches(s, HEDGE_PHRASES);
  const repeatedNGramHits    = _countRepeatedNGrams(s);
  const properNounPhraseHits = _countProperNounPhrases(s);
  const vocabDiversity       = _typeTokenRatio(s);

  let score = 50;
  score += Math.min(groundingMarkerHits, 6) * 8;
  score -= Math.min(genericPhraseHits, 6) * 12;
  score -= Math.min(repeatedNGramHits, 5) * 6;
  score -= Math.min(hedgePhraseHits, 4) * 3;
  score += Math.min(properNounPhraseHits, 8) * 2;
  if (vocabDiversity !== null) {
    score += Math.max(-15, Math.min(15, (vocabDiversity - 0.35) * 60));
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const flags = [];
  const contradiction = checkSelfContradiction(s);
  if (contradiction.flagged) flags.push({ type: 'SELF_CONTRADICTION', reason: contradiction.reason });
  const unearned = checkUnearnedCitation(s);
  if (unearned.flagged) flags.push({ type: 'UNEARNED_CITATION', reason: unearned.reason });
  if (hasUnresolvedPlaceholder(s)) {
    flags.push({ type: 'UNRESOLVED_PLACEHOLDER', reason: 'Response contains an unfilled template slot ([bracket]/{{mustache}}) never substituted with a real value.' });
  }
  if (hasGenericPlaceholderCompany(s)) {
    flags.push({ type: 'GENERIC_PLACEHOLDER_COMPANY', reason: 'Response references a generic placeholder company name (e.g. "XYZ Company") instead of a real one.' });
  }
  if (repeatedNGramHits >= 3) {
    flags.push({ type: 'REPETITIVE_OUTPUT', reason: `${repeatedNGramHits} distinct 4-word phrases repeat verbatim elsewhere in the same response.` });
  }

  if (flags.length > 0) score = Math.min(score, 39);

  const verdict = score >= 70 ? 'SPECIFIC' : score >= 40 ? 'MIXED' : 'GENERIC';

  return {
    score, verdict,
    signals: {
      genericPhraseHits, groundingMarkerHits, hedgePhraseHits,
      repeatedNGramHits, properNounPhraseHits, vocabDiversity,
    },
    flags,
    note: 'Deterministic, reproducible signal count -- not a claim of scientifically calibrated genericity measurement. No LLM computed this score.',
  };
}

function logGenericityIfFlagged(text, sourceLabel) {
  try {
    if (!text || typeof text !== 'string' || text.length < 20) return;
    const result = scoreGenericity(text);
    if (result.verdict === 'GENERIC' || result.flags.length > 0) {
      console.warn(
        `[genericityFirewall:${sourceLabel}] verdict=${result.verdict} score=${result.score}` +
        (result.flags.length ? ` flags=${result.flags.map(f => f.type).join(',')}` : '') +
        ` preview="${text.slice(0, 120).replace(/\s+/g, ' ')}..."`
      );
    }
  } catch (e) {
    console.warn('[genericityFirewall] scoring failed (non-fatal):', e.message?.slice(0, 100));
  }
}

module.exports = { scoreGenericity, logGenericityIfFlagged, GENERIC_PHRASES, GROUNDING_MARKERS, HEDGE_PHRASES };
