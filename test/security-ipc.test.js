const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function channelsIn(file, marker) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const start = source.indexOf(marker);
  const end = source.indexOf(']);', start);
  const block = source.slice(start, end);
  return new Set(Array.from(block.matchAll(/'([^']+)'/g), (match) => match[1]));
}

test('preload invoke whitelist matches every main-process handler', () => {
  const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const handlers = new Set(Array.from(main.matchAll(/handle\('([^']+)'/g), (match) => match[1]));
  const preload = channelsIn('electron/preload.js', 'const INVOKE_CHANNELS = new Set([');
  assert.deepEqual([...handlers].sort(), [...preload].sort());
});

test('preload event whitelist covers every broadcast event used by the renderer', () => {
  const preload = channelsIn('electron/preload.js', 'const EVENT_CHANNELS = new Set([');
  for (const channel of [
    'accounts:update',
    'groups:update',
    'jobs:update',
    'contacts:update',
    'qr:update',
    'toast',
    'auth:changed',
    'auth:idleWarning',
    'settings:update'
  ]) {
    assert.ok(preload.has(channel), `missing ${channel}`);
  }
});
