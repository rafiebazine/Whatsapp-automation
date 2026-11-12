const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTimeout } = require('../electron/lifecycle');

test('runWithTimeout resolves after the task completes', async () => {
  let timedOut = false;
  const result = await runWithTimeout(
    () => new Promise((resolve) => setTimeout(resolve, 5)),
    100,
    () => { timedOut = true; }
  );

  assert.deepEqual(result, { timedOut: false });
  assert.equal(timedOut, false);
});

test('runWithTimeout reports a timeout and invokes the callback', async () => {
  let timedOut = false;
  const result = await runWithTimeout(
    () => new Promise(() => {}),
    10,
    () => { timedOut = true; }
  );

  assert.equal(result.timedOut, true);
  assert.equal(timedOut, true);
});

test('runWithTimeout returns task errors without throwing', async () => {
  const error = new Error('boom');
  const result = await runWithTimeout(() => Promise.reject(error), 100);

  assert.equal(result.timedOut, false);
  assert.equal(result.error, error);
});
