'use strict';
/**
 * Real, standalone AI integration for Developer Cloud's own transactional
 * emails (2026-09-08). This service has no dependency on cs_fixed's AI
 * gateway -- a deliberate architectural boundary: cs_fixed and
 * api-platform are separately deployed, separately scaled services with
 * their own databases; coupling this service's emails to cs_fixed's own
 * uptime would make a routine welcome email fail whenever the OTHER
 * service is having a bad day. Uses Groq directly (free, fast, the same
 * provider cs_fixed itself defaults to) via a plain REST call -- no new
 * SDK dependency needed, this repo already has axios.
 *
 * Same safety bar as cs_fixed's services/devPlatformEmailBus.js /
 * services/devPlatformAuthEmail.js: the AI is only ever asked to write
 * the human opening line of an email, grounded in real facts passed in
 * by the caller, never asked to reproduce the actual API key, a link, or
 * a dollar amount itself -- those stay in deterministic surrounding text
 * the AI never touches. Falls back to the caller's own static sentence
 * if DEVCLOUD_GROQ_API_KEY isn't configured, the call fails, times out,
 * or returns something too short/degenerate -- never blocks or skips a
 * send either way.
 */
const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.1-8b-instant / llama-3.3-70b-versatile were both fully
// decommissioned by Groq (confirmed live, 404, matching cs_fixed's own
// middleware/brain.js:587's identical finding from 2026-08-17).
//
// Real gap (2026-09-08): DEVCLOUD_GROQ_API_KEY currently reuses cs_fixed's
// own Groq account/key (a genuinely separate account needs the account
// owner's own sign-up -- not something obtainable on their behalf), so a
// single hardcoded model shares that account's per-model daily quota with
// every other caller. Confirmed live: openai/gpt-oss-20b hit its real
// 1000 RPD cap from cs_fixed's own traffic alone. Groq's rate-limit error
// itself confirms the cap is PER MODEL, not account-wide ("Rate limit
// reached for model `X`... requests per day (RPD): Limit 1000, Used
// 1000") -- so trying a different real, currently-live model on the same
// key/account genuinely has separate headroom, not just a hopeful retry.
// Falls through this list only on a 429; any other error (bad auth,
// malformed request) fails fast to the caller's static fallback instead
// of wasting 3 round trips on an error no model swap will fix.
const GROQ_MODELS = ['openai/gpt-oss-20b', 'groq/compound-mini', 'openai/gpt-oss-120b'];

async function composeOpeningLine({ task, facts, staticFallback }) {
  const key = process.env.DEVCLOUD_GROQ_API_KEY;
  if (!key) return staticFallback;

  const system = `You are writing the opening line(s) of a short transactional email on behalf of CareerStudioMax Developer Cloud, in a warm, direct, human voice -- like a real engineer on the team wrote it personally, never a marketing system or a form letter.
[VERIFIED FACTS — real, do not invent anything beyond this]
${facts}
This email's job right now: ${task}
Rules:
- Plain text only, no HTML, no markdown, no emoji.
- Exactly 1-2 short sentences. No greeting ("Hi ___,") and never state an actual API key, link, or dollar amount yourself -- those are shown separately right after what you write; refer to them only in passing if it reads naturally ("the key below").
- No corporate filler ("We hope this email finds you well", "Thank you for choosing us").
- Never invent a fact beyond what's given above.
Return ONLY those 1-2 sentences, nothing else.`;

  for (const model of GROQ_MODELS) {
    try {
      const resp = await axios.post(GROQ_URL, {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'Write that opening line now.' },
        ],
        // The openai/gpt-oss-* models in this list are reasoning models --
        // they spend tokens on hidden reasoning before emitting any visible
        // text, so a small max_tokens can silently starve the actual answer
        // to empty (confirmed live: 120 produced a real 200 OK with content
        // ""). 800 leaves comfortable headroom over that reasoning overhead
        // for what's genuinely only a 1-2 sentence answer.
        max_tokens: 800,
        temperature: 0.7,
      }, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      const text = (resp.data?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
      if (text.length > 12) return text;
      // A real 200 OK with empty/too-short content -- confirmed live as a
      // real reasoning-model quirk (gpt-oss-120b), not necessarily a
      // model-wide problem, so worth trying the next model rather than
      // giving up on the first empty response.
      console.warn(`[aiCompose] ${model} returned empty/degenerate content, trying next model`);
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && model !== GROQ_MODELS[GROQ_MODELS.length - 1]) {
        console.warn(`[aiCompose] ${model} rate-limited, trying next model`);
        continue;
      }
      console.warn('[aiCompose] Groq call failed, using static fallback:', e.message?.slice(0, 100));
      break;
    }
  }
  return staticFallback;
}

module.exports = { composeOpeningLine };
