'use strict';
/**
 * CareerStudioMax Developer Cloud — public developer API
 * Port 3005 | Routes to CareerCamp AI at localhost:3002 (internal)
 * Developers interact with this service only — never the internal gateway.
 */
require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { connect } = require('./db/connection');

const careerRoutes    = require('./routes/careerRoutes');
const developerRoutes = require('./routes/developerRoutes');
const cqlRoutes       = require('./routes/cqlRoutes');

const app  = express();
const PORT = process.env.PORT || 3005;

// ── Security ───────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined', { skip: (req) => req.url === '/health' }));

// Global rate limiter — generous, per-key limits enforced inside routes
app.use(rateLimit({
  windowMs:        60 * 1000,
  max:             2000,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.headers['x-api-key'] || req.ip,
}));

// ── Routes ─────────────────────────────────────────────────
app.use('/v1/career',    careerRoutes);
app.use('/v1/developer', developerRoutes);
app.use('/v1/cql',       cqlRoutes);

// ── Public endpoints ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'CareerStudioMax Developer Cloud', version: '1.0.0', uptime: Math.round(process.uptime()) });
});

app.get('/', (req, res) => {
  res.json({
    service:     'CareerStudioMax Developer Cloud — World\'s First Career Intelligence API',
    version:     '1.0.0',
    docs:        'https://careerstudiomax.com/api/docs',
    quickstart:  'https://careerstudiomax.com/api/docs/quickstart',
    register:    'POST /v1/developer/register',
    endpoints: {
      cv_score:          'POST /v1/career/cv/score',
      cv_optimise:       'POST /v1/career/cv/optimise',
      salary_benchmark:  'POST /v1/career/salary/benchmark',
      cover_letter:      'POST /v1/career/cover-letter/generate',
      job_match:         'POST /v1/career/job/match',
      interview_prep:    'POST /v1/career/interview/questions',
      skill_gap:         'POST /v1/career/skills/gap',
      chat:              'POST /v1/career/chat/completions',
      context:           'POST /v1/career/context',
      cql_execute:       'POST /v1/cql/execute',
    },
    free_tier:   '1,000 requests/day — no credit card required',
    auth:        'X-Api-Key: csk_free_v1_...',
  });
});

app.get('/v1', (req, res) => res.redirect('/'));

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: {
      code:    'not_found',
      message: `${req.method} ${req.path} is not a valid CareerStudioMax Developer Cloud endpoint`,
      docs:    'https://careerstudiomax.com/api/docs',
    }
  });
});

// ── Error handler ──────────────────────────────────────────
app.use((error, req, res, _next) => {
  console.error('[CareerStudioMax Developer Cloud]', error.message);
  res.status(error.status || 500).json({
    error: { code: 'internal_error', message: error.message || 'Internal server error' }
  });
});

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  CareerStudioMax Developer Cloud — World\'s First Career Intelligence API  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  try {
    await connect();
    console.log('  ✅ MongoDB connected');
  } catch (e) {
    console.warn('  ⚠  MongoDB unavailable:', e.message?.slice(0, 80));
    console.warn('     API will start but /register and auth will fail until DB is available');
  }

  app.listen(PORT, () => {
    console.log(`\n  🚀 CareerStudioMax Developer Cloud → http://localhost:${PORT}`);
    console.log(`  📋 Register:   POST http://localhost:${PORT}/v1/developer/register`);
    console.log(`  📖 Docs:       https://careerstudiomax.com/api/docs\n`);
  });
}

boot().catch(e => { console.error('Boot failed:', e.message); process.exit(1); });
