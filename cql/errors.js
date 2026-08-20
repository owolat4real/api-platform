'use strict';
/**
 * The three CQL error categories, kept structurally distinct so a client
 * can tell "your query was malformed" (syntax/semantic) apart from "the
 * underlying API call failed" (upstream) at a glance.
 */

class CQLSemanticError extends Error {
  /** @param {string} message @param {string} [step] - the verb/noun name being resolved when this failed */
  constructor(message, step) {
    super(message);
    this.name = 'CQLSemanticError';
    this.kind = 'semantic_error';
    this.step = step || null;
  }
}

class CQLUpstreamError extends Error {
  /** @param {string} message @param {string} step @param {string} code @param {number} status */
  constructor(message, step, code, status) {
    super(message);
    this.name = 'CQLUpstreamError';
    this.kind = 'upstream_error';
    this.step = step;
    this.code = code || 'api_error';
    this.status = status || 502;
  }
}

module.exports = { CQLSemanticError, CQLUpstreamError };
