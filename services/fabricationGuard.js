'use strict';
/**
 * FABRICATION GUARD — post-generation check that a model's output didn't
 * invent a fact (a name, employer, or number) with no basis in what the
 * caller actually submitted, added 2026-08-30 after live-verifying a real,
 * serious bug: /cover-letter/generate producing invented metrics ("2
 * million daily transactions", "1.8x increase in client integrations",
 * "3 million events per day with zero downtime") that don't appear
 * anywhere in the submitted CV, each one tagged [VERIFIED] -- a fabricated
 * claim wearing the platform's own highest-trust label.
 *
 * Ports cs_fixed/routes/resume.js's checkStructuralFabrication /
 * extractNumericClaims (a proven mechanism, already fixed once for a real
 * false-positive: spelled-out "22 percent" vs "22%" being misread as a
 * new claim) rather than reimplementing extraction from scratch --
 * duplicated, not shared, because this is a physically separate Node
 * project (same reasoning as this app's own errorContract.js).
 *
 * Generalized from resume.js's single "original vs optimized" comparison
 * to an array of source texts: cover letters and CV rewrites here
 * legitimately synthesize MULTIPLE real inputs (cv_text, job_description,
 * company_name, candidate_name), so a name/number is fabricated only when
 * it traces back to NONE of them -- checking against cv_text alone would
 * false-positive on every real company name or JD term the model
 * (correctly) wove in.
 */

const SECTION_LABELS = new Set([
  'Professional Summary', 'Technical Skills', 'Professional Experience',
  'Work Experience', 'Projects', 'Education', 'Certifications',
  'Publications', 'Experience', 'Summary', 'Skills',
]);

// Real gap found while testing (2026-08-30): cs_fixed's original regex
// requires 1-2 ADDITIONAL capitalized words after the first ("Tech
// Solutions Ltd"), so it never matches a single-word entity at all --
// which is exactly the shape of the review's own example ("Paystack").
// A bare single-capitalized-word match would also catch every ordinary
// sentence-initial word ("Reduced", "Understanding", "This"), so
// single-word candidates are filtered through this denylist instead of
// matched unconditionally -- multi-word phrases stay unfiltered (a real
// two-or-three-word capitalized phrase is almost never a false positive
// the way a lone capitalized word is).
const COMMON_SENTENCE_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'I', 'My', 'We', 'Our', 'You', 'Your',
  'It', 'Its', 'He', 'She', 'They', 'Their', 'A', 'An',
  'At', 'For', 'In', 'On', 'With', 'By', 'From', 'To', 'As', 'Of', 'Over', 'Under',
  'Reduced', 'Increased', 'Improved', 'Led', 'Built', 'Managed', 'Developed',
  'Delivered', 'Launched', 'Optimized', 'Optimised', 'Architected', 'Automated',
  'Created', 'Designed', 'Implemented', 'Owned', 'Drove', 'Achieved', 'Exceeded',
  'Understanding', 'Never', 'Always', 'Both', 'Either', 'Neither', 'Since', 'While',
  'When', 'Where', 'What', 'Why', 'How', 'Here', 'There', 'Thank', 'Thanks',
  'Please', 'Dear', 'Sincerely', 'Regards', 'Best',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
]);

// Same normalization as cs_fixed's proven version: spelled-out
// percent/thousand/million/billion collapse to the symbol form so a
// model reformatting "22 percent" as "22%" isn't mistaken for a new
// claim -- only a genuinely different number still trips this.
function extractNumericClaims(text) {
  const normalized = (text || '')
    .replace(/(\d)\s*percent\b/gi, '$1%')
    .replace(/(\d)\s*thousand\b/gi, '$1k')
    .replace(/(\d)\s*million\b/gi, '$1m')
    .replace(/(\d)\s*billion\b/gi, '$1b');
  const matches = normalized.match(/\$?[\d,]+(?:\.\d+)?\s*[kKmMbB%]?(?:illion)?\+?/g) || [];
  return matches
    .map(m => m.replace(/,/g, '').replace(/\s+/g, '').toLowerCase())
    .filter(m => {
      if (!/\d/.test(m)) return false;
      const digitCount = m.replace(/[^\d]/g, '').length;
      // A unit suffix (%, k, m, b) makes even a single digit a real,
      // specific, checkable claim ("2m" = 2 million, "5%") -- only a
      // genuinely bare, unitless single digit ("4 engineers", "#3" list
      // numbering) is noise. Real bug found while testing: this filter
      // was dropping "2m"/"5%" outright before this suffix check existed,
      // silently letting exactly the kind of large invented figure this
      // guard exists to catch slip through uncounted.
      const hasUnitSuffix = /[kmb%]/.test(m);
      return digitCount > 1 || hasUnitSuffix;
    });
}

/**
 * @param {string} text
 * @param {boolean} strict - true for GENERATED text: single-word matches
 *   require a mid-clause lookbehind (preceded by lowercase+whitespace),
 *   since an unconditional match would flag every sentence-initial word
 *   ("Reduced...", "This...", a fresh bullet). false for SOURCE text:
 *   matched unconditionally, because a field like company_name/
 *   candidate_name is typically passed as a BARE standalone string (just
 *   "Stripe", just "Ada Okonkwo") with no surrounding sentence, so it is
 *   ALWAYS "sentence-initial" from a regex's point of view -- the strict
 *   mode would wrongly treat every real company/candidate name as
 *   unsourced. Over-including on the source side only makes the check
 *   more lenient (never a false-negative risk for catching fabrication);
 *   only the generated side needs the noisier single-word match tamed.
 */
function extractProperNouns(text, strict) {
  const t = text || '';
  const rawMultiWord = (t.match(/\b[A-Z][a-zA-Z]+(?:[^\S\n]+[A-Z][a-zA-Z]+){1,2}\b/g) || [])
    .filter(m => !SECTION_LABELS.has(m));
  // A phrase whose FIRST word is a common/function word ("At Paystack",
  // "The Company") is almost always an artifact of sentence-initial
  // capitalization coincidentally sitting next to a real proper noun --
  // not a genuine multi-word entity name ("Tech Solutions Ltd", where
  // every word is part of the name). Real bug found while testing: an
  // unfiltered match on "At Paystack" both (a) let a company name evade
  // detection when genuinely fabricated (counted as a "phrase", under
  // the phrase-tolerance threshold) and (b) wrongly excluded "Paystack"
  // from the single-word check that WOULD have caught it, since it
  // looked like part of an already-counted phrase.
  const multiWord = rawMultiWord.filter(p => !COMMON_SENTENCE_WORDS.has(p.split(/\s+/)[0]));
  const singleWordPattern = strict
    ? /(?<=[a-z,;:]\s)[A-Z][a-zA-Z]{2,}\b/g   // mid-clause only: "worked at Paystack"
    : /\b[A-Z][a-zA-Z]{2,}\b/g;                // unconditional: bare "Paystack" as a field value
  // Words already captured as part of a GENUINE multi-word phrase
  // ("Platform Engineering") must not ALSO be counted individually --
  // but a word that was only part of a spurious phrase (filtered out
  // above) stays eligible, so "Paystack" in "At Paystack" still gets
  // its own independent check.
  const wordsInPhrases = new Set(multiWord.flatMap(p => p.split(/\s+/)));
  const singleWord = (t.match(singleWordPattern) || [])
    .filter(m => !COMMON_SENTENCE_WORDS.has(m) && !SECTION_LABELS.has(m) && !wordsInPhrases.has(m));
  return { multiWord, singleWord };
}

/**
 * @param {string} generatedText - the model's output to check
 * @param {string[]} sourceTexts - every real field the caller submitted
 *   (cv_text, job_description, company_name, candidate_name, ...) -- a
 *   name/number in generatedText is only flagged if it appears in NONE
 *   of these. Kept in a separate bucket from multi-word phrases (see
 *   below) because a lone unsourced word is a stronger signal than an
 *   unsourced multi-word phrase: sourceTexts already includes the job
 *   description and company name, so a real cover letter should
 *   essentially never introduce a proper noun absent from CV + JD +
 *   company + candidate name all at once -- one is enough to distrust,
 *   unlike phrases, where wording/boundary differences need more
 *   tolerance.
 * @param {{checkNumbers?: boolean}} [options] - checkNumbers defaults to
 *   true. Real conflict found live (2026-08-30): /cv/optimise's own
 *   prompt explicitly says "Add metrics where missing: true" by default
 *   -- an advertised, opt-in feature, not a bug -- which means every
 *   call with that default was guaranteed to introduce a "new" number
 *   and get flagged, permanently breaking the feature it was supposed
 *   to just make honest. checkNumbers:false lets a caller that
 *   deliberately invited metric-adding skip ONLY the number check while
 *   keeping full protection against the more dangerous class this guard
 *   exists for -- a fabricated employer/company NAME, which is never a
 *   legitimate thing for any of these endpoints to add regardless of
 *   options.
 * @returns {{flagged: boolean, suspiciousEntities: string[]}}
 */
function checkFabrication(generatedText, sourceTexts, options = {}) {
  const checkNumbers = options.checkNumbers !== false;
  const combinedSource = (sourceTexts || []).filter(Boolean).join('\n');
  const sourceProper = extractProperNouns(combinedSource, false);
  const sourceNounSet = new Set([...sourceProper.multiWord, ...sourceProper.singleWord]);
  const sourceNumbers = new Set(extractNumericClaims(combinedSource));

  const generatedProper = extractProperNouns(generatedText, true);
  const newMultiWord = [...new Set(generatedProper.multiWord.filter(n => !sourceNounSet.has(n)))];
  const newSingleWord = [...new Set(generatedProper.singleWord.filter(n => !sourceNounSet.has(n)))];
  const newNumbers = checkNumbers
    ? [...new Set(extractNumericClaims(generatedText).filter(n => !sourceNumbers.has(n)))]
    : [];

  const suspiciousEntities = [...newMultiWord, ...newSingleWord, ...newNumbers];
  // Unlike cs_fixed's original CV-rewrite check (single source document,
  // where minor wording drift during a rewrite is expected and tolerated
  // via a >2 threshold), this checks generation against MULTIPLE distinct
  // real source fields at once (cv_text, job_description, company_name,
  // candidate_name) -- a genuine cover letter or CV rewrite should never
  // need to introduce a name or number that traces to none of them, so
  // any single new (genuine, non-spurious) entity or number is enough to
  // flag, not just a pattern of several.
  return {
    flagged: newMultiWord.length > 0 || newSingleWord.length > 0 || newNumbers.length > 0,
    suspiciousEntities: suspiciousEntities.slice(0, 10),
  };
}

module.exports = { checkFabrication, extractNumericClaims, extractProperNouns };
