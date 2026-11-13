(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WGMIdentity = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  function parsePhoneNumber(value, options = {}) {
    const text = asText(value);
    const result = {
      valid: false,
      canonical: '',
      digits: '',
      national: '',
      country: '',
      reason: '',
      ambiguous: false,
      assumedLocalZero: false
    };
    if (!text) {
      result.reason = 'empty';
      return result;
    }
    if (text.includes('@')) {
      result.reason = 'identity';
      return result;
    }
    const normalizedDigits = text.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
    if (!/^[+\d\s\-().]+$/.test(normalizedDigits)) {
      result.reason = 'invalid_characters';
      return result;
    }
    let cleaned = normalizedDigits.replace(/[\s\-().]/g, '');
    if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
    if (!/^\+?\d+$/.test(cleaned)) {
      result.reason = 'invalid_characters';
      return result;
    }
    if (cleaned.slice(1).includes('+')) {
      result.reason = 'invalid_characters';
      return result;
    }

    const explicitInternational = cleaned.startsWith('+');
    const digits = cleaned.replace(/\D/g, '');
    const algerianLocal = /^0([5-7]\d{8})$/.exec(digits);
    const algerianInternational = /^213([5-7]\d{8})$/.exec(digits);
    const bareDzMobile = /^([5-7]\d{8})$/.exec(digits);

    if (algerianLocal) {
      result.valid = true;
      result.country = 'DZ';
      result.digits = `213${algerianLocal[1]}`;
      result.canonical = `+${result.digits}`;
      result.national = digits;
      return result;
    }
    if (algerianInternational && (explicitInternational || digits.length === 12)) {
      result.valid = true;
      result.country = 'DZ';
      result.digits = digits;
      result.canonical = `+${digits}`;
      result.national = `0${algerianInternational[1]}`;
      return result;
    }
    if (!explicitInternational && digits.startsWith('0')) {
      result.reason = 'invalid_algerian';
      return result;
    }
    if ((explicitInternational || digits.startsWith('213')) && digits.startsWith('213')) {
      result.reason = 'invalid_algerian';
      return result;
    }
    if (!explicitInternational && bareDzMobile) {
      if (options.assumeAlgerianLocal) {
        result.valid = true;
        result.country = 'DZ';
        result.digits = `213${bareDzMobile[1]}`;
        result.canonical = `+${result.digits}`;
        result.national = `0${bareDzMobile[1]}`;
        result.assumedLocalZero = true;
        return result;
      }
      if (!options.allowAmbiguousBare) {
        result.ambiguous = true;
        result.reason = 'ambiguous';
        return result;
      }
    }

    if (digits.length < 8) {
      result.reason = 'too_short';
      return result;
    }
    if (digits.length > 15) {
      result.reason = 'too_long';
      return result;
    }
    result.valid = true;
    result.country = 'INTL';
    result.digits = digits;
    result.canonical = `+${digits}`;
    return result;
  }

  function phoneDigits(value) {
    const parsed = parsePhoneNumber(value, { allowAmbiguousBare: true });
    return parsed.valid ? parsed.digits : '';
  }

  function normalizePhone(value) {
    const parsed = parsePhoneNumber(value);
    return parsed.valid ? parsed.canonical : '';
  }

  function formatPhone(value) {
    const parsed = parsePhoneNumber(value, { allowAmbiguousBare: true });
    return parsed.valid ? parsed.canonical : '';
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

  function isUsableName(value) {
    const text = asText(value);
    if (!text) return false;
    if (text.includes('@')) return false;
    if (text.toLowerCase() === 'unknown contact') return false;
    if (/^\+?\d[\d\s\-().]*$/.test(text)) return false;
    return true;
  }

  function sanitizeContactName(value) {
    return isUsableName(value) ? asText(value) : '';
  }

  function getContactDisplayName(value, fallback = 'Unknown contact') {
    if (typeof value === 'string') {
      return sanitizeContactName(value) || fallback;
    }
    if (!value || typeof value !== 'object') return fallback;
    const candidates = [
      value.localName,
      value.name,
      value.displayName,
      value.participantName,
      value.notify,
      value.verifiedName
    ];
    for (const candidate of candidates) {
      const name = sanitizeContactName(candidate);
      if (name) return name;
    }
    return fallback;
  }

  function getParticipantIdentity(participant, fallback = {}) {
    return participantIdentity(participant, fallback);
  }

  function getMemberKey(value) {
    if (typeof value === 'string') {
      return normalizeJid(value) || jidFromPhone(value) || '';
    }
    const identity = participantIdentity(value, value);
    return identity.jid || identity.lid || identity.id || jidFromPhone(identity.phoneNumber) || '';
  }

  function hasActiveJobsForGroup(jobs, groupId) {
    if (!Array.isArray(jobs) || !groupId) return false;
    return jobs.some(
      (job) => job && job.groupId === groupId && (job.status === 'queued' || job.status === 'running')
    );
  }

  function mergeContactRecords(target, source) {
    if (!target || !source) return target;
    if (!target.id) target.id = source.id || '';
    if (!target.jid && source.jid) target.jid = source.jid;
    if (!target.lid && source.lid) target.lid = source.lid;
    if (!target.phoneNumber && source.phoneNumber) target.phoneNumber = source.phoneNumber;
    if (!target.localName && source.localName) target.localName = source.localName;
    if (!sanitizeContactName(target.name) && sanitizeContactName(source.name)) {
      target.name = sanitizeContactName(source.name);
    }
    if (!Array.isArray(target.sourceAccounts)) target.sourceAccounts = [];
    for (const accountId of source.sourceAccounts || []) {
      if (accountId && !target.sourceAccounts.includes(accountId)) target.sourceAccounts.push(accountId);
    }
    if (!Array.isArray(target.sourceTypes)) target.sourceTypes = [];
    for (const sourceType of source.sourceTypes || []) {
      if (sourceType && !target.sourceTypes.includes(sourceType)) target.sourceTypes.push(sourceType);
    }
    return target;
  }

  return {
    PN_DOMAIN,
    LID_DOMAIN,
    parseJid,
    normalizeJid,
    isPnJid,
    isLidJid,
    phoneDigits,
    parsePhoneNumber,
    normalizePhone,
    formatPhone,
    phoneFromJid,
    jidFromPhone,
    phoneToJid: jidFromPhone,
    participantIdentity,
    getParticipantIdentity,
    identityKeys,
    identityMatches,
    participantIsAdmin,
    participantIsSuperAdmin,
    normalizeAdminId,
    accountIsAdminOfGroup,
    preferredAccountJid,
    identitySummary,
    isUsableName,
    sanitizeContactName,
    getContactDisplayName,
    getMemberKey,
    hasActiveJobsForGroup,
    mergeContactRecords
  };
});
