const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  dailyCap: 20,
  minDelaySeconds: 25,
  maxDelaySeconds: 90,
  batchSize: 5,
  batchPauseMinSeconds: 180,
  batchPauseMaxSeconds: 360,
  quietStart: '23:00',
  quietEnd: '07:00',
  failurePauseThreshold: 3,
  maxAccounts: 4
};

function defaultData() {
  return {
    version: 1,
    auth: null,
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
    groups: [],
    contacts: [],
    jobs: [],
    logs: []
  };
}

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaultData();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = {
          ...defaultData(),
          ...parsed,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
          contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
          jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
          logs: Array.isArray(parsed.logs) ? parsed.logs : []
        };
      } else {
        this.save();
      }
    } catch (error) {
      console.error('Failed to load local database:', error);
      this.data = defaultData();
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.error('Failed to save local database:', error);
    }
  }

  todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  resetDailyCounters() {
    const today = this.todayKey();
    let changed = false;
    for (const account of this.data.accounts) {
      if (account.dailyActionDate !== today) {
        account.dailyActionDate = today;
        account.dailyActionCount = 0;
        account.dailyActionLimit = this.data.settings.dailyCap;
        account.pausedForDay = null;
        account.consecutiveFailures = 0;
        account.batchCount = 0;
        account.batchPauseUntil = 0;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  addAccount(alias) {
    const id = `acc_${crypto.randomUUID()}`;
    const today = this.todayKey();
    const account = {
      id,
      alias,
      phoneNumber: '',
      authFolder: id,
      status: 'disconnected',
      dailyActionCount: 0,
      dailyActionDate: today,
      dailyActionLimit: this.data.settings.dailyCap,
      lastActiveAt: null,
      connectedAt: null,
      createdAt: new Date().toISOString(),
      needsRelink: false,
      pendingOnboarding: true,
      onboardingError: null,
      qr: null,
      consecutiveFailures: 0,
      pausedForDay: null,
      batchCount: 0,
      batchPauseUntil: 0,
      lastActionAt: 0
    };
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  findAccount(id) {
    return this.data.accounts.find((account) => account.id === id);
  }

  findGroup(id) {
    return this.data.groups.find((group) => group.id === id);
  }

  findJob(id) {
    return this.data.jobs.find((job) => job.id === id);
  }

  addLog(entry) {
    this.data.logs.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
    if (this.data.logs.length > 5000) {
      this.data.logs.splice(0, this.data.logs.length - 5000);
    }
  }

  upsertContact(phoneNumber, name, accountId) {
    if (!phoneNumber || phoneNumber.length < 6) return;
    const cleanName = (name || '').trim();
    let contact = this.data.contacts.find((item) => item.phoneNumber === phoneNumber);
    if (!contact) {
      contact = {
        phoneNumber,
        name: cleanName,
        sourceAccounts: accountId ? [accountId] : [],
        lastSyncedAt: new Date().toISOString()
      };
      this.data.contacts.push(contact);
    } else {
      if (cleanName && (!contact.name || /^\+?\d+$/.test(contact.name))) {
        contact.name = cleanName;
      }
      if (accountId && !contact.sourceAccounts.includes(accountId)) {
        contact.sourceAccounts.push(accountId);
      }
      contact.lastSyncedAt = new Date().toISOString();
    }
  }

  contactName(phoneNumber) {
    const contact = this.data.contacts.find((item) => item.phoneNumber === phoneNumber);
    return contact && contact.name ? contact.name : '';
  }
}

module.exports = { Database, DEFAULT_SETTINGS };
