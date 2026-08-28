'use strict';
/**
 * Career Intelligence API — 9 purpose-built career intelligence endpoints.
 * Every response is model-name-masked so developers see careerlm-* branding.
 */
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const { authMiddleware }    = require('../middleware/auth');
const { rpmLimiter }        = require('../middleware/rateLimit');
const { callCareerCamp }    = require('../proxy/campProxy');
const { getDB }             = require('../db/connection');
const { MODEL_DISPLAY_NAMES } = require('../keys/keyManager');

router.use(authMiddleware);
router.use(rpmLimiter);

/* ── HELPERS ──────────────────────────────────────────────── */
// Reuses the same X-Request-Id the server-level middleware already put on
// this response (middleware/requestId.js) instead of minting a second,
// unrelated ID — so the body's request_id and the header always match.
// Falls back to a fresh one only if that middleware somehow didn't run.
const req_id = (req) => (req && req.id) || 'req_' + crypto.randomBytes(8).toString('hex');

function maskModel(model) {
  return MODEL_DISPLAY_NAMES[model] || 'careerlm-standard';
}

const PORTAL_URL = process.env.PORTAL_URL || 'https://careerstudiomax.com';

function tier(apiKey, feature, res) {
  if (apiKey.features.includes('all') || apiKey.features.includes('all_career') || apiKey.features.includes(feature)) return true;
  res.status(403).json({ error: { code: 'feature_not_available', message: `${feature} is not included in your current plan`, upgrade: `${PORTAL_URL}/pricing` } });
  return false;
}

// ── CONTEXT RESOLUTION — this is what actually backs the "pass
// context_id to every endpoint for automatic personalisation" claim:
// explicit request fields always win, context only fills in whatever
// the caller didn't pass this time. Previously context_id was accepted
// by these routes but never looked up at all (live-confirmed 2026-08-22).
async function _resolveContext(req, fields) {
  const { context_id } = req.body;
  if (!context_id) return {};
  try {
    const db  = getDB();
    const ctx = await db.collection('career_contexts').findOne({ contextId: context_id, developerId: req.apiKey.developerId });
    if (!ctx) return {};
    const out = {};
    for (const f of fields) if (ctx[f] !== undefined && ctx[f] !== null) out[f] = ctx[f];
    return out;
  } catch (_) { return {}; }
}

function err(req, res, e) {
  if (e.code === 'content_policy_violation') return res.status(422).json({ error: { code: e.code, message: e.message, request_id: req_id(req) } });
  if (e.code === 'model_unavailable')         return res.status(503).json({ error: { code: e.code, message: e.message, request_id: req_id(req) } });
  if (e.code === 'request_timeout')           return res.status(504).json({ error: { code: e.code, message: e.message, request_id: req_id(req) } });
  console.error('[careerlm-api]', e.message);
  res.status(500).json({ error: { code: 'internal_error', message: 'An error occurred. Retry or contact api@careerstudiomax.com', request_id: req_id(req) } });
}

function done(res, result) {
  res.locals.tokensUsed = result.usage?.total_tokens || 0;
  res.locals.modelUsed  = result.model;
}

/* ── PROMPT BUILDERS ─────────────────────────────────────── */
function pCVScore(cvText, jd, role, country, opts = {}) {
  return `Score this CV for ATS optimisation${role ? ` targeting: ${role}` : ''}${country ? ` in the ${country} job market` : ''}.

CV:
${cvText.slice(0, 4000)}

${jd ? `JOB DESCRIPTION:\n${jd.slice(0, 2000)}\n` : ''}
Return valid JSON only:
{
  "ats_score": <integer 0-100>,
  "grade": <"A+"|"A"|"B+"|"B"|"C+"|"C"|"D"|"F">,
  "keyword_match": { "matched": [...], "missing": [...], "coverage": <integer> },
  "section_scores": { "summary": <int>, "experience": <int>, "skills": <int>, "education": <int> }${opts.include_suggestions !== false ? ',\n  "top_suggestions": [<5 specific improvements>]' : ''}${opts.include_keywords !== false ? ',\n  "power_keywords": [<8 ATS keywords to add>]' : ''},
  "verdict": "<one authoritative sentence>"
}
Calibration: 70-79=good, 80-89=very good, 90+=exceptional. Be precise.`;
}

function pCVOptimise(cvText, jd, role, country, opts = {}) {
  const level = opts.rewrite_level || 'moderate';
  return `Optimise this CV${role ? ` for: ${role}` : ''} (market: ${country}).
Rewrite level: ${level} (light=minor edits, moderate=significant improvement, full=complete rewrite)
Preserve voice: ${opts.preserve_voice !== false}
Add metrics where missing: ${opts.add_metrics !== false}

ORIGINAL CV:
${cvText.slice(0, 4000)}

${jd ? `JOB DESCRIPTION:\n${jd.slice(0, 2000)}\n` : ''}
Return valid JSON:
{
  "optimised_cv": "<full rewritten CV>",
  "changes": { "summary": "<what changed>", "key_improvements": [...], "sections_rewritten": [...] },
  "before_score": <int>,
  "after_score": <int>,
  "word_count": <int>
}`;
}

function pSalary(role, country, city, yrs, skills, size, opts = {}) {
  const cur = opts.currency || (country === 'NG' ? 'NGN' : country === 'US' ? 'USD' : 'GBP');
  return `Salary intelligence report.
Role: ${role}
Location: ${city ? city + ', ' : ''}${country}
Experience: ${yrs} years | Company size: ${size || 'any'} | Currency: ${cur}
Skills: ${skills.join(', ') || 'general'}

Return valid JSON:
{
  "role": "${role}",
  "location": "${city ? city + ', ' : ''}${country}",
  "currency": "${cur}",
  "salary_range": { "low": <int>, "median": <int>, "high": <int>, "top_10_percent": <int> },
  "usd_equivalent": { "low": <int>, "median": <int>, "high": <int> },
  "ppp_adjusted": true,
  "skill_premiums": [{ "skill": <str>, "premium_percent": <int> }],
  "negotiation_target": <int>,
  "negotiation_script": "<2-sentence opening>",
  "confidence": <"high"|"medium"|"low">,
  "data_source": "CareerStudioMax Market Intelligence",
  "yoy_growth_percent": <float>${opts.include_equity ? ',\n  "equity_range": { "low": "<str>", "high": "<str>" }' : ''}${opts.include_benefits ? ',\n  "common_benefits": [...]' : ''}
}`;
}

const COVER_MODES = {
  1:  'Achievement-led: open with your single most impressive quantified achievement relevant to this role.',
  2:  'Insight-led: open with a sharp industry insight that shows you understand the company\'s challenge.',
  3:  'Problem-solution: here is the problem this company faces — here is how I solve it.',
  4:  'Narrative arc: a brief professional story whose peak is why this role is the next chapter.',
  5:  'Company-specific: open with genuine research about the company — product, culture, or recent news.',
  6:  'Question-led: a bold rhetorical question that perfectly frames your value.',
  7:  'Bold statement: the most confident, attention-grabbing statement about your professional impact.',
  8:  'Data-driven: three specific metrics in the opening paragraph to establish immediate credibility.',
  9:  'Cultural fit: lead with alignment to the company\'s stated values and mission.',
  10: 'Career transition: acknowledge the transition and reframe it as the unique advantage it is.',
  11: 'Promotion-within: written as if applying internally — acknowledge existing context, focus on readiness.',
  12: 'Referral: gracefully mention the referral name in the opening as context.',
  13: 'Remote confidence: lead with concrete proof of remote/async excellence.',
  14: 'Multilingual: signal genuine multilingual/multicultural professional value.',
  15: 'Executive gravitas: C-level tone — strategy, vision, transformation language throughout.',
};

function pCoverLetter(cvText, jd, company, name, mode, country, tone, opts = {}) {
  return `Write a cover letter for ${name || 'the candidate'} applying to ${company || 'this company'}.

Mode ${mode}: ${COVER_MODES[mode] || COVER_MODES[1]}
Tone: ${tone} | Market: ${country} | Word limit: ${opts.word_limit || 280}

CV (summary):
${(cvText || '').slice(0, 2000)}

JOB DESCRIPTION:
${(jd || '').slice(0, 2000)}

Write ONLY the cover letter text. No preamble, no JSON, no meta-commentary.
Never use: "passionate", "dynamic", "proven track record", "leverage", "synergies".
Make it specific, compelling, and immediately hireable.`;
}

function pJobMatch(candidate, job) {
  return `Job match analysis.

CANDIDATE:
${candidate.cv_text ? 'CV: ' + candidate.cv_text.slice(0, 2000) + '\n' : ''}Skills: ${(candidate.skills || []).join(', ')}
Experience: ${candidate.years_experience || 0} yrs | Location: ${candidate.location || '?'} | Salary expectation: ${candidate.salary_expectation || '?'}

JOB:
Title: ${job.title || ''} | Location: ${job.location || ''} | Remote: ${job.remote || '?'}
${job.description ? 'Description: ' + job.description.slice(0, 2000) + '\n' : ''}Required skills: ${(job.required_skills || []).join(', ')}
Salary: ${job.salary_min || '?'} – ${job.salary_max || '?'}

Return valid JSON:
{
  "overall_score": <int 0-100>,
  "grade": <"A+"|"A"|"B+"|"B"|"C+"|"C"|"D"|"F">,
  "dimensions": { "skills": <int>, "experience": <int>, "salary": <int>, "location": <int>, "culture_signals": <int> },
  "recommendation": "<one actionable sentence>",
  "gaps": [{ "skill": <str>, "severity": <"critical"|"moderate"|"minor">, "learn_hours": <int> }],
  "strengths": [<3-5 specific strengths>],
  "interview_probability": <float 0-1>,
  "apply_recommendation": <"apply_now"|"apply_with_caveats"|"skill_up_first"|"pass">
}`;
}

function pInterview(role, company, type, cvText, count, answers, seniority) {
  return `Generate ${count} ${type} interview questions for: ${role}${company ? ' at ' + company : ''}.
Seniority: ${seniority}
${cvText ? 'Candidate CV:\n' + cvText.slice(0, 1500) + '\n' : ''}
Return a valid JSON array. Each item:
{
  "question": <str>,
  "type": <"behavioural"|"technical"|"case"|"situational">,
  "why_asked": <str — what is really being tested>,
  "difficulty": <"easy"|"medium"|"hard">${answers ? ',\n  "model_answer": <STAR format, 150-200 words>,\n  "common_mistakes": [...]' : ''}
}
Make questions specific to ${company || 'top companies in this space'}. No generic filler.`;
}

function pSkillGap(skills, role, country, months, salary, opts = {}) {
  const cur = opts.currency || 'GBP';
  return `Skill gap analysis.
Current skills: ${skills.join(', ')}
Target role: ${role} | Market: ${country} | Timeline: ${months} months
Current salary: ${salary ? cur + ' ' + salary : 'unspecified'}

Return valid JSON:
{
  "target_role": "${role}",
  "market": "${country}",
  "readiness_score": <int 0-100>,
  "gaps": [{
    "skill": <str>,
    "priority": <int 1-N>,
    "severity": <"critical"|"moderate"|"minor">,
    "current_level": <"none"|"basic"|"intermediate">,
    "required_level": <"L1"|"L2"|"L3"|"L4">,
    "learn_hours": <int>,
    "learn_weeks": <int>,
    "salary_impact": "<+£x,xxx/year>",
    "demand_score": <int 0-100>,
    "free_resources": [...],
    "certification": <str|null>
  }],
  "estimated_time_to_ready": "<N months>",
  "total_salary_unlock": "<+£xx,xxx/year>"${opts.include_roi ? ',\n  "roi_analysis": { "investment_hours": <int>, "salary_gain_year1": "<str>", "payback_months": <int> }' : ''}
}`;
}

/* ══════════════════════════════════════════════════════════
   ENDPOINT 1 — CV SCORE
══════════════════════════════════════════════════════════ */
router.post('/cv/score', async (req, res) => {
  const { cv_text, job_description, target_country, target_role, options = {} } = req.body;
  if (!cv_text) return res.status(400).json({ error: { code: 'missing_cv_text', message: 'cv_text is required' } });
  try {
    const ctx = await _resolveContext(req, ['target_role', 'target_country']);
    const role = target_role || ctx.target_role;
    const country = target_country || ctx.target_country || 'GB';
    const result = await callCareerCamp({
      feature_id: 'resume_scorer',
      user_input: pCVScore(cv_text, job_description, role, country, options),
      user_id:    req.apiKey.developerId,
      schema:     'cv_score',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 2 — CV OPTIMISE
══════════════════════════════════════════════════════════ */
router.post('/cv/optimise', async (req, res) => {
  const { cv_text, job_description, target_role, target_country, options = {} } = req.body;
  if (!cv_text) return res.status(400).json({ error: { code: 'missing_cv_text', message: 'cv_text is required' } });
  if (!tier(req.apiKey, 'cv_optimise', res)) return;
  try {
    const ctx = await _resolveContext(req, ['target_role', 'target_country']);
    const role = target_role || ctx.target_role;
    const country = target_country || ctx.target_country || 'GB';
    const result = await callCareerCamp({
      feature_id: 'resume_auto_optimiser',
      user_input: pCVOptimise(cv_text, job_description, role, country, options),
      user_id:    req.apiKey.developerId,
      schema:     'cv_rewrite',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 3 — SALARY BENCHMARK
══════════════════════════════════════════════════════════ */
router.post('/salary/benchmark', async (req, res) => {
  const { role, country, city, years_experience = 0, skills = [], company_size, options = {} } = req.body;
  if (!tier(req.apiKey, 'salary_bench', res)) return;
  try {
    const ctx = await _resolveContext(req, ['target_role', 'target_country']);
    const resolvedRole    = role || ctx.target_role;
    const resolvedCountry = country || ctx.target_country || 'GB';
    if (!resolvedRole) return res.status(400).json({ error: { code: 'missing_role', message: 'role is required (directly, or via a context_id whose saved profile includes target_role)' } });
    const result = await callCareerCamp({
      feature_id: 'salary_benchmark',
      user_input: pSalary(resolvedRole, resolvedCountry, city, years_experience, skills, company_size, options),
      user_id:    req.apiKey.developerId,
      schema:     'salary_report',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 4 — COVER LETTER (15 modes)
══════════════════════════════════════════════════════════ */
router.post('/cover-letter/generate', async (req, res) => {
  const { cv_text, job_description, company_name, candidate_name, mode = 1, target_country, tone = 'confident', options = {} } = req.body;
  if (!tier(req.apiKey, 'cover_letter', res)) return;
  const modeNum   = Math.min(15, Math.max(1, parseInt(mode) || 1));
  const featureId = `cover_letter_m${String(modeNum).padStart(2, '0')}`;
  try {
    const ctx     = await _resolveContext(req, ['target_country']);
    const country = target_country || ctx.target_country || 'GB';
    const result = await callCareerCamp({
      feature_id: featureId,
      user_input: pCoverLetter(cv_text, job_description, company_name, candidate_name, modeNum, country, tone, options),
      user_id:    req.apiKey.developerId,
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, mode: modeNum, mode_name: COVER_MODES[modeNum]?.split(':')[0], request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 5 — JOB MATCH
══════════════════════════════════════════════════════════ */
router.post('/job/match', async (req, res) => {
  const { candidate, job } = req.body;
  if (!candidate || !job) return res.status(400).json({ error: { code: 'missing_fields', message: 'candidate and job objects are required' } });
  try {
    const result = await callCareerCamp({
      feature_id: 'job_match_scorer',
      user_input: pJobMatch(candidate, job),
      user_id:    req.apiKey.developerId,
      schema:     'job_match',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 6 — INTERVIEW QUESTIONS
══════════════════════════════════════════════════════════ */
router.post('/interview/questions', async (req, res) => {
  const { role, company, interview_type = 'behavioural', cv_text, count = 10, include_answers = true, seniority = 'mid' } = req.body;
  if (!role) return res.status(400).json({ error: { code: 'missing_role', message: 'role is required' } });
  if (!tier(req.apiKey, 'interview_prep', res)) return;
  try {
    const result = await callCareerCamp({
      feature_id: 'interview_engine_1',
      user_input: pInterview(role, company, interview_type, cv_text, Math.min(count, 20), include_answers, seniority),
      user_id:    req.apiKey.developerId,
      schema:     'interview_questions',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 7 — SKILL GAP ANALYSIS
══════════════════════════════════════════════════════════ */
router.post('/skills/gap', async (req, res) => {
  const { current_skills = [], target_role, target_country, years_to_achieve = 12, current_salary, options = {} } = req.body;
  try {
    const ctx  = await _resolveContext(req, ['target_role', 'target_country']);
    const role = target_role || ctx.target_role;
    const country = target_country || ctx.target_country || 'GB';
    if (!role) return res.status(400).json({ error: { code: 'missing_target_role', message: 'target_role is required (directly, or via a context_id whose saved profile includes target_role)' } });
    const result = await callCareerCamp({
      feature_id: 'cv_gap_detector',
      user_input: pSkillGap(current_skills, role, country, years_to_achieve, current_salary, options),
      user_id:    req.apiKey.developerId,
      schema:     'gap_report',
    }, req.apiKey);
    done(res, result);
    res.json({ ...result, request_id: req_id(req), model: maskModel(result.model) });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 8 — CHAT COMPLETIONS (OpenAI-compatible)
══════════════════════════════════════════════════════════ */
router.post('/chat/completions', async (req, res) => {
  const { messages = [], max_tokens = 800 } = req.body;
  if (!messages.length) return res.status(400).json({ error: { code: 'missing_messages', message: 'messages array is required' } });
  const lastUser = messages.filter(m => m.role === 'user').pop()?.content || '';
  const history  = messages.slice(0, -1);
  try {
    const result = await callCareerCamp({
      feature_id: 'brain_ai_chat',
      user_input: lastUser,
      messages:   history,
      user_id:    req.apiKey.developerId,
    }, req.apiKey);
    done(res, result);
    res.json({
      id:      `cstm-${Date.now()}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model:   'careerlm',
      choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
      usage:   result.usage || {},
    });
  } catch (e) { err(req, res, e); }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINT 9 — CAREER CONTEXT (persistent memory)
══════════════════════════════════════════════════════════ */
router.post('/context', async (req, res) => {
  const { context_id, profile = {} } = req.body;
  const db        = getDB();
  const contextId = context_id || crypto.randomUUID();
  await db.collection('career_contexts').updateOne(
    { contextId, developerId: req.apiKey.developerId },
    { $set: { ...profile, contextId, developerId: req.apiKey.developerId, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ context_id: contextId, status: 'saved', request_id: req_id(req) });
});

router.get('/context/:id', async (req, res) => {
  const db  = getDB();
  const ctx = await db.collection('career_contexts').findOne({
    contextId:   req.params.id,
    developerId: req.apiKey.developerId,
  });
  if (!ctx) return res.status(404).json({ error: { code: 'not_found', message: 'Context not found' } });
  res.json({ ...ctx, request_id: req_id(req) });
});

router.delete('/context/:id', async (req, res) => {
  const db = getDB();
  await db.collection('career_contexts').deleteOne({
    contextId:   req.params.id,
    developerId: req.apiKey.developerId,
  });
  res.json({ status: 'deleted', request_id: req_id(req) });
});

module.exports = router;
