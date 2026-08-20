'use strict';
/**
 * Walks a parsed CQL AST and executes it. Every step here either seeds
 * context (nouns) or calls a real /v1/career/* endpoint on THIS SAME
 * server (verbs) — no business logic is reimplemented; a verb call is a
 * literal HTTP request to the existing route, authenticated with the
 * caller's own API key, so tier limits/rate limits/usage tracking all
 * apply exactly as if the developer had called that endpoint directly.
 * A 3-step CQL pipeline costs 3 requests against the caller's quota, not 1
 * — there's no hidden bypass.
 */
const axios = require('axios');
const { NOUNS, VERBS } = require('./verbs');
const { CQLSemanticError, CQLUpstreamError } = require('./errors');

const SELF_BASE_URL = process.env.CQL_SELF_URL || `http://127.0.0.1:${process.env.PORT || 3005}`;

/**
 * @param {import('./ast').CQLNode} ast
 * @param {string} rawApiKey - the caller's own raw API key, forwarded to every internal call
 * @returns {Promise<{status: 'ok'|'stopped', context: object, steps: Array}>}
 */
async function execute(ast, rawApiKey) {
  let context = {};
  const steps = [];
  let node = ast;
  let isFirst = true;

  while (node) {
    const { name } = node;

    if (isFirst && NOUNS[name]) {
      const noun = NOUNS[name];
      if (noun.seed) {
        const seeded = noun.seed(node);
        context = { ...context, ...seeded };
        steps.push({ step: name, type: 'noun', result: seeded });
      } else if (noun.call) {
        const result = await callEndpoint(noun.call, node, context, rawApiKey);
        const merged = noun.call.mergeResult(result);
        context = { ...context, ...merged };
        steps.push({ step: name, type: 'noun_call', result: merged });
      }
    } else if (name === 'when') {
      const passed = evaluateWhen(node, context);
      steps.push({ step: 'when', type: 'guard', passed });
      if (!passed) {
        return { status: 'stopped', reason: `when(${node.positional.left} ${node.positional.op} ${node.positional.right.value}) was false`, context, steps };
      }
    } else if (VERBS[name]) {
      const verb = VERBS[name];
      for (const required of verb.requiresContext) {
        if (context[required] === undefined) {
          throw new CQLSemanticError(
            `${name}(...) needs "${required}" from an earlier step — did you forget a cv(...) noun at the start of the pipeline?`,
            name
          );
        }
      }
      const result = await callEndpoint(verb, node, context, rawApiKey);
      const merged = verb.mergeResult(result);
      context = { ...context, ...merged };
      steps.push({ step: name, type: 'verb', result: merged });
    } else if (NOUNS[name]) {
      // A noun appearing after the first position, e.g. `score(...) | cv("...")`.
      throw new CQLSemanticError(`"${name}" is a noun and can only be the first step in a pipeline`, name);
    } else {
      throw new CQLSemanticError(
        `unknown verb or noun "${name}". Phase 1 supports: ${Object.keys(NOUNS).concat(Object.keys(VERBS), ['when']).join(', ')}`,
        name
      );
    }

    isFirst = false;
    node = node.next;
  }

  return { status: 'ok', context, steps };
}

function evaluateWhen(node, context) {
  const cond = node.positional;
  if (!cond || cond.type !== 'condition') {
    throw new CQLSemanticError('when(...) requires a condition, e.g. when(ats_score > 75)', 'when');
  }
  if (context[cond.left] === undefined) {
    throw new CQLSemanticError(`when(${cond.left} ...) refers to "${cond.left}", which no earlier step produced`, 'when');
  }
  const left = context[cond.left];
  const right = cond.right.value;
  switch (cond.op) {
    case '>':  return left >  right;
    case '<':  return left <  right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '==': return left === right;
    case '!=': return left !== right;
    default:   throw new CQLSemanticError(`unknown comparison operator "${cond.op}"`, 'when');
  }
}

async function callEndpoint(spec, node, context, rawApiKey) {
  const body = spec.buildBody(node, context);
  // job_description doesn't survive as a real endpoint response field, but
  // cover_letter needs it from the score/optimise step that ran before it
  // — carried through context under a private key rather than invented as
  // a fake API response field.
  if (body.job_description) context.job_description = body.job_description;

  try {
    const resp = await axios({
      method: spec.method,
      url: `${SELF_BASE_URL}${spec.path}`,
      data: body,
      headers: { 'X-Api-Key': rawApiKey, 'Content-Type': 'application/json' },
      timeout: 45000,
      validateStatus: () => true, // handle non-2xx ourselves, below
    });

    if (resp.status >= 400) {
      const err = resp.data?.error || {};
      throw new CQLUpstreamError(err.message || 'the underlying API call failed', node.name, err.code, resp.status);
    }
    return resp.data;
  } catch (e) {
    if (e instanceof CQLUpstreamError) throw e;
    throw new CQLUpstreamError(`could not reach the CareerStudioMax API: ${e.message}`, node.name, 'connection_error', 502);
  }
}

module.exports = { execute, evaluateWhen };
