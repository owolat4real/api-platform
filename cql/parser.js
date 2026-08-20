'use strict';
/**
 * CQL parser — compiles grammar.peggy once at module load (peggy.generate
 * on a grammar this small is sub-millisecond; no separate build step
 * needed) and exposes a single parse(source) entry point.
 *
 * @see ./ast.js for the shape parse() returns.
 * @see ./grammar.peggy for the grammar source.
 */
const fs    = require('fs');
const path  = require('path');
const peggy = require('peggy');

const grammarSource = fs.readFileSync(path.join(__dirname, 'grammar.peggy'), 'utf8');
const generatedParser = peggy.generate(grammarSource);

class CQLSyntaxError extends Error {
  constructor(peggySyntaxError) {
    super(peggySyntaxError.message);
    this.name = 'CQLSyntaxError';
    this.kind = 'syntax_error';
    this.location = peggySyntaxError.location || null; // { start: {line, column}, end: {...} }
  }
}

/**
 * @param {string} source - raw CQL query text
 * @returns {import('./ast').CQLNode} the head of the parsed step linked list
 * @throws {CQLSyntaxError} on any grammar/parse failure — carries a
 *   line/column location (from peggy) so callers can report exactly where
 *   the query broke.
 */
function parse(source) {
  try {
    return generatedParser.parse(source);
  } catch (e) {
    if (e instanceof generatedParser.SyntaxError) {
      throw new CQLSyntaxError(e);
    }
    throw e;
  }
}

module.exports = { parse, CQLSyntaxError };
