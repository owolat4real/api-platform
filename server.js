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

app.use(require('./middleware/requestId'));
app.use(require('./middleware/errorContract')());

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

// Live-caught (2026-08-28 audit): openapi.yaml existed in this repo but
// was never actually served or linked from anywhere -- a real spec
// nobody could reach. It's a static reference doc (no request-specific
// data), so serving it straight off disk is fine.
app.get('/openapi.yaml', (req, res) => {
  res.type('text/yaml; charset=utf-8');
  res.sendFile(require('path').join(__dirname, 'openapi.yaml'));
});

// developer-portal's own nav bar links straight to /openapi.yaml, which a
// browser just renders as an unstyled raw-text dump -- no page chrome at
// all, unlike every other developer-portal page. This gives it a real,
// minimally-styled shell (self-contained, no dependency on cs_fixed's
// separately-deployed consumer-site assets, since this is a distinct
// product/origin) while /openapi.yaml itself stays raw for tooling
// (Postman/codegen import by URL).
app.get('/docs', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAPI Spec — CareerStudioMax Developer Cloud</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css" media="(prefers-color-scheme: light)">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background:#0a0a0b; color:#d4d4d8; line-height:1.65; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  .top-row { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h1 { font-size: 1.5rem; color:#5b7c99; margin:0 0 6px; }
  .subtitle { color:#8a8a92; font-size:.9rem; margin:0 0 24px; }
  .raw-link { color:#5b7c99; font-size:.85rem; text-decoration:none; white-space:nowrap; }
  .raw-link:hover { text-decoration:underline; }
  #spec-body { border-radius: 10px; overflow: auto; max-height: 78vh; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.03); }
  #spec-body pre { margin:0; padding:18px 20px; font-size:.82rem; }
  @media (prefers-color-scheme: light) {
    body { background:#ffffff; color:#3f3f46; }
    .subtitle { color:#71717a; }
    #spec-body { border-color: rgba(0,0,0,.08); background: rgba(0,0,0,.02); }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top-row">
    <div>
      <h1>CareerStudioMax Developer Cloud</h1>
      <p class="subtitle">Real, current OpenAPI 3 spec for this API.</p>
    </div>
    <a class="raw-link" href="/openapi.yaml">View raw YAML &rarr;</a>
  </div>
  <div id="spec-body"><pre><code class="language-yaml">Loading…</code></pre></div>
</div>
<script>
  fetch('/openapi.yaml').then(function(r){ return r.text(); }).then(function(yaml){
    var code = document.querySelector('#spec-body code');
    code.textContent = yaml;
    hljs.highlightElement(code);
  }).catch(function(){
    document.getElementById('spec-body').textContent = 'Could not load the spec. View it raw at /openapi.yaml.';
  });
</script>
</body>
</html>`);
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

  // Revoked API Key Cleanup (2026-08-28) -- same grace-period auto-delete
  // as cs_fixed's jobs/revokedKeyCleanup.js, adapted to this service's
  // plain setInterval style (no node-cron dependency here). Runs once at
  // boot, then every 24h. A revoked key is already fully inert the
  // instant it's revoked (KeyManager.validate only ever matches
  // status:'active') -- this just clears out the historical record after
  // it's sat revoked for REVOKED_KEY_RETENTION_DAYS (default 90d) with
  // nobody manually deleting it via DELETE /keys/:developerId/:keyId.
  const { KeyManager } = require('./keys/keyManager');
  const runKeyCleanup = () => {
    KeyManager.cleanupRevokedKeys()
      .then(({ deletedCount, retentionDays }) => {
        if (deletedCount) console.log(`[KEY-CLEANUP] Permanently deleted ${deletedCount} key(s) revoked more than ${retentionDays}d ago`);
      })
      .catch(e => console.error('[KEY-CLEANUP] Sweep failed:', e.message));
  };
  runKeyCleanup();
  setInterval(runKeyCleanup, 24 * 60 * 60 * 1000);
}

boot().catch(e => { console.error('Boot failed:', e.message); process.exit(1); });
