const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAYLOAD_CHARS = 40;
const PREFIX = 'WGM';
const GROUP_SIZE = 5;

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function generateRecoveryCode() {
  const payload = encodeBase32(crypto.randomBytes(25)).slice(0, PAYLOAD_CHARS);
  const groups = [];
  for (let index = 0; index < payload.length; index += GROUP_SIZE) {
    groups.push(payload.slice(index, index + GROUP_SIZE));
  }
  return `${PREFIX}-${groups.join('-')}`;
}

function normalizeRecoveryCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  const payload = raw.length === PAYLOAD_CHARS + PREFIX.length && raw.startsWith(PREFIX)
    ? raw.slice(PREFIX.length)
    : raw;
  if (payload.length !== PAYLOAD_CHARS) return '';
  let normalized = '';
  for (const character of payload) {
    if (character === 'O') normalized += '0';
    else if (character === 'I' || character === 'L') normalized += '1';
    else if (ALPHABET.includes(character)) normalized += character;
    else return '';
  }
  return normalized;
}

function isValidRecoveryCode(value) {
  return Boolean(normalizeRecoveryCode(value));
}

module.exports = {
  ALPHABET,
  PAYLOAD_CHARS,
  generateRecoveryCode,
  normalizeRecoveryCode,
  isValidRecoveryCode
};
