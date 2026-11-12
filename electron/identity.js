const PN_DOMAIN = 's.whatsapp.net';
const LID_DOMAIN = 'lid';

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseJid(value) {
  const text = asText(value);
  if (!text) return null;
  const at = text.indexOf('@');
  if (at < 1) return null;
  const server = text.slice(at + 1).toLowerCase();
  let user = text.slice(0, at);
  const device = user.indexOf(':');
  if (device >= 0) user = user.slice(0, device);
  const agent = user.indexOf('_');
  if (agent >= 0) user = user.slice(0, agent);
  if (!user) return null;
  return { user, server };
}

function normalizeJid(value) {
  const parsed = parseJid(value);
  if (!parsed) return '';
  const server = parsed.server === 'c.us' ? PN_DOMAIN : parsed.server;
  return `${parsed.user}@${server}`;
}

function isPnJid(value) {
  const parsed = parseJid(value);
  return Boolean(parsed && (parsed.server === PN_DOMAIN || parsed.server === 'c.us'));
}

function isLidJid(value) {
  const parsed = parseJid(value);
  return Boolean(parsed && parsed.server === LID_DOMAIN);
}

function phoneDigits(value) {
  const text = asText(value);
  if (!text || text.includes('@')) return '';
  if (!/^[+\d\s\-().]+$/.test(text)) return '';
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

function phoneFromJid(value) {
  if (!isPnJid(value)) return '';
  return phoneDigits(parseJid(value).user);
}

function jidFromPhone(value) {
  const text = asText(value);
  if (!text) return '';
  if (text.includes('@')) return isPnJid(text) ? normalizeJid(text) : '';
  const digits = phoneDigits(text);
  return digits ? `${digits}@${PN_DOMAIN}` : '';
}

function participantIdentity(participant, fallback = {}) {
  const source = participant || {};
  const previous = fallback || {};
  const rawId = source.id || previous.id;
  const rawJid = source.jid || previous.jid;
  const rawLid = source.lid || previous.lid;

  let id = normalizeJid(rawId);
  if (!id && rawId && !asText(rawId).includes('@')) id = jidFromPhone(rawId);

  let jid = isPnJid(rawJid) ? normalizeJid(rawJid) : '';
  if (!jid && isPnJid(rawId)) jid = normalizeJid(rawId);
  if (!jid && isPnJid(previous.jid)) jid = normalizeJid(previous.jid);
  if (!jid && isPnJid(previous.id)) jid = normalizeJid(previous.id);

  let lid = isLidJid(rawLid) ? normalizeJid(rawLid) : '';
  if (!lid && isLidJid(rawId)) lid = normalizeJid(rawId);
  if (!lid && isLidJid(previous.lid)) lid = normalizeJid(previous.lid);
  if (!lid && isLidJid(previous.id)) lid = normalizeJid(previous.id);

  let phoneNumber = phoneDigits(source.phoneNumber) || phoneDigits(previous.phoneNumber);
  if (!phoneNumber && jid) phoneNumber = phoneFromJid(jid);
  if (!jid && phoneNumber) jid = jidFromPhone(phoneNumber);

  if (!id) id = jid || lid;

  return { id, jid, lid, phoneNumber };
}

function identityKeys(value) {
  const keys = new Set();
  if (!value) return keys;

  if (typeof value === 'string') {
    const jid = normalizeJid(value) || jidFromPhone(value);
    if (jid) keys.add(jid);
    return keys;
  }

  const identity = participantIdentity(value, value);
  for (const candidate of [identity.id, identity.jid, identity.lid]) {
    const jid = normalizeJid(candidate);
    if (jid) keys.add(jid);
  }
  for (const candidate of [value.whatsappId, value.whatsappJid, value.whatsappLid]) {
    const jid = normalizeJid(candidate);
    if (jid) keys.add(jid);
  }
  const phoneJid = jidFromPhone(value.phoneNumber);
  if (phoneJid) keys.add(phoneJid);
  return keys;
}

function identityMatches(first, second) {
  const firstKeys = identityKeys(first);
  if (!firstKeys.size) return false;
  const secondKeys = identityKeys(second);
  for (const key of secondKeys) {
    if (firstKeys.has(key)) return true;
  }
  return false;
}

function participantIsAdmin(participant) {
  if (!participant) return false;
  return Boolean(
    participant.isAdmin ||
    participant.isSuperAdmin ||
    participant.admin === 'admin' ||
    participant.admin === 'superadmin'
  );
}

function participantIsSuperAdmin(participant) {
  if (!participant) return false;
  return Boolean(participant.isSuperAdmin || participant.admin === 'superadmin');
}

function normalizeAdminId(value) {
  const text = asText(value);
  if (!text) return '';
  if (text.includes('@')) return normalizeJid(text);
  return jidFromPhone(text);
}

function accountIsAdminOfGroup(account, group) {
  if (!account || !group) return false;
  if (Array.isArray(group.adminAccountIds) && group.adminAccountIds.includes(account.id)) return true;

  const accountKeys = identityKeys(account);
  for (const adminId of group.adminIds || []) {
    const normalized = normalizeAdminId(adminId);
    if (normalized && accountKeys.has(normalized)) return true;
  }
  for (const member of group.members || []) {
    if (member.isAdmin && identityMatches(account, member)) return true;
  }
  return false;
}

function preferredAccountJid(account, group) {
  if (!account) return '';
  const addressingMode = group && group.addressingMode;
  if (addressingMode === 'lid' && isLidJid(account.whatsappLid)) {
    return normalizeJid(account.whatsappLid);
  }
  if (isPnJid(account.whatsappJid)) return normalizeJid(account.whatsappJid);
  if (isPnJid(account.whatsappId) || isLidJid(account.whatsappId)) return normalizeJid(account.whatsappId);
  if (isLidJid(account.whatsappLid)) return normalizeJid(account.whatsappLid);
  return jidFromPhone(account.phoneNumber);
}

function identitySummary(value) {
  const identity = participantIdentity(value, value);
  const whatsappId = normalizeJid(value && value.whatsappId);
  const whatsappJid = normalizeJid(value && value.whatsappJid);
  const whatsappLid = normalizeJid(value && value.whatsappLid);
  const jid = identity.jid || whatsappJid || (isPnJid(whatsappId) ? whatsappId : '');
  const lid = identity.lid || whatsappLid || (isLidJid(whatsappId) ? whatsappId : '');
  return {
    id: identity.id || whatsappId || jid || lid,
    jid,
    lid,
    phoneNumber: identity.phoneNumber || phoneDigits(value && value.phoneNumber) || phoneFromJid(jid)
  };
}

module.exports = {
  PN_DOMAIN,
  LID_DOMAIN,
  parseJid,
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneDigits,
  phoneFromJid,
  jidFromPhone,
  phoneToJid: jidFromPhone,
  participantIdentity,
  identityKeys,
  identityMatches,
  participantIsAdmin,
  participantIsSuperAdmin,
  normalizeAdminId,
  accountIsAdminOfGroup,
  preferredAccountJid,
  identitySummary
};
