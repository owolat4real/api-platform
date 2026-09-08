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
// middleware/brain.js:587's identical finding from 2026-08-17) --
// openai/gpt-oss-20b is Groq's current small/fast model, the same one
// cs_fixed's own GROQ_FAST_MODEL pool already uses for short, simple
// tasks like this one.
const GROQ_MODEL = 'openai/gpt-oss-20b';

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

  try {
    const resp = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Write that opening line now.' },
      ],
      max_tokens: 120,
      temperature: 0.7,
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    const text = (resp.data?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    if (text.length > 12) return text;
  } catch (e) {
    console.warn('[aiCompose] Groq call failed, using static fallback:', e.message?.slice(0, 100));
  }
  return staticFallback;
}

module.exports = { composeOpeningLine };
