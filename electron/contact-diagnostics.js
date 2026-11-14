const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  participantIdentity,
  identityKeys,
  isPnJid,
  isLidJid,
  sanitizeContactName
} = require('./identity');

const ENABLED = process.env.WGM_DIAGNOSTIC_CONTACTS === '1';
const FULL = ENABLED && process.env.WGM_DIAGNOSTIC_CONTACTS_FULL === '1';
const RAW_IDS = ENABLED && process.env.WGM_DIAGNOSTIC_CONTACTS_RAW_IDS === '1';
const REPORT_PATH = process.env.WGM_DIAGNOSTIC_REPORT
  || path.join(os.tmpdir(), 'wgm-contact-diagnostics.json');
const SAMPLE_LIMIT = FULL ? Number.POSITIVE_INFINITY : 20;
const STARTED_AT = new Date().toISOString();

function hashIdentifier(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function redactIdentifier(value) {
  if (!value) return '';
  const text = String(value);
  if (RAW_IDS) return text;
  if (text.includes('@')) {
    const [local, domain] = text.split('@');
    return `${hashIdentifier(local)}@${domain}`;
  }
  if (/^\d+$/.test(text)) return `phone:${hashIdentifier(text)}`;
  return hashIdentifier(text);
}

function redactContact(contact) {
  if (!contact || typeof contact !== 'object') return contact;
  if (RAW_IDS) return contact;
  const copy = { ...contact };
  for (const key of ['id', 'jid', 'lid', 'phoneNumber', 'newJid', 'oldJid', 'pnJid', 'lidJid']) {
    if (copy[key]) copy[key] = redactIdentifier(copy[key]);
  }
  return copy;
}

function identityView(identity) {
  return {
    id: redactIdentifier(identity.id),
    jid: redactIdentifier(identity.jid),
    lid: redactIdentifier(identity.lid),
    phoneNumber: redactIdentifier(identity.phoneNumber)
  };
}

function nameFields(contact) {
  return {
    name: sanitizeContactName(contact.name),
    notify: sanitizeContactName(contact.notify),
    verifiedName: sanitizeContactName(contact.verifiedName),
    username: sanitizeContactName(contact.username),
    displayName: sanitizeContactName(contact.displayName)
  };
}

function usableName(fields) {
  return fields.name || fields.notify || fields.verifiedName || fields.username || fields.displayName || '';
}

function createState() {
  return {
    eventCounts: {},
    sources: new Map(),
    records: new Set(),
    byKey: new Map(),
    outcomes: {},
    totals: {
      contactObjects: 0,
      writes: 0,
      persistedNames: 0,
      failedNames: 0,
      pushNames: 0
    },
    history: {
      events: 0,
      syncTypes: {},
      contacts: 0,
      chats: 0,
      userChats: 0,
      groupChats: 0,
      namedContacts: 0,
      unnamedContacts: 0
    },
    messages: {
      batches: 0,
      messages: 0,
      skippedFromMe: 0,
      withPushName: 0,
      existingContacts: 0,
      unknownContacts: 0
    },
    predicate: {
      calls: 0,
      allowed: 0,
      rejected: 0,
      types: {}
    },
    samples: {
      contacts: [],
      updates: [],
      history: [],
      chats: [],
      messages: [],
      writes: []
    }
  };
}

const state = createState();

function isEnabled() {
  return ENABLED;
}

function getSource(source) {
  if (!state.sources.has(source)) {
    state.sources.set(source, {
      events: 0,
      contacts: 0,
      named: 0,
      unnamed: 0,
      withPn: 0,
      withLid: 0,
      withBoth: 0,
      withNeither: 0,
      withPhone: 0,
      withPushName: 0
    });
  }
  return state.sources.get(source);
}

function pushSample(bucket, value) {
  const samples = state.samples[bucket];
  if (!samples || samples.length >= SAMPLE_LIMIT) return;
  samples.push(value);
}

function mergeRecord(target, source) {
  for (const key of source.keys) target.keys.add(key);
  if (!target.jid && source.jid) target.jid = source.jid;
  if (!target.lid && source.lid) target.lid = source.lid;
  if (!target.phoneNumber && source.phoneNumber) target.phoneNumber = source.phoneNumber;
  for (const [sourceName, name] of Object.entries(source.names)) {
    if (!target.names[sourceName] && name) target.names[sourceName] = name;
  }
  for (const name of source.pushNames) {
    if (!target.pushNames.includes(name)) target.pushNames.push(name);
  }
  if (!target.persistedName && source.persistedName) target.persistedName = source.persistedName;
  if (!target.persistedSource && source.persistedSource) target.persistedSource = source.persistedSource;
  if (!target.lastOutcome && source.lastOutcome) target.lastOutcome = source.lastOutcome;
  for (const sourceName of source.sources) target.sources.add(sourceName);
  target.observations += source.observations;
}

function trackIdentity(identity) {
  const keys = Array.from(identityKeys(identity));
  if (!keys.length) return null;
  if (!identity.jid && !identity.lid && !identity.phoneNumber) return null;

  const matches = new Set();
  for (const key of keys) {
    const existing = state.byKey.get(key);
    if (existing) matches.add(existing);
  }

  let record;
  if (matches.size === 0) {
    record = {
      keys: new Set(),
      jid: '',
      lid: '',
      phoneNumber: '',
      sources: new Set(),
      names: {},
      pushNames: [],
      persistedName: '',
      persistedSource: '',
      lastOutcome: '',
      observations: 0,
      lastSeen: ''
    };
    state.records.add(record);
  } else {
    const iterator = matches.values();
    record = iterator.next().value;
    for (const other of matches) {
      if (other === record) continue;
      mergeRecord(record, other);
      for (const key of other.keys) state.byKey.set(key, record);
      state.records.delete(other);
    }
  }

  for (const key of keys) {
    record.keys.add(key);
    state.byKey.set(key, record);
  }
  if (identity.jid) record.jid = identity.jid;
  if (identity.lid) record.lid = identity.lid;
  if (identity.phoneNumber) record.phoneNumber = identity.phoneNumber;
  record.observations += 1;
  record.lastSeen = new Date().toISOString();
  return record;
}

function observeContact(source, contact, previous) {
  const identity = participantIdentity(contact, contact);
  const fields = nameFields(contact);
  const name = usableName(fields);
  const stats = getSource(source);
  stats.contacts += 1;
  if (name) stats.named += 1;
  else stats.unnamed += 1;
  if (identity.jid) stats.withPn += 1;
  if (identity.lid) stats.withLid += 1;
  if (identity.jid && identity.lid) stats.withBoth += 1;
  if (!identity.jid && !identity.lid) stats.withNeither += 1;
  if (identity.phoneNumber || identity.jid) stats.withPhone += 1;
  const record = trackIdentity(identity);
  if (record) {
    record.sources.add(source);
    if (name) record.names[source] = name;
  }
  return {
    identity,
    fields,
    name,
    previous,
    record
  };
}

function recordContactBatch(source, contacts, db, event = source) {
  if (!ENABLED || !Array.isArray(contacts) || contacts.length === 0) return;
  const stats = getSource(source);
  stats.events += 1;
  state.eventCounts[event] = (state.eventCounts[event] || 0) + 1;
  for (const contact of contacts) {
    const previousContact = db && typeof db.findContact === 'function' ? db.findContact(contact) : null;
    const previousName = previousContact && db && typeof db.contactName === 'function'
      ? db.contactName(contact)
      : '';
    const observation = observeContact(source, contact, {
      name: previousName,
      nameSource: previousContact ? previousContact.nameSource : '',
      localName: previousContact ? previousContact.localName : ''
    });
    if (source === 'contacts.update') {
      pushSample('updates', {
        event,
        identity: identityView(observation.identity),
        fields: observation.fields,
        previous: observation.previous,
        persistedName: observation.record ? observation.record.persistedName : ''
      });
    } else {
      pushSample('contacts', {
        event,
        identity: identityView(observation.identity),
        fields: observation.fields,
        contact: redactContact(contact)
      });
    }
  }
  state.totals.contactObjects += contacts.length;
}

function recordHistory(data) {
  if (!ENABLED || !data || typeof data !== 'object') return;
  state.history.events += 1;
  const syncType = data.syncType === undefined || data.syncType === null ? 'unknown' : String(data.syncType);
  state.history.syncTypes[syncType] = (state.history.syncTypes[syncType] || 0) + 1;
  pushSample('history', {
    syncType,
    progress: data.progress,
    isLatest: data.isLatest,
    contacts: Array.isArray(data.contacts) ? data.contacts.length : 0,
    chats: Array.isArray(data.chats) ? data.chats.length : 0
  });
  if (Array.isArray(data.contacts) && data.contacts.length > 0) {
    state.history.contacts += data.contacts.length;
    for (const contact of data.contacts) {
      const fields = nameFields(contact);
      if (usableName(fields)) state.history.namedContacts += 1;
      else state.history.unnamedContacts += 1;
    }
    recordContactBatch('messaging-history.set.contacts', data.contacts, null, 'messaging-history.set');
  }
  if (Array.isArray(data.chats) && data.chats.length > 0) {
    state.history.chats += data.chats.length;
    getSource('messaging-history.set.chats').events += 1;
    for (const chat of data.chats) {
      const chatId = String(chat && chat.id ? chat.id : '');
      if (chatId.endsWith('@g.us')) {
        state.history.groupChats += 1;
        continue;
      }
      state.history.userChats += 1;
      const mapped = {
        id: chat.id,
        jid: chat.pnJid || (isPnJid(chat.id) ? chat.id : ''),
        lid: chat.lidJid || (isLidJid(chat.id) ? chat.id : ''),
        name: chat.name || chat.displayName,
        notify: chat.notify,
        verifiedName: chat.verifiedName
      };
      observeContact('messaging-history.set.chats', mapped, null);
      pushSample('chats', {
        syncType,
        chat: redactContact(chat),
        identity: identityView(participantIdentity(mapped, mapped))
      });
    }
  }
}

function recordHistoryPredicate(message) {
  if (!ENABLED) return;
  state.predicate.calls += 1;
  const syncType = message && message.syncType !== undefined ? String(message.syncType) : 'unknown';
  state.predicate.types[syncType] = (state.predicate.types[syncType] || 0) + 1;
  if (message && [0, 3, 4].includes(message.syncType)) state.predicate.allowed += 1;
  else state.predicate.rejected += 1;
}

function messageIdentity(key) {
  const remoteJid = key.remoteJid || '';
  const participant = key.participant || '';
  const inGroup = remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast');
  const primary = inGroup ? participant : remoteJid;
  const jid = key.participantPn
    || key.senderPn
    || (isPnJid(primary) ? primary : '')
    || (isPnJid(remoteJid) ? remoteJid : '');
  const lid = key.participantLid
    || key.senderLid
    || (isLidJid(primary) ? primary : '')
    || (isLidJid(remoteJid) ? remoteJid : '');
  const identity = participantIdentity({ id: primary || jid || lid, jid, lid }, {});
  if (!identity.id) return null;
  return identity;
}

function recordMessages(accountId, payload, db) {
  if (!ENABLED || !payload || !Array.isArray(payload.messages)) return;
  state.messages.batches += 1;
  for (const message of payload.messages) {
    state.messages.messages += 1;
    const key = message && message.key ? message.key : {};
    if (key.fromMe) {
      state.messages.skippedFromMe += 1;
      continue;
    }
    const identity = messageIdentity(key);
    if (!identity) continue;
    const pushName = sanitizeContactName(message.pushName);
    if (pushName) state.messages.withPushName += 1;
    const existing = db && typeof db.findContact === 'function' ? db.findContact(identity) : null;
    const currentName = existing && db && typeof db.contactName === 'function'
      ? db.contactName(identity)
      : '';
    if (existing) state.messages.existingContacts += 1;
    else state.messages.unknownContacts += 1;
    const record = trackIdentity(identity);
    if (record && pushName) {
      record.sources.add('messages.upsert');
      if (!record.pushNames.includes(pushName)) record.pushNames.push(pushName);
      state.totals.pushNames += 1;
    }
    pushSample('messages', {
      accountId,
      identity: identityView(identity),
      remoteJid: redactIdentifier(key.remoteJid),
      participant: redactIdentifier(key.participant),
      participantPn: redactIdentifier(key.participantPn),
      participantLid: redactIdentifier(key.participantLid),
      senderPn: redactIdentifier(key.senderPn),
      senderLid: redactIdentifier(key.senderLid),
      pushName,
      verifiedBizName: sanitizeContactName(message.verifiedBizName),
      existed: Boolean(existing),
      currentName,
      persisted: Boolean(pushName && currentName === pushName)
    });
  }
}

function recordWrite(details) {
  if (!ENABLED || !details) return;
  const incoming = sanitizeContactName(details.incomingName);
  const beforeName = sanitizeContactName(details.beforeName);
  const beforeDisplay = sanitizeContactName(details.beforeDisplayName);
  const afterName = sanitizeContactName(details.afterName);
  const afterDisplay = sanitizeContactName(details.afterDisplayName);
  const record = trackIdentity(details.identity);
  let outcome;
  if (!incoming) {
    outcome = 'empty_name';
  } else if (!details.afterName && !details.afterDisplayName) {
    outcome = 'no_contact';
  } else if (details.persisted) {
    outcome = beforeDisplay || beforeName ? 'stored_after_update' : 'stored_new';
  } else if (beforeDisplay && afterDisplay === beforeDisplay) {
    outcome = 'kept_existing';
  } else {
    outcome = 'not_stored';
  }
  state.totals.writes += 1;
  state.outcomes[outcome] = (state.outcomes[outcome] || 0) + 1;
  if (incoming) {
    if (details.persisted) state.totals.persistedNames += 1;
    else state.totals.failedNames += 1;
  }
  if (record) {
    record.sources.add(details.event);
    if (incoming) record.names[details.event] = incoming;
    record.persistedName = afterDisplay || afterName || record.persistedName;
    record.persistedSource = details.afterNameSource || record.persistedSource;
    record.lastOutcome = outcome;
  }
  pushSample('writes', {
    event: details.event,
    accountId: details.accountId,
    identity: identityView(details.identity),
    incomingName: incoming,
    incomingNameSource: details.incomingNameSource,
    beforeName,
    beforeDisplayName: beforeDisplay,
    beforeNameSource: details.beforeNameSource,
    afterName,
    afterDisplayName: afterDisplay,
    afterNameSource: details.afterNameSource,
    persisted: Boolean(details.persisted),
    outcome
  });
}

function identityHasName(record) {
  return Boolean(
    Object.values(record.names).some(Boolean)
    || record.pushNames.length
    || record.persistedName
  );
}

function buildReport() {
  const identities = Array.from(state.records).map((record) => ({
    keys: Array.from(record.keys).map(redactIdentifier),
    jid: redactIdentifier(record.jid),
    lid: redactIdentifier(record.lid),
    phoneNumber: redactIdentifier(record.phoneNumber),
    sources: Array.from(record.sources),
    names: { ...record.names },
    pushNames: record.pushNames.slice(0, 10),
    persistedName: record.persistedName,
    persistedSource: record.persistedSource,
    lastOutcome: record.lastOutcome,
    observations: record.observations,
    lastSeen: record.lastSeen
  }));
  const namedIdentities = identities.filter((record) => (
    Object.values(record.names).some(Boolean)
    || record.pushNames.length
    || record.persistedName
  )).length;
  const withPn = identities.filter((record) => Boolean(record.jid)).length;
  const withLid = identities.filter((record) => Boolean(record.lid)).length;
  const withPhone = identities.filter((record) => Boolean(record.phoneNumber)).length;
  const sources = {};
  for (const [source, stats] of state.sources.entries()) {
    sources[source] = { ...stats };
  }
  return {
    generatedAt: new Date().toISOString(),
    startedAt: STARTED_AT,
    durationMs: Date.now() - Date.parse(STARTED_AT),
    mode: {
      full: FULL,
      rawIds: RAW_IDS,
      reportPath: REPORT_PATH
    },
    totals: {
      ...state.totals,
      uniqueIdentities: identities.length,
      namedIdentities,
      unnamedIdentities: identities.length - namedIdentities,
      withPn,
      withLid,
      withPhone,
      withBothPnAndLid: identities.filter((record) => record.jid && record.lid).length,
      withNeitherPnNorLid: identities.filter((record) => !record.jid && !record.lid).length
    },
    eventCounts: { ...state.eventCounts },
    sources,
    outcomes: { ...state.outcomes },
    history: {
      ...state.history,
      syncTypes: { ...state.history.syncTypes }
    },
    messages: { ...state.messages },
    predicate: {
      ...state.predicate,
      types: { ...state.predicate.types }
    },
    samples: state.samples,
    identities
  };
}

function writeReport() {
  if (!ENABLED) return null;
  const report = buildReport();
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    const tempPath = `${REPORT_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(report, null, 2), 'utf8');
    fs.renameSync(tempPath, REPORT_PATH);
  } catch (error) {
    console.error('[CONTACT DIAGNOSTICS] Failed to write report:', error.message);
  }
  return report;
}

if (ENABLED) {
  const timer = setInterval(() => {
    const report = writeReport();
    if (!report) return;
    console.log('[CONTACT DIAGNOSTICS]', JSON.stringify({
      contacts: report.totals.contactObjects,
      unique: report.totals.uniqueIdentities,
      named: report.totals.namedIdentities,
      pushNames: report.totals.pushNames,
      persisted: report.totals.persistedNames,
      failed: report.totals.failedNames,
      history: report.history.events,
      messages: report.messages.messages
    }));
  }, 30000);
  if (typeof timer.unref === 'function') timer.unref();
  process.once('exit', () => {
    try {
      writeReport();
    } catch (error) {
      console.error('[CONTACT DIAGNOSTICS] Exit report failed:', error.message);
    }
  });
}

function resetForTests() {
  if (!ENABLED) return;
  const fresh = createState();
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
}

module.exports = {
  isEnabled,
  recordContactBatch,
  recordHistory,
  recordHistoryPredicate,
  recordMessages,
  recordWrite,
  buildReport,
  writeReport,
  resetForTests,
  _private: {
    redactIdentifier,
    identityView,
    nameFields,
    messageIdentity
  }
};