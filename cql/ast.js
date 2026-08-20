'use strict';
/**
 * CQL AST shape — a boring, explicit linked list, per spec. This file has
 * no runtime code; it exists purely to document the shape parser.js
 * produces, since this codebase is plain JS rather than TypeScript.
 *
 * @typedef {Object} CQLNode
 * @property {string} name - the noun/verb name, e.g. "cv", "score", "when".
 *   The AST does not distinguish noun vs. verb — that's a vocabulary
 *   lookup the interpreter does, not a syntactic property.
 * @property {CQLValue|null} positional - the single positional argument,
 *   if the step had one (e.g. "resume.pdf" in cv("resume.pdf")). null if
 *   the step used only named arguments or none at all.
 * @property {Object<string, CQLValue>} args - named arguments as a flat
 *   key -> value map, e.g. { job: {type:"string", value:"..."} }.
 * @property {CQLNode|null} next - the next step in the pipeline, or null
 *   at the end.
 *
 * @typedef {CQLStringValue|CQLNumberValue|CQLIdentifierValue|CQLConditionValue} CQLValue
 *
 * @typedef {Object} CQLStringValue
 * @property {"string"} type
 * @property {string} value
 *
 * @typedef {Object} CQLNumberValue
 * @property {"number"} type
 * @property {number} value
 *
 * @typedef {Object} CQLIdentifierValue
 * @property {"identifier"} type
 * @property {string} name - a bare word used as a value, e.g. `job_id` in
 *   `match(job: job_id)`. CQL has no variables, so this does NOT reference
 *   anything — see the open question in cql/README.md about what (if
 *   anything) this should mean at execution time.
 *
 * @typedef {Object} CQLConditionValue
 * @property {"condition"} type
 * @property {string} left - identifier on the left, e.g. "ats_score"
 * @property {">"|"<"|">="|"<="|"=="|"!="} op
 * @property {CQLNumberValue|CQLStringValue} right
 */

module.exports = {}; // types only — see JSDoc above
