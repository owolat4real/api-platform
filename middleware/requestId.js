'use strict';
/**
 * X-Request-Id on every response — same header shape as cs_fixed's
 * equivalent middleware (CAMP/CSTM-2/Transformer/CSVM), so a request ID
 * means the same thing across all 5 developer platforms. routes/
 * careerRoutes.js's own body-level `request_id` field reuses req.id set
 * here instead of minting an unrelated second ID.
 */
const crypto = require('crypto');

function requestId(req, res, next) {
  const id = 'req_' + crypto.randomBytes(8).toString('hex');
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
