'use strict';
/**
 * campProxy — routes all public API calls to the internal CareerCamp AI gateway
 * at localhost:3002. External developers never see the internal URL or model names.
 */
const axios = require('axios');
const { logGenericityIfFlagged } = require('../services/genericityFirewall');

const CAMP_URL = process.env.CAREERCAMP_URL || 'http://localhost:3002';
const CAMP_KEY = process.env.CAREERCAMP_INTERNAL_KEY || process.env.CS_TRANSFORMER_API_KEY || '';

// Live-caught (2026-08-19): careercamp-ai's /v1/camp/:featureId has no JSON
// extraction step at all for the standard (non-proxy-scored) pipeline —
// result.content is returned completely raw, whatever the model emitted.
// A reasoning-capable model answering a schema-requesting feature (like
// cv_score) emits its full <think>...</think> block BEFORE the JSON,
// which every caller here documents as "content is a JSON string you
// parse yourself" -- but a <think>-prefixed string isn't valid JSON, so
// every consumer's JSON.parse(content) would throw. Scoped to this
// proxy (api-platform's own layer) rather than the shared careercamp-ai
// gateway, which has other consumers this fix shouldn't risk touching.
// Only applied when `schema` is set — plain-text features (chat,
// cover-letter without a schema) are untouched.
function _stripThinkBlock(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
function _extractJSONText(raw) {
  const stripped = _stripThinkBlock(raw)
    .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/```\s*$/m, '').trim();
  try { JSON.parse(stripped); return stripped; } catch (_) {}
  // Model added prose around the JSON — grab the outermost {...} or [...]
  const match = stripped.match(/[{\[][\s\S]*[}\]]/);
  if (match) { try { JSON.parse(match[0]); return match[0]; } catch (_) {} }
  return null;
}

async function callCareerCamp({ feature_id, user_input, user_id, messages = [], schema, stream = false }, apiKey) {
  const maxTokens = apiKey?.maxTokens || 1000;
  try {
    const resp = await axios.post(
      `${CAMP_URL}/v1/camp/${feature_id}`,
      {
        userInput: user_input,
        userId:    user_id || null,
        language:  'en',
        messages,
        maxTokens,
        stream:    false,
      },
      {
        headers: {
          'x-api-key':           CAMP_KEY,
          'Content-Type':        'application/json',
          'x-developer-tier':    apiKey?.tier || 'FREE',
          'x-platform-request':  '1',
        },
        timeout: 45000,
      }
    );

    const data = resp.data;
    if (!data?.content) throw new Error('Empty response from CareerCamp gateway');

    let content = data.content;
    if (schema) {
      const cleaned = _extractJSONText(content);
      if (!cleaned) {
        // Real, honest classification (2026-08-30): this is a parsing/
        // validation failure on a model result that DID come back --
        // not a "the engine is unreachable" outage. It was previously
        // thrown as 'model_unavailable', the same code used a few lines
        // below for a genuine connection failure -- indistinguishable to
        // a caller, and misleading: retry logic built around "wait for
        // the service to come back" won't fix a malformed-generation
        // problem the way it fixes a real outage (though retrying IS
        // still the right immediate action either way).
        const err  = new Error('The AI engine returned an unusable result for this request — please retry');
        err.code   = 'generation_parse_error';
        err.status = 503;
        throw err;
      }
      content = cleaned;
    }

    // Real gap found live (2026-08-30): careercamp-ai's /v1/camp/:featureId
    // response has no `usage` object at all (confirmed via its own source
    // -- unlike the separate /v1/chat/completions-style endpoint, which
    // does compute real token counts), so prompt_tokens was silently
    // always 0 -- every caller using this for billing/quota visibility
    // was seeing a flatly wrong number, not just an imprecise one.
    // completion_tokens already had a sensible char-count estimate for
    // exactly this "upstream didn't report it" case; prompt_tokens never
    // got the same treatment. Estimated the same way (~4 chars/token),
    // from the real user_input this function was actually sent.
    const promptTokenEstimate = Math.ceil((user_input || '').length / 4);
    const completionTokenEstimate = Math.ceil((data.content.length || 0) / 4);
    // Real gap closed (2026-09-04): services/fabricationGuard.js was only
    // wired into 2 of this platform's 9 real endpoints, and even there it
    // checks source-document traceability, not generic-filler-phrase/
    // self-contradiction/placeholder-leak detection. This is the single
    // real choke point every one of the 9 endpoints calls through, so
    // hooking it here gives real coverage across all of them at once.
    // Observational only (logs, never blocks/retries) -- see
    // services/genericityFirewall.js's own header for why this is
    // deliberately lighter-touch than fabricationGuard's retry-then-503.
    logGenericityIfFlagged(content, `camp:${feature_id}`);
    return {
      content,
      model:        data.model    || 'cs-sonnet',
      piiProtected: data.piiProtected || false,
      usedFallback: data.usedFallback || false,
      usage: {
        prompt_tokens:     data.usage?.prompt_tokens     || promptTokenEstimate,
        completion_tokens: data.usage?.completion_tokens || completionTokenEstimate,
        total_tokens:      data.usage?.total_tokens      || (promptTokenEstimate + completionTokenEstimate),
      },
    };
  } catch (e) {
    if (e.response?.status === 422) {
      const body = e.response.data;
      const err  = new Error(body?.message || 'Request blocked by content policy');
      err.code   = 'content_policy_violation';
      err.status = 422;
      err.detail = body;
      throw err;
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
      const err  = new Error('CareerStudioMax Developer Cloud AI engine is temporarily unavailable — our team has been notified');
      err.code   = 'model_unavailable';
      err.status = 503;
      throw err;
    }
    if (e.code === 'ECONNABORTED' || e.message?.includes('timeout')) {
      const err  = new Error('Request timed out — try a shorter input or retry');
      err.code   = 'request_timeout';
      err.status = 504;
      throw err;
    }
    throw e;
  }
}

module.exports = { callCareerCamp };
