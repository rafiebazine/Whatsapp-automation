const {
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneFromJid,
  jidFromPhone,
  parsePhoneNumber,
  sanitizeContactName
} = require('./identity');

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
