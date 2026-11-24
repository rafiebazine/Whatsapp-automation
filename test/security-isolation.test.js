const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { SessionManager } = require('../electron/session-manager');

function managerFor(account) {
  const db = {
    data: { accounts: [account] },
    findAccount: (id) => (account.id === id ? account : null),
    save: () => {}
  };
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-isolation-sessions' });
  manager.setMasterKey(crypto.randomBytes(32));
  return manager;
}

test('rejects account session folders outside the sessions root', async () => {
  const manager = managerFor({
    id: 'acc_1',
    alias: 'One',
    authFolder: '../escape',
    status: 'disconnected'
  });
  await assert.rejects(manager.startAccount('acc_1'), /session folder is invalid/);
});

test('rejects account session folders that do not match the account id', async () => {
  const manager = managerFor({
    id: 'acc_1',
    alias: 'One',
    authFolder: 'acc_2',
    status: 'disconnected'
  });
  await assert.rejects(manager.startAccount('acc_1'), /session folder is invalid/);
});
