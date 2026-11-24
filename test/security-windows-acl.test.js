const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { _private, writeFileAtomicPrivate } = require('../electron/secure-fs');
const { migrateEncryptedAuthState, _private: authPrivate } = require('../electron/auth-store');

function aclFor(target, principal) {
  return [
    `${target} ${principal}:(F)`,
    'NT AUTHORITY\\SYSTEM:(F)',
    'BUILTIN\\Administrators:(F)',
    ''
  ].join('\n');
}

function fakeAclExec(principal) {
  return (command, args) => {
    if (command !== 'icacls') return '';
    if (args.length === 1) return aclFor(args[0], principal);
    return '';
  };
}

test('Windows ACL hardening fails closed when icacls cannot grant access', () => {
  assert.throws(
    () => _private.hardenWindowsAcl(path.join(__dirname, 'fake-acl-target'), {
      platform: 'win32',
      principal: '*S-1-5-21-1',
      execFileSync: () => {
        throw new Error('access denied');
      }
    }),
    (error) => error.code === 'acl_failed'
  );
});

test('Windows ACL hardening fails closed when verification fails', () => {
  let calls = 0;
  assert.throws(
    () => _private.hardenWindowsAcl(path.join(__dirname, 'fake-acl-target-2'), {
      platform: 'win32',
      principal: '*S-1-5-21-2',
      execFileSync: () => {
        calls += 1;
        if (calls === 1) return '';
        throw new Error('icacls unavailable');
      }
    }),
    (error) => error.code === 'acl_verification_failed'
  );
});

test('Windows ACL verification rejects inherited entries and missing full control', () => {
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      execFileSync: () => 'C:\\data BUILTIN\\Users:(I)(RX)\n'
    }),
    (error) => error.code === 'acl_inherited'
  );
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: 'DOMAIN\\user',
      execFileSync: () => 'C:\\data DOMAIN\\user:(R)\n'
    }),
    (error) => error.code === 'acl_unverified'
  );
});

test('Windows ACL hardening verifies an explicit full-control grant', () => {
  let calls = 0;
  const principal = '*S-1-5-21-3';
  const exec = (command, args) => {
    calls += 1;
    return fakeAclExec(principal)(command, args);
  };
  const result = _private.hardenWindowsAcl('C:\\data', {
    platform: 'win32',
    principal,
    execFileSync: exec
  });
  assert.equal(result, 'C:\\data');
  assert.equal(calls, 2);
});

test('Windows ACL verification rejects broader full-control principals', () => {
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: '*S-1-5-21-4',
      execFileSync: () => 'C:\\data Everyone:(F)\n'
    }),
    (error) => error.code === 'acl_unexpected_principal'
  );
});

test('Windows ACL verification uses exact principal matching', () => {
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: 'DOMAIN\\user',
      execFileSync: () => aclFor('C:\\data', 'DOMAIN\\user2')
    }),
    (error) => error.code === 'acl_unexpected_principal'
  );
});

test('Windows ACL verification rejects rights beyond full control', () => {
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: 'DOMAIN\\user',
      execFileSync: () => 'C:\\data DOMAIN\\user:(M)\n'
    }),
    (error) => error.code === 'acl_unverified'
  );
});

test('Windows ACL verification fails closed on empty or unparsable output', () => {
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: 'DOMAIN\\user',
      execFileSync: () => ''
    }),
    (error) => error.code === 'acl_unverified'
  );
  assert.throws(
    () => _private.verifyWindowsAcl('C:\\data', {
      principal: 'DOMAIN\\user',
      execFileSync: () => 'Successfully processed file.\n'
    }),
    (error) => error.code === 'acl_unverified'
  );
});

test('temporary files are ACL-hardened before bytes are written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-acl-order-'));
  const principal = '*S-1-5-21-9';
  const options = {
    platform: 'win32',
    principal,
    root: dir,
    execFileSync: fakeAclExec(principal)
  };
  let verified = false;
  let wrote = false;
  const original = fs.writeFileSync;
  mock.method(fs, 'writeFileSync', (...args) => {
    assert.equal(verified, true);
    wrote = true;
    return original(...args);
  });
  try {
    writeFileAtomicPrivate(path.join(dir, 'auth.enc'), 'secret', 'utf8', {
      ...options,
      onTempReady: (tmp) => {
        _private.verifyWindowsAcl(tmp, options);
        verified = true;
      }
    });
    assert.equal(wrote, true);
  } finally {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.platform === 'win32') {
  test('native Windows atomic writes have restrictive ACLs and no temp leftovers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-winacl-'));
    try {
      const file = path.join(dir, 'state.json');
      writeFileAtomicPrivate(file, 'secret', 'utf8', { root: dir });
      assert.deepEqual(fs.readdirSync(dir), ['state.json']);
      const output = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
      const entries = _private.parseWindowsAclEntries(output, file);
      assert.ok(entries.length > 0);
      for (const entry of entries) {
        assert.equal(entry.rights.includes('I'), false);
        assert.deepEqual(entry.rights, ['F']);
      }
      _private.verifyWindowsAcl(file, { root: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('native Windows temp files are verified before encrypted bytes are written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-winorder-'));
    let verified = false;
    let wrote = false;
    const original = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (...args) => {
      assert.equal(verified, true);
      wrote = true;
      return original(...args);
    });
    try {
      writeFileAtomicPrivate(path.join(dir, 'auth.enc'), 'secret', 'utf8', {
        root: dir,
        onTempReady: (tmp) => {
          _private.verifyWindowsAcl(tmp, { root: dir });
          verified = true;
        }
      });
      assert.equal(wrote, true);
    } finally {
      mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('native Windows auth-state migration preserves restrictive ACLs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-winmigrate-'));
    try {
      const accountId = 'acc_winacl';
      const oldMasterKey = crypto.randomBytes(32);
      const newMasterKey = crypto.randomBytes(32);
      const BufferJSON = { replacer: null, reviver: null };
      const payload = authPrivate.encryptJson(
        { creds: {}, keys: {} },
        authPrivate.authKey(oldMasterKey, accountId),
        BufferJSON,
        accountId
      );
      const file = path.join(dir, 'auth.enc');
      writeFileAtomicPrivate(file, JSON.stringify(payload), 'utf8', { root: dir });
      const changed = await migrateEncryptedAuthState(dir, oldMasterKey, newMasterKey, accountId, {
        root: dir,
        loadBaileys: async () => ({ BufferJSON })
      });
      assert.equal(changed, true);
      const output = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
      const entries = _private.parseWindowsAclEntries(output, file);
      assert.ok(entries.length > 0);
      for (const entry of entries) {
        assert.equal(entry.rights.includes('I'), false);
        assert.deepEqual(entry.rights, ['F']);
      }
      _private.verifyWindowsAcl(file, { root: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
