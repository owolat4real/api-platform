'use strict';
/**
 * ERROR CONTRACT — additive canonical error shape, Developer Cloud API
 * ══════════════════════════════════════════════════════════════
 * Same logic and taxonomy as cs_fixed/middleware/errorContract.js
 * (CAMP/CSTM-2/Transformer/CSVM's copy) -- duplicated rather than
 * shared because this is a physically separate Node project with its
 * own node_modules and deploy pipeline (see ci.yml's own comment on why
 * this app needs its own `npm ci`).
 *
 * Developer Cloud's own error shapes (routes/careerRoutes.js,
 * developerRoutes.js, middleware/auth.js) are already dominantly
 * {error:{code,message,...}} -- the one real divergence is
 * routes/cqlRoutes.js's {success:false,error:{kind,message,step?}}. Both
 * are "already an object" cases, so this only ever fills in missing
 * subfields, never overwrites an existing one.
 *
 * Mounted globally, right after requestId -- safe here (unlike
 * cs_fixed's per-router mounting) because this whole app IS the
 * developer platform; there's no unrelated consumer-facing surface to
 * keep untouched.
 *
 * ADDITIVE ONLY -- never changes the JS type of an existing field:
 *   - `error` absent            -> adds a new `error: {message,code,type,requestId}` object
 *   - `error` already an object -> fills in only whichever of
 *                                  message/code/type/requestId are missing
 *   - `error` already a string  -> left completely untouched; the
 *                                  canonical object is added under a new
 *                                  sibling key, `error_detail`, instead
 *
 * Only wraps res.json -- SSE res.write() error frames are out of scope.
 */

const STATUS_TAXONOMY = {
  400: { code: 'INVALID_REQUEST', type: 'invalid_request_error' },
  401: { code: 'UNAUTHORIZED', type: 'invalid_request_error' },
  402: { code: 'INSUFFICIENT_QUOTA', type: 'insufficient_quota' },
  403: { code: 'INSUFFICIENT_PERMISSIONS', type: 'insufficient_permissions' },
  404: { code: 'NOT_FOUND', type: 'invalid_request_error' },
  409: { code: 'CONFLICT', type: 'invalid_request_error' },
  429: { code: 'RATE_LIMIT_EXCEEDED', type: 'rate_limit_error' },
  500: { code: 'API_ERROR', type: 'api_error' },
  502: { code: 'SERVICE_UNAVAILABLE', type: 'service_unavailable' },
  503: { code: 'SERVICE_UNAVAILABLE', type: 'service_unavailable' },
  504: { code: 'TIMEOUT', type: 'service_unavailable' },
};
const DEFAULT_TAXONOMY = { code: 'API_ERROR', type: 'api_error' };

function _deriveMessage(body) {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.message === 'string') return body.message;
  return null;
}

function _deriveCode(body) {
  if (typeof body.code === 'string') return body.code;
  if (body.error && typeof body.error === 'object' && typeof body.error.code === 'string') return body.error.code;
  return null;
}

function _deriveType(body) {
  if (typeof body.type === 'string') return body.type;
  if (body.error && typeof body.error === 'object' && typeof body.error.type === 'string') return body.error.type;
  return null;
}

/** @internal exported for tests */
function applyErrorContract(body, statusCode, requestId) {
  const taxonomy = STATUS_TAXONOMY[statusCode] || DEFAULT_TAXONOMY;
  const canonical = {
    message: _deriveMessage(body) || 'Request failed',
    code: _deriveCode(body) || taxonomy.code,
    type: _deriveType(body) || taxonomy.type,
    requestId: requestId || null,
  };

  if (body.error === undefined || body.error === null) {
    body.error = canonical;
  } else if (typeof body.error === 'object' && !Array.isArray(body.error)) {
    if (body.error.message === undefined) body.error.message = canonical.message;
    if (body.error.code === undefined) body.error.code = canonical.code;
    if (body.error.type === undefined) body.error.type = canonical.type;
    if (body.error.requestId === undefined) body.error.requestId = canonical.requestId;
  } else if (typeof body.error === 'string' && body.error_detail === undefined) {
    body.error_detail = canonical;
  }
  return body;
}

function errorContract() {
  return function errorContractMiddleware(req, res, next) {
    const _origJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
        try {
          body = applyErrorContract(body, res.statusCode, req.id);
        } catch (_e) {
          // Never let contract-enrichment break a real error response.
        }
      }
      return _origJson(body);
    };
    next();
  };
}

module.exports = errorContract;
module.exports.applyErrorContract = applyErrorContract;
