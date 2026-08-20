'use strict';
const express = require('express');
const router  = express.Router();

const { authMiddleware } = require('../middleware/auth');
const { parse, CQLSyntaxError } = require('../cql/parser');
const { execute } = require('../cql/interpreter');
const { CQLSemanticError, CQLUpstreamError } = require('../cql/errors');

// Auth only, deliberately no rpmLimiter here — each step in a pipeline
// already hits a real /v1/career/* endpoint that enforces its own rpm
// limit. Rate-limiting the wrapper too would double-charge a single
// conceptual request (e.g. a 1-verb query would cost 2 rpm units instead
// of 1) against the same real cost this is meant to throttle.
router.use(authMiddleware);

router.post('/execute', async (req, res) => {
  const source = req.body?.query;
  if (typeof source !== 'string' || !source.trim()) {
    return res.status(400).json({
      success: false,
      error: { kind: 'semantic_error', message: 'Request body must be { "query": "<CQL source>" }' },
    });
  }

  let ast;
  try {
    ast = parse(source);
  } catch (e) {
    if (e instanceof CQLSyntaxError) {
      return res.status(400).json({
        success: false,
        error: { kind: 'syntax_error', message: e.message, location: e.location },
      });
    }
    throw e;
  }

  const rawApiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  try {
    const result = await execute(ast, rawApiKey);
    if (result.status === 'stopped') {
      return res.json({ success: true, status: 'stopped', reason: result.reason, result: result.context, steps: result.steps });
    }
    return res.json({ success: true, status: 'ok', result: result.context, steps: result.steps });
  } catch (e) {
    if (e instanceof CQLSemanticError) {
      return res.status(422).json({ success: false, error: { kind: 'semantic_error', message: e.message, step: e.step } });
    }
    if (e instanceof CQLUpstreamError) {
      return res.status(e.status).json({ success: false, error: { kind: 'upstream_error', message: e.message, code: e.code, step: e.step } });
    }
    console.error('[CQL]', e);
    return res.status(500).json({ success: false, error: { kind: 'internal_error', message: 'CQL execution failed unexpectedly' } });
  }
});

module.exports = router;
