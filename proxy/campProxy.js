'use strict';
/**
 * campProxy — routes all public API calls to the internal CareerCamp AI gateway
 * at localhost:3002. External developers never see the internal URL or model names.
 */
const axios = require('axios');

const CAMP_URL = process.env.CAREERCAMP_URL || 'http://localhost:3002';
const CAMP_KEY = process.env.CAREERCAMP_INTERNAL_KEY || process.env.CS_TRANSFORMER_API_KEY || '';

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

    return {
      content:      data.content,
      model:        data.model    || 'cs-sonnet',
      piiProtected: data.piiProtected || false,
      usedFallback: data.usedFallback || false,
      usage: {
        prompt_tokens:     data.usage?.prompt_tokens     || 0,
        completion_tokens: data.usage?.completion_tokens || Math.ceil((data.content.length || 0) / 4),
        total_tokens:      data.usage?.total_tokens      || Math.ceil((data.content.length || 0) / 4),
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
