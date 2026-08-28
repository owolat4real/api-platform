'use strict';
const rateLimit = require('express-rate-limit');

const PORTAL_URL = process.env.PORTAL_URL || 'https://careerstudiomax.com';

// Cache limiters by RPM value — avoids creating a new limiter per request
const _cache = new Map();

function getLimiter(rpm) {
  if (_cache.has(rpm)) return _cache.get(rpm);
  const limiter = rateLimit({
    windowMs:       60 * 1000,
    max:            rpm,
    keyGenerator:   (req) => req.keyHash || req.ip,
    standardHeaders: true,
    legacyHeaders:  false,
    handler: (req, res) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        error: {
          code:        'rate_limit_exceeded',
          message:     `Rate limit of ${rpm} requests/minute exceeded`,
          retryable:   true,
          retry_after: 60,
          docs:        'https://careerstudiomax.com/api/docs/errors#rate-limiting',
          upgrade:     `${PORTAL_URL}/pricing`,
        }
      });
    },
  });
  _cache.set(rpm, limiter);
  return limiter;
}

function rpmLimiter(req, res, next) {
  const rpm = req.apiKey?.rpm || 10;
  getLimiter(rpm)(req, res, next);
}

module.exports = { rpmLimiter };
