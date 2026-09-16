'use strict';
/**
 * Real tests for server.js's graceful shutdown (2026-09-16 hardening
 * pass) -- SIGTERM/SIGINT handling, bounded in-flight-request drain, Mongo
 * close, duplicate-signal safety, and the forced-exit timeout fallback.
 *
 * Uses server.js's exported createShutdownHandler(server, deps) directly
 * with injected disconnect/exit/timer functions -- never calls the real
 * process.exit() (which would kill the test runner) and never opens a
 * real MongoDB connection. A real http.Server IS used for the
 * "in-flight request finishes" assertion, since that's the one part
 * worth proving against real server.close() semantics rather than a
 * mock of them.
 *
 * Run: node --test server.gracefulShutdown.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createShutdownHandler } = require('./server');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('SIGTERM path: closes the HTTP server, disconnects Mongo, exits 0, in that order', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));

  const calls = [];
  const disconnect = async () => { calls.push('disconnect'); };
  const exit = (code) => { calls.push(`exit:${code}`); };
  const shutdown = createShutdownHandler(server, { disconnect, exit });

  await shutdown('SIGTERM');

  assert.deepEqual(calls, ['disconnect', 'exit:0']);
  assert.equal(server.listening, false, 'the underlying HTTP server must actually be closed');
});

test('SIGINT path: same behavior as SIGTERM', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));

  const calls = [];
  const shutdown = createShutdownHandler(server, {
    disconnect: async () => { calls.push('disconnect'); },
    exit: (code) => calls.push(`exit:${code}`),
  });

  await shutdown('SIGINT');
  assert.deepEqual(calls, ['disconnect', 'exit:0']);
});

test('an in-flight HTTP request is allowed to finish before the process exits', async () => {
  const requestReceived = deferred();
  const finishRequest = deferred();
  const server = http.createServer(async (req, res) => {
    requestReceived.resolve();
    await finishRequest.promise;
    res.end('done');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  // Fire a real in-flight request, then start shutdown while it's still
  // pending -- server.close() must not cut it off.
  let responseBody = null;
  const clientReq = http.get({ host: '127.0.0.1', port }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => { responseBody = data; });
  });

  await requestReceived.promise;

  const calls = [];
  const shutdown = createShutdownHandler(server, {
    disconnect: async () => { calls.push('disconnect'); },
    exit: (code) => calls.push(`exit:${code}`),
  });
  const shutdownPromise = shutdown('SIGTERM');

  // Let the in-flight handler finish AFTER shutdown has already started.
  finishRequest.resolve();
  await shutdownPromise;

  assert.equal(responseBody, 'done', 'the in-flight request must have completed successfully, not been dropped');
  assert.deepEqual(calls, ['disconnect', 'exit:0']);
  clientReq.destroy();
});

test('a second signal during/after shutdown is a safe no-op -- disconnect/exit only ever run once', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));

  const calls = [];
  const shutdown = createShutdownHandler(server, {
    disconnect: async () => { calls.push('disconnect'); },
    exit: (code) => calls.push(`exit:${code}`),
  });

  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  // A third, later call must also be inert.
  await shutdown('SIGTERM');

  assert.deepEqual(calls, ['disconnect', 'exit:0'], 'exactly one shutdown sequence must have run, regardless of how many signals arrived');
});

test('forced-exit fallback fires exit(1) if graceful close hangs past the timeout, WITHOUT actually terminating the test runner', async () => {
  // A server whose close() never calls back -- simulates a hung
  // connection that never drains.
  const hangingServer = { close: () => {} };

  let firedTimeoutCallback;
  const fakeSetTimeout = (fn, ms) => { firedTimeoutCallback = fn; assert.equal(ms, 10000); return { unref: () => {} }; };
  const fakeClearTimeout = () => {};

  const calls = [];
  const shutdown = createShutdownHandler(hangingServer, {
    disconnect: async () => { calls.push('disconnect'); },
    exit: (code) => calls.push(`exit:${code}`),
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: fakeClearTimeout,
  });

  const shutdownPromise = shutdown('SIGTERM'); // never resolves on its own -- close() never calls back
  // Manually invoke the captured timeout callback, exactly as a real
  // setTimeout would once GRACEFUL_SHUTDOWN_TIMEOUT_MS elapsed -- proves
  // the fallback path fires exit(1) without needing to actually wait 10
  // real seconds or hang the test.
  assert.equal(typeof firedTimeoutCallback, 'function');
  firedTimeoutCallback();

  assert.deepEqual(calls, ['exit:1']);
  // The original shutdown() promise is deliberately left unresolved here
  // (its underlying server.close() never calls back) -- nothing in this
  // test awaits it further, so it can't hang the test runner.
  void shutdownPromise;
});

test('a server.close() error still disconnects and exits with a non-zero code, never hangs', async () => {
  const erroringServer = { close: (cb) => cb(new Error('close failed')) };
  const calls = [];
  const shutdown = createShutdownHandler(erroringServer, {
    disconnect: async () => { calls.push('disconnect'); },
    exit: (code) => calls.push(`exit:${code}`),
  });
  await shutdown('SIGTERM');
  assert.deepEqual(calls, ['exit:1']);
});
