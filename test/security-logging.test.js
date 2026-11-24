const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../electron/contact-diagnostics');
const { friendlyError } = require('../electron/session-manager');

test('diagnostics redact identifiers and names by default', () => {
  const { redactIdentifier, redactName, identityView } = diagnostics._private;
  const jid = '213555123456@s.whatsapp.net';
  const name = 'Amina Bensalem';
  const redactedJid = redactIdentifier(jid);
  const redactedName = redactName(name);
  assert.ok(redactedJid && !redactedJid.includes('213555123456'));
  assert.ok(redactedName && !redactedName.includes(name));
  const view = identityView({ id: jid, jid, lid: '999@lid', phoneNumber: '213555123456' });
  assert.ok(!JSON.stringify(view).includes('213555123456'));
  assert.ok(!JSON.stringify(view).includes('999@lid'));
});

test('friendly errors remove WhatsApp identities', () => {
  const message = friendlyError(new Error('failed for 213555123456@s.whatsapp.net and 999@lid'));
  assert.ok(!message.includes('213555123456'));
  assert.ok(!message.includes('999@lid'));
});
