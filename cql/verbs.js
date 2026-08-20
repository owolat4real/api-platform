'use strict';
/**
 * CQL Phase 1 vocabulary — every noun/verb this build actually supports,
 * and exactly which existing /v1/career/* endpoint (if any) it maps to.
 *
 * SCOPE DECISION (made without an explicit answer to the 3 open questions
 * from the design review — documented here so it's easy to revisit):
 *   - Phase 1 targets api-platform's /v1/career/* endpoints ONLY. Nothing
 *     here calls into Transformer (different product, different auth).
 *   - `graph`, `diff`, `explain`, `candidate` are NOT implemented — graph/
 *     diff live on Transformer, explain has no backing endpoint anywhere
 *     in the codebase, and candidate() had no clear resolution path. A
 *     query using any of these fails with a clear CQLSemanticError
 *     ("unknown noun/verb"), not a crash or a silent no-op.
 *   - `match` (job/match) is also deferred — the real endpoint needs
 *     structured `candidate` and `job` objects that don't fit CQL's
 *     noun-context-passing model without inventing object-literal syntax,
 *     which is out of scope for a minimal DSL.
 *   - A bare identifier used as a value (e.g. `job_id` in the original
 *     brief's `match(job: job_id)`) is treated as a semantic error at
 *     execution time: CQL has no variables, so there is nothing for it to
 *     resolve to. This is the conservative choice — it fails loud and
 *     cheaply fixable (quote it as a string) rather than silently
 *     guessing what the developer meant.
 *
 * Every noun/verb here is either:
 *   - a CONTEXT SEEDER (no HTTP call — just merges values into the
 *     pipeline's running context for later steps to use), or
 *   - an ENDPOINT CALL (makes a real request to an existing /v1/career/*
 *     route and merges the response into context).
 * `salary` is both at once, since /salary/benchmark is already a single,
 * complete call — there's no natural "verb" that would follow it.
 */
const { CQLSemanticError, CQLUpstreamError } = require('./errors');

/** Resolve a CQLValue (string/number/identifier/condition) to a plain JS value, or throw. */
function resolveValue(value, stepName) {
  if (value == null) return null;
  switch (value.type) {
    case 'string': return value.value;
    case 'number': return value.value;
    case 'identifier':
      throw new CQLSemanticError(
        `"${value.name}" is not a recognised value — CQL has no variables, so a bare word can't be resolved. ` +
        `Did you mean to quote it as a string ("${value.name}")?`,
        stepName
      );
    case 'condition':
      // Only when() should ever receive one of these as its positional arg —
      // reaching here means it showed up somewhere else in the query.
      throw new CQLSemanticError(`a condition (${value.left} ${value.op} ...) can only appear inside when(...)`, stepName);
    default:
      throw new CQLSemanticError(`unrecognised value type "${value.type}"`, stepName);
  }
}

/** Resolve every named arg on a step into a plain { key: jsValue } object. */
function resolveArgs(node) {
  const out = {};
  for (const [k, v] of Object.entries(node.args || {})) {
    out[k] = resolveValue(v, node.name);
  }
  return out;
}

// Every schema'd /v1/career/* endpoint (score, optimise, salary, skills_gap,
// interview_questions) returns its real structured result as a JSON STRING
// inside `content`, never parsed server-side before the HTTP response goes
// out — confirmed by hitting the live endpoint directly, not assumed from
// its docs (whose own JS/Python SDK samples don't parse it either, a
// separate, real bug in that product, out of scope to fix here). CQL
// parses it once, here, so a query never has to deal with a stringified
// JSON blob as one of its context values. cover_letter is the one
// exception — its prompt asks for plain text, no schema, so its `content`
// really is the letter text and is left as-is.
function parseSchemaContent(result, stepName) {
  try {
    return JSON.parse(result.content);
  } catch (e) {
    throw new CQLUpstreamError(`the underlying API returned an unparsable result for ${stepName}`, stepName, 'unparsable_response', 502);
  }
}

const NOUNS = {
  // cv("...") seeds context.cv_text with the positional argument. CQL does
  // no file I/O — there's no "resolve a filename to file contents" API in
  // this codebase, so the positional value IS the CV text itself, not a
  // path to read. Documented plainly rather than faking a capability that
  // doesn't exist.
  cv: {
    seed(node) {
      if (!node.positional) throw new CQLSemanticError('cv(...) requires a positional argument (the CV text)', 'cv');
      return { cv_text: resolveValue(node.positional, 'cv') };
    },
  },

  // salary(...) is a full, standalone call — POST /v1/career/salary/benchmark.
  salary: {
    call: {
      method: 'POST',
      path: '/v1/career/salary/benchmark',
      buildBody(node) {
        if (!node.positional) throw new CQLSemanticError('salary(...) requires a positional argument (the role)', 'salary');
        const args = resolveArgs(node);
        return {
          role: resolveValue(node.positional, 'salary'),
          country: args.country, city: args.city, currency: args.currency,
          years_experience: args.years_experience, company_size: args.company_size,
        };
      },
      mergeResult(result) { return parseSchemaContent(result, 'salary'); },
    },
  },
};

const VERBS = {
  score: {
    method: 'POST',
    path: '/v1/career/cv/score',
    requiresContext: ['cv_text'],
    buildBody(node, context) {
      const args = resolveArgs(node);
      if (!args.job) throw new CQLSemanticError('score(job: "...") requires a job argument', 'score');
      return { cv_text: context.cv_text, job_description: args.job, target_role: args.target_role, target_country: args.target_country };
    },
    mergeResult(result) {
      const parsed = parseSchemaContent(result, 'score');
      return { ats_score: parsed.ats_score, grade: parsed.grade, keyword_match: parsed.keyword_match, section_scores: parsed.section_scores };
    },
  },

  optimise: {
    method: 'POST',
    path: '/v1/career/cv/optimise',
    requiresContext: ['cv_text'],
    buildBody(node, context) {
      const args = resolveArgs(node);
      return { cv_text: context.cv_text, job_description: args.job || context.job_description, target_role: args.target_role, target_country: args.target_country };
    },
    mergeResult(result) {
      const parsed = parseSchemaContent(result, 'optimise');
      return { optimised_cv: parsed.optimised_cv, before_score: parsed.before_score, after_score: parsed.after_score };
    },
  },

  cover_letter: {
    method: 'POST',
    path: '/v1/career/cover-letter/generate',
    requiresContext: ['cv_text'],
    buildBody(node, context) {
      const args = resolveArgs(node);
      return {
        cv_text: context.cv_text,
        job_description: context.job_description,
        mode: args.mode, company_name: args.company_name, candidate_name: args.candidate_name,
        target_country: args.target_country, tone: args.tone,
      };
    },
    mergeResult(result) { return { content: result.content, mode_name: result.mode_name }; },
  },

  interview_questions: {
    method: 'POST',
    path: '/v1/career/interview/questions',
    requiresContext: [],
    buildBody(node, context) {
      const args = resolveArgs(node);
      if (!args.role) throw new CQLSemanticError('interview_questions(role: "...") requires a role argument', 'interview_questions');
      return { role: args.role, company: args.company, cv_text: context.cv_text, seniority: args.seniority, count: args.count };
    },
    // The prompt behind this endpoint explicitly asks for a JSON array
    // (not an object), so this is the one schema'd endpoint where the
    // parsed content itself, not a field pulled off it, is the result.
    mergeResult(result) { return { questions: parseSchemaContent(result, 'interview_questions') }; },
  },

  skills_gap: {
    method: 'POST',
    path: '/v1/career/skills/gap',
    requiresContext: [],
    buildBody(node) {
      const args = resolveArgs(node);
      if (!args.target_role) throw new CQLSemanticError('skills_gap(target_role: "...") requires a target_role argument', 'skills_gap');
      const currentSkills = args.current_skills ? String(args.current_skills).split(',').map(s => s.trim()) : [];
      return { current_skills: currentSkills, target_role: args.target_role, target_country: args.target_country };
    },
    mergeResult(result) {
      const parsed = parseSchemaContent(result, 'skills_gap');
      return { readiness_score: parsed.readiness_score, gaps: parsed.gaps, estimated_time_to_ready: parsed.estimated_time_to_ready };
    },
  },
};

module.exports = { NOUNS, VERBS, resolveValue, resolveArgs };
