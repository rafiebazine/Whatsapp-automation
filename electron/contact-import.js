const {
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneFromJid,
  jidFromPhone,
  parsePhoneNumber,
  sanitizeContactName
} = require('./identity');

const MAX_ROW_KEYS = 10;
const MAX_FIELD_CHARS = 1000;

function invalidImportRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  const keys = Object.keys(row);
  if (keys.length > MAX_ROW_KEYS) return true;
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) return true;
    if (typeof value === 'object' || typeof value === 'function') return true;
    if (typeof value === 'number' && !Number.isFinite(value)) return true;
  }
  return false;
}

function normalizeImportRow(row) {
  if (!row || typeof row !== 'object') return null;
  const rawJid = normalizeJid(row.jid || '');
  const rawNumber = String(row.number || row.phoneNumber || '').trim();
  const numberJid = rawNumber.includes('@') ? normalizeJid(rawNumber) : '';
  const jid = isPnJid(rawJid) || isLidJid(rawJid)
    ? rawJid
    : (isPnJid(numberJid) || isLidJid(numberJid) ? numberJid : '');

  if (!jid) {
    const parsed = parsePhoneNumber(rawNumber);
    if (!parsed.valid) return null;
    const phoneJid = jidFromPhone(parsed.canonical);
    return {
      identity: { id: phoneJid, jid: phoneJid, lid: '', phoneNumber: parsed.digits },
      name: sanitizeContactName(row.name)
    };
  }

  if (isLidJid(jid)) {
    return {
      identity: { id: jid, jid: '', lid: jid, phoneNumber: '' },
      name: sanitizeContactName(row.name)
    };
  }

  return {
    identity: { id: jid, jid, lid: '', phoneNumber: phoneFromJid(jid) },
    name: sanitizeContactName(row.name)
  };
}

function importContacts(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const contacts = [];
  const seen = new Set();
  const result = {
    processed: list.length,
    imported: 0,
    named: 0,
    unnamed: 0,
    skipped: 0,
    contacts
  };

  for (const row of list) {
    if (invalidImportRow(row)) {
      result.skipped += 1;
      continue;
    }
    const normalized = normalizeImportRow(row);
    if (!normalized) {
      result.skipped += 1;
      continue;
    }
    const contact = db.upsertContactIdentity(
      normalized.identity,
      normalized.name,
      null,
      'import',
      'local'
    );
    if (!contact) {
      result.skipped += 1;
      continue;
    }
    result.imported += 1;
    if (normalized.name) result.named += 1;
    else result.unnamed += 1;
    if (!seen.has(contact)) {
      seen.add(contact);
      contacts.push(contact);
    }
  }

  return result;
}

module.exports = { importContacts, normalizeImportRow };
