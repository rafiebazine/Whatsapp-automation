const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { _private } = require('../electron/secure-fs');

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
      execFileSync: () => 'C:\\data DOMAIN\\user:(R)\n'
    }),
    (error) => error.code === 'acl_unverified'
  );
});

test('Windows ACL hardening verifies an explicit full-control grant', () => {
  let calls = 0;
  const result = _private.hardenWindowsAcl('C:\\data', {
    platform: 'win32',
    principal: '*S-1-5-21-3',
    cache: false,
    execFileSync: (command, args) => {
      calls += 1;
      if (command === 'icacls' && args.length === 1) {
        return 'C:\\data *S-1-5-21-3:(F)\n';
      }
      return '';
    }
  });
  assert.equal(result, 'C:\\data');
  assert.equal(calls, 2);
});

test('Windows ACL tests are skipped unless running on Windows for native checks', {
  skip: process.platform !== 'win32'
}, () => {
  assert.equal(process.platform, 'win32');
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
