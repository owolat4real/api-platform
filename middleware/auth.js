'use strict';
const { KeyManager } = require('../keys/keyManager');
const PORTAL_URL = process.env.PORTAL_URL || 'https://careerstudiomax.com';

async function authMiddleware(req, res, next) {
  const rawKey =
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.api_key;

  if (!rawKey) {
    return res.status(401).json({
      error: {
        code:      'missing_api_key',
        message:   'Include your CareerStudioMax API key in the X-Api-Key header',
        retryable: false,
        docs:      'https://careerstudiomax.com/api/docs/authentication',
      }
    });
  }

  const validation = await KeyManager.validate(rawKey);

  if (!validation.valid) {
    const status = validation.reason === 'daily_limit_exceeded' ? 429
      : validation.reason === 'monthly_token_budget_exceeded' ? 402
      : 401;
    const retryable = status === 429;
    if (retryable) res.setHeader('Retry-After', secondsUntilMidnight());
    return res.status(status).json({
      error: {
        code:      validation.reason,
        message:   getErrorMessage(validation),
        retryable,
        ...(retryable ? { retryAfterSeconds: secondsUntilMidnight() } : {}),
        docs:      'https://careerstudiomax.com/api/docs/errors',
      }
    });
  }

  req.apiKey  = validation.record;
  req.keyHash = validation.record.keyHash;

  // Record usage after response is sent
  res.on('finish', () => {
    const tokens   = res.locals.tokensUsed || 0;
    const model    = res.locals.modelUsed  || 'unknown';
    const feature  = req.path.replace(/^\//, '').replace(/\//g, '_');
    KeyManager.recordUsage(req.keyHash, tokens, model, feature).catch(() => {});
  });

  next();
}

function getErrorMessage(v) {
  return ({
    no_key:               'No API key provided',
    invalid_format:       'API key format is invalid — keys start with csk_live_v1_, csk_test_v1_, or csk_free_v1_',
    key_not_found:        'API key not found or has been revoked',
    daily_limit_exceeded: `Daily limit of ${v.limit?.toLocaleString()} requests reached — resets at midnight UTC. Upgrade at ${PORTAL_URL}/pricing`,
    monthly_token_budget_exceeded: `Free tier's monthly token budget (${v.limit?.toLocaleString()}) is used up for this calendar month. Upgrade at ${PORTAL_URL}/pricing`,
  })[v.reason] || 'Authentication failed';
}

function secondsUntilMidnight() {
  const now  = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.ceil((midnight - now) / 1000);
}

module.exports = { authMiddleware };
