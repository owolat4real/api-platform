'use strict';
/**
 * Real behavioral test for keyManager.js's real nodemailer usage
 * (alertAdmin — sendWelcomeEmail uses the identical createTransport/
 * sendMail pattern but isn't itself exported, so this is the faithful,
 * exported proxy for both). Written 2026-08-30 specifically to verify
 * the nodemailer 6.9.13 -> 9.0.6 upgrade (7 real CVEs: SMTP command
 * injection, CRLF injection, TLS cert validation, ReDoS, stack overflow
 * in address parsing) doesn't change this file's real, basic
 * createTransport({host,port,auth}) + sendMail({from,to,subject,html})
 * call shape — confirmed unchanged across v7/v8/v9 via nodemailer's own
 * real CHANGELOG before this upgrade was applied.
 *
 * No test framework existed in this repo before this file — uses
 * Node's built-in node:test/node:assert (Node 18+, no new dependency)
 * rather than introducing jest for one file. Mocks nodemailer by
 * patching its CommonJS-cached export directly (no experimental
 * mock.module flag needed) — contained to this process only.
 *
 * Run: node --test keys/keyManager.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

test('alertAdmin — real createTransport/sendMail call shape', async (t) => {
  const originalEnv = { ...process.env };
  process.env.SMTP_HOST = 'smtp.test.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'smtp-user';
  process.env.SMTP_PASS = 'smtp-pass';
  process.env.EMAIL_FROM = 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>';
  process.env.ADMIN_EMAIL = 'admin@careerstudiomax.com';
  process.env.NODE_ENV = 'test';

  let capturedTransportOpts = null;
  let capturedMailOpts = null;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = (opts) => {
    capturedTransportOpts = opts;
    return {
      sendMail: async (mailOpts) => {
        capturedMailOpts = mailOpts;
        return { messageId: 'fake-id' };
      },
    };
  };

  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
    process.env = originalEnv;
  });

  delete require.cache[require.resolve('./keyManager')];
  const { alertAdmin } = require('./keyManager');

  await alertAdmin('Test Subject', 'Test detail line');

  assert.ok(capturedTransportOpts, 'createTransport was called');
  assert.equal(capturedTransportOpts.host, 'smtp.test.example.com');
  assert.equal(capturedTransportOpts.port, 587);
  assert.deepEqual(capturedTransportOpts.auth, { user: 'smtp-user', pass: 'smtp-pass' });

  assert.ok(capturedMailOpts, 'sendMail was called');
  assert.equal(capturedMailOpts.from, 'CareerStudioMax Developer Cloud <api@careerstudiomax.com>');
  assert.equal(capturedMailOpts.to, 'admin@careerstudiomax.com');
  assert.equal(capturedMailOpts.subject, '🚨 Test Subject');
  assert.match(capturedMailOpts.html, /Test detail line/);
});

test('alertAdmin — no-ops (no createTransport call) when SMTP_HOST is not configured', async (t) => {
  const originalEnv = { ...process.env };
  delete process.env.SMTP_HOST;

  let called = false;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => { called = true; return { sendMail: async () => {} }; };

  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
    process.env = originalEnv;
  });

  delete require.cache[require.resolve('./keyManager')];
  const { alertAdmin } = require('./keyManager');
  await alertAdmin('subject', 'detail');

  assert.equal(called, false, 'createTransport must not be called with no SMTP_HOST configured');
});

test('alertAdmin — a real transport/send failure never throws (fire-and-forget, matches its own try/catch)', async (t) => {
  const originalEnv = { ...process.env };
  process.env.SMTP_HOST = 'smtp.test.example.com';

  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => { throw new Error('real SMTP connection refused'); },
  });

  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
    process.env = originalEnv;
  });

  delete require.cache[require.resolve('./keyManager')];
  const { alertAdmin } = require('./keyManager');

  await assert.doesNotReject(alertAdmin('subject', 'detail'));
});

test('the real installed nodemailer version is the intended, upgraded, non-vulnerable one', () => {
  const { version } = require('nodemailer/package.json');
  const [major] = version.split('.').map(Number);
  assert.ok(major >= 9, `expected nodemailer major version >= 9 (the real fix for the 7 CVEs npm audit flagged on 6.9.13), got ${version}`);
});
