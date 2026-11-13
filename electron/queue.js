const crypto = require('crypto');
const { EventEmitter } = require('events');
const { friendlyError } = require('./session-manager');
const {
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneFromJid,
  jidFromPhone,
  parsePhoneNumber,
  identityKeys,
  formatPhone,
  sanitizeContactName
} = require('./identity');

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const FINISHED_TARGET = new Set(['success', 'failed', 'skipped']);

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

function normalizeTarget(raw) {
  if (raw === null || raw === undefined) return null;
  let value = raw;
  let name = '';
  if (typeof raw === 'object') {
    value = raw.jid || raw.id || raw.number;
    name = sanitizeContactName(raw.displayName) || sanitizeContactName(raw.name);
  }
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;
  if (text.includes('@')) {
    const jid = normalizeJid(text);
    if (!isPnJid(jid) && !isLidJid(jid)) return null;
    const phoneNumber = phoneFromJid(jid);
    return {
      jid,
      phoneNumber,
      number: phoneNumber ? formatPhone(phoneNumber) : jid,
      name,
      displayName: name || formatPhone(phoneNumber) || 'Unknown contact',
      key: jid
    };
  }
  const parsed = parsePhoneNumber(text);
  if (!parsed.valid) return null;
  const phone = parsed.canonical;
  const jid = jidFromPhone(phone);
  const phoneNumber = parsed.digits;
  return {
    jid,
    phoneNumber,
    number: phone,
    name,
    displayName: name || phone,
    key: jid || phone
  };
}

function targetKey(target) {
  if (!target) return '';
  const raw = typeof target === 'string'
    ? target
    : (target.jid || target.number || target.id);
  const normalized = normalizeTarget(raw);
  return normalized ? normalized.key : String(raw || '');
}

function memberKeysFor(group) {
  const keys = new Set();
  for (const member of group.members || []) {
    for (const key of identityKeys(member)) keys.add(key);
  }
  return keys;
}

class QueueManager extends EventEmitter {
  constructor({ db, sessions }) {
    super();
    this.db = db;
    this.sessions = sessions;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.nextAllowedAt = 0;
    this.jobCursor = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resetInterruptedWork();
    this.tickSoon(300);
  }

  pause() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  kick() {
    if (!this.running) return;
    this.tickSoon(250);
  }

  resetInterruptedWork() {
    let changed = false;
    for (const job of this.db.data.jobs) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      for (const target of job.targets || []) {
        if (target.status === 'running') {
          target.status = 'pending';
          target.error = null;
          changed = true;
        }
      }
      if (job.status === 'running') {
        job.status = 'queued';
        changed = true;
      }
    }
    if (changed) this.db.save();
  }

  tickSoon(ms) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((error) => {
        console.error('Queue tick failed:', error);
        this.tickSoon(5000);
      });
    }, Math.max(100, ms));
  }

  getSettings() {
    return this.db.data.settings;
  }

  isQuiet(now = new Date()) {
    const settings = this.getSettings();
    const start = parseClock(settings.quietStart, 23 * 60);
    const end = parseClock(settings.quietEnd, 7 * 60);
    if (start === end) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
  }

  quietWaitMs(now = new Date()) {
    const settings = this.getSettings();
    const end = parseClock(settings.quietEnd, 7 * 60);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const endDate = new Date(now);
    endDate.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (endDate <= now) endDate.setDate(endDate.getDate() + 1);
    return Math.max(1000, endDate.getTime() - now.getTime() + 2000);
  }

  activeJobs() {
    return this.db.data.jobs
      .filter((job) => !job.dismissed && ACTIVE_STATUSES.has(job.status))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  getEligibleAccounts(group, now) {
    const today = this.db.todayKey();
    const settings = this.getSettings();
    return this.db.data.accounts
      .filter((account) => {
        if (account.needsRelink) return false;
        if (account.status !== 'connected') return false;
        if (!this.sessions.isConnected(account.id)) return false;
        if (account.pausedForDay === today) return false;
        if (account.dailyActionCount >= settings.dailyCap) return false;
        if ((account.batchPauseUntil || 0) > now) return false;
        if (!this.sessions.isVerifiedAdminOf(account, group)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.dailyActionCount !== b.dailyActionCount) return a.dailyActionCount - b.dailyActionCount;
        return (a.lastActionAt || 0) - (b.lastActionAt || 0);
      });
  }

  blockedReasonFor(group, now) {
    const today = this.db.todayKey();
    const settings = this.getSettings();
    const connectedAdmins = this.db.data.accounts.filter((account) => {
      if (account.status !== 'connected' || account.needsRelink) return false;
      if (!this.sessions.isConnected(account.id)) return false;
      return this.sessions.isVerifiedAdminOf(account, group);
    });
    if (connectedAdmins.length === 0) {
      const anyAdminAccount = this.db.data.accounts.some(
        (account) => (group.adminAccountIds || []).includes(account.id) || this.sessions.isVerifiedAdminOf(account, group)
      );
      return anyAdminAccount
        ? 'No admin account for this group is currently connected.'
        : 'No linked account is an admin of this group.';
    }
    if (connectedAdmins.every((account) => account.pausedForDay === today)) {
      return 'All admin accounts for this group are paused for today.';
    }
    if (connectedAdmins.every((account) => account.dailyActionCount >= settings.dailyCap)) {
      return 'Daily action limit reached for every admin account. Work resumes tomorrow.';
    }
    if (connectedAdmins.every((account) => (account.batchPauseUntil || 0) > now)) {
      return 'Admin accounts are in a scheduled cooldown. Work resumes shortly.';
    }
    return 'Waiting for an eligible admin account.';
  }

  nextAction() {
    const now = Date.now();
    const jobs = this.activeJobs();
    if (jobs.length === 0) return { idle: true, waitMs: 3000 };
    if (this.isQuiet()) {
      return {
        waitMs: this.quietWaitMs(),
        blockedReason: `Quiet hours until ${this.getSettings().quietEnd}.`,
        quiet: true
      };
    }
    if (now < this.nextAllowedAt) {
      return { waitMs: this.nextAllowedAt - now };
    }
    for (let offset = 0; offset < jobs.length; offset += 1) {
      const index = (this.jobCursor + offset) % jobs.length;
      const job = jobs[index];
      const group = this.db.findGroup(job.groupId);
      if (!group) continue;
      const target = (job.targets || []).find((item) => item.status === 'pending');
      if (!target) continue;
      const eligible = this.getEligibleAccounts(group, now);
      if (eligible.length > 0) {
        const account = eligible[0];
        return { job, target, account, jobIndex: index, group };
      }
    }
    const firstJob = jobs[0];
    const firstGroup = this.db.findGroup(firstJob.groupId);
    return {
      waitMs: 15000,
      blockedReason: firstGroup ? this.blockedReasonFor(firstGroup, now) : 'Waiting for group data.'
    };
  }

  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      this.db.resetDailyCounters();
      for (const account of this.db.data.accounts) {
        if (account.status === 'paused' && !account.pausedForDay && this.sessions.isConnected(account.id)) {
          account.status = 'connected';
        }
      }
      const decision = this.nextAction();
      if (decision.idle) {
        this.tickSoon(decision.waitMs);
        return;
      }
      if (!decision.job) {
        this.applyBlockedReason(decision.blockedReason);
        this.tickSoon(decision.waitMs);
        return;
      }
      this.applyBlockedReason(null);
      this.jobCursor = (decision.jobIndex + 1) % Math.max(1, this.activeJobs().length);
      await this.execute(decision.job, decision.target, decision.account, decision.group);
      const settings = this.getSettings();
      const delay = randomBetween(settings.minDelaySeconds, settings.maxDelaySeconds) * 1000;
      this.nextAllowedAt = Date.now() + delay;
      this.tickSoon(delay);
    } finally {
      this.busy = false;
    }
  }

  applyBlockedReason(reason) {
    let changed = false;
    for (const job of this.activeJobs()) {
      if ((job.blockedReason || null) !== (reason || null)) {
        job.blockedReason = reason || null;
        changed = true;
      }
    }
    if (changed) {
      this.db.save();
      this.emitJobs();
    }
  }

  classifyResult(result, type) {
    const rawStatus = result && result.status;
    const status = Number(rawStatus);
    if (!Number.isFinite(status)) {
      return { status: 'failed', error: `WhatsApp returned status ${rawStatus}.` };
    }
    if (status === 200) {
      return { status: 'success', error: null };
    }
    if (type === 'add' && status === 409) {
      return { status: 'skipped', error: 'Already in the group.' };
    }
    if (type === 'remove' && (status === 404 || status === 409)) {
      return { status: 'skipped', error: 'No longer in the group.' };
    }
    if (status === 403) {
      return {
        status: 'failed',
        error: 'WhatsApp privacy settings prevent this action for this number.'
      };
    }
    if (status === 408) {
      return { status: 'failed', error: 'This number is not on WhatsApp.' };
    }
    if (status === 404) {
      return { status: 'failed', error: 'Number not found on WhatsApp.' };
    }
    if (status === 500) {
      return { status: 'failed', error: 'WhatsApp rejected the request.' };
    }
    return { status: 'failed', error: `WhatsApp returned status ${status}.` };
  }

  isRetryableError(error) {
    const message = ((error && error.message) || '').toLowerCase();
    return (
      message.includes('timed out') ||
      message.includes('connection closed') ||
      message.includes('rate-overlimit') ||
      message.includes('rate limit') ||
      message.includes('service unavailable') ||
      message.includes('internal server') ||
      message.includes('socket')
    );
  }

  isAdminBlockError(error) {
    return Boolean(error && error.code === 'admin_unverified');
  }

  isProtectedTargetError(error) {
    return Boolean(error && error.code === 'protected_admin_target');
  }

  async execute(job, target, account, group) {
    const settings = this.getSettings();
    const today = this.db.todayKey();
    target.status = 'running';
    target.attempts = (target.attempts || 0) + 1;
    job.status = 'running';
    if (!job.startedAt) job.startedAt = new Date().toISOString();
    job.blockedReason = null;
    let localBlock = false;
    this.db.save();
    this.emitJobs();

    try {
      const results = await this.sessions.sendAction(
        account.id,
        group.id,
        [target],
        job.type === 'add' ? 'add' : 'remove'
      );
      if (!Array.isArray(results) || results.length === 0) {
        throw new Error('WhatsApp returned no confirmation for this action.');
      }
      const outcome = this.classifyResult(results[0], job.type);
      target.status = outcome.status;
      target.error = outcome.error;
      target.accountId = account.id;
      target.processedAt = new Date().toISOString();
      account.dailyActionCount += 1;
      account.dailyActionLimit = settings.dailyCap;
      account.lastActionAt = Date.now();
      account.lastActiveAt = new Date().toISOString();
      if (outcome.status === 'failed') {
        account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
      } else {
        account.consecutiveFailures = 0;
      }
      this.db.addLog({
        jobId: job.id,
        numberOrAction: target.displayName || target.name || target.number,
        accountUsed: account.alias,
        result: outcome.status === 'success' ? 'success' : outcome.status,
        errorMessage: outcome.error || null
      });
    } catch (error) {
      const message = friendlyError(error);
      if (this.isAdminBlockError(error)) {
        localBlock = true;
        target.status = 'pending';
        target.error = message;
        target.accountId = account.id;
        job.blockedReason = message;
        this.db.addLog({
          jobId: job.id,
          numberOrAction: target.displayName || target.name || target.number,
          accountUsed: account.alias,
          result: 'blocked',
          errorMessage: message
        });
      } else if (this.isProtectedTargetError(error)) {
        localBlock = true;
        target.status = 'skipped';
        target.error = message;
        target.protected = true;
        target.accountId = account.id;
        target.processedAt = new Date().toISOString();
        job.blockedReason = message;
        this.db.addLog({
          jobId: job.id,
          numberOrAction: target.displayName || target.name || target.number,
          accountUsed: account.alias,
          result: 'blocked',
          errorMessage: message
        });
      } else {
        account.dailyActionCount += 1;
        account.dailyActionLimit = settings.dailyCap;
        account.lastActionAt = Date.now();
        account.lastActiveAt = new Date().toISOString();
        account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
        const canRetry = this.isRetryableError(error) && target.attempts < 3;
        if (canRetry) {
          target.status = 'pending';
          target.error = message;
          target.accountId = account.id;
        } else {
          target.status = 'failed';
          target.error = message;
          target.accountId = account.id;
          target.processedAt = new Date().toISOString();
        }
        this.db.addLog({
          jobId: job.id,
          numberOrAction: target.displayName || target.name || target.number,
          accountUsed: account.alias,
          result: 'failure',
          errorMessage: message
        });
      }
    }

    if (account.consecutiveFailures >= settings.failurePauseThreshold && account.pausedForDay !== today) {
      account.pausedForDay = today;
      account.status = 'paused';
      account.pausedReason = `Auto-paused after ${account.consecutiveFailures} consecutive failures.`;
      this.emit('toast', {
        type: 'error',
        message: `${account.alias} was auto-paused for the rest of the day after repeated failures.`
      });
    }

    const consumedAction = !localBlock;
    if (consumedAction) {
      account.batchCount = (account.batchCount || 0) + 1;
      if (account.batchCount >= settings.batchSize) {
        account.batchCount = 0;
        account.batchPauseUntil =
          Date.now() + randomBetween(settings.batchPauseMinSeconds, settings.batchPauseMaxSeconds) * 1000;
      }
    }

    this.updateJobState(job, group);
    this.db.save();
    this.emitJobs();
    this.emit('accounts:update');
    if (job.status !== 'running' && job.status !== 'queued') {
      this.finalizeJob(job);
    }
  }

  updateJobState(job, group) {
    const targets = job.targets || [];
    job.progress = {
      processed: targets.filter((target) => FINISHED_TARGET.has(target.status)).length,
      total: targets.length
    };
    job.errors = targets
      .filter((target) => target.status === 'failed' || target.protected)
      .map((target) => ({
        number: target.displayName || target.name || target.number,
        name: target.displayName || target.name || '',
        phoneNumber: target.phoneNumber || '',
        error: target.error || 'Unknown error',
        accountId: target.accountId || null,
        protected: Boolean(target.protected)
      }));
    job.successCount = targets.filter((target) => target.status === 'success').length;
    job.failedCount = targets.filter((target) => target.status === 'failed').length;
    job.skippedCount = targets.filter((target) => target.status === 'skipped').length;
    job.blockedCount = targets.filter((target) => target.protected).length;
    const pending = targets.filter((target) => target.status === 'pending' || target.status === 'running').length;
    if (pending === 0) {
      const failed = job.failedCount;
      const done = job.successCount + job.skippedCount;
      job.status = failed === 0 ? 'completed' : done === 0 ? 'failed' : 'partial';
      job.completedAt = new Date().toISOString();
      if (group) {
        group.hasOngoingAction = this.db.data.jobs.some(
          (item) => item.groupId === group.id && ACTIVE_STATUSES.has(item.status)
        );
        group.hasError = failed > 0;
      }
    } else {
      job.status = 'running';
      if (group) group.hasOngoingAction = true;
    }
  }

  finalizeJob(job) {
    const group = this.db.findGroup(job.groupId);
    if (group) {
      group.hasOngoingAction = this.db.data.jobs.some(
        (item) => item.groupId === group.id && ACTIVE_STATUSES.has(item.status)
      );
      if (!group.hasOngoingAction) {
        group.hasError = job.status === 'failed' || job.status === 'partial';
      }
      this.db.save();
      this.emit('groups:update');
      this.sessions.refreshGroup(job.groupId).then(() => {
        this.emit('groups:update');
      }).catch(() => {});
      if (job.status === 'completed') {
        this.emit('toast', {
          type: 'success',
          message: `${job.type === 'add' ? 'Adding members to' : 'Removing members from'} ${job.groupName} finished.`
        });
      } else {
        this.emit('toast', {
          type: 'error',
          message: `${job.type === 'add' ? 'Adding members to' : 'Removing members from'} ${job.groupName} finished with errors.`
        });
      }
    }
    this.emitJobs();
    this.emit('groups:update');
  }

  createJob({ type, groupId, numbers, names, targets: requestedTargets }) {
    if (type !== 'add' && type !== 'remove') throw new Error('Unknown job type.');
    const group = this.db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    const inputs = Array.isArray(requestedTargets) && requestedTargets.length
      ? requestedTargets
      : (Array.isArray(numbers) ? numbers : []);
    if (inputs.length === 0) throw new Error('No recipients were provided.');

    const settings = this.getSettings();
    const normalized = [];
    const seen = new Set();
    for (const raw of inputs) {
      const target = normalizeTarget(raw);
      if (!target || seen.has(target.key)) continue;
      seen.add(target.key);
      normalized.push(target);
    }
    if (normalized.length === 0) {
      throw new Error('No valid phone numbers or WhatsApp identities were provided.');
    }

    const memberKeys = memberKeysFor(group);
    const pendingTargets = new Set();
    for (const job of this.db.data.jobs) {
      if (job.groupId !== groupId || job.type !== type) continue;
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      for (const target of job.targets || []) {
        if (target.status === 'pending' || target.status === 'running') {
          const key = targetKey(target);
          if (key) pendingTargets.add(key);
        }
      }
    }

    const filtered = normalized.filter((target) => {
      if (pendingTargets.has(target.key)) return false;
      if (type === 'add') return !memberKeys.has(target.key);
      return memberKeys.has(target.key);
    });
    if (filtered.length === 0) {
      throw new Error(
        type === 'add'
          ? 'No new valid recipients to add. They may already be in the group or queued.'
          : 'None of these recipients are currently in the group.'
      );
    }

    const nameMap = new Map();
    if (names && typeof names === 'object') {
      for (const key of Object.keys(names)) {
        const normalizedKey = normalizeTarget(key);
        if (normalizedKey) nameMap.set(normalizedKey.key, sanitizeContactName(names[key]));
      }
    }

    const targets = filtered.map((target) => {
      const providedName = target.name || nameMap.get(target.key) || '';
      const name = this.db.contactName(target.jid || target.number || target.phoneNumber) || providedName || '';
      const displayName = name || target.displayName || target.number || target.jid || '';
      return {
        number: target.number,
        phoneNumber: target.phoneNumber || '',
        jid: target.jid || '',
        name: displayName,
        displayName,
        status: 'pending',
        error: null,
        accountId: null,
        processedAt: null,
        attempts: 0
      };
    });

    const job = {
      id: `job_${crypto.randomUUID()}`,
      type,
      groupId,
      groupName: group.name,
      targetNumbers: targets.map((target) => target.number),
      targets,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      estimatedDurationSeconds: this.estimateForTargets(targets.length, group),
      progress: { processed: 0, total: targets.length },
      errors: [],
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      dismissed: false,
      blockedReason: null
    };

    group.hasOngoingAction = true;
    group.hasError = false;
    this.db.data.jobs.push(job);
    this.db.save();
    this.emitJobs();
    this.emit('groups:update');
    this.kick();
    return job;
  }

  estimateForTargets(count, group) {
    if (!count) return 0;
    const settings = this.getSettings();
    const avgDelay = (settings.minDelaySeconds + settings.maxDelaySeconds) / 2;
    const connectedAdmins = this.db.data.accounts.filter(
      (account) => account.status === 'connected' && this.sessions.isVerifiedAdminOf(account, group)
    ).length;
    const accounts = Math.max(1, connectedAdmins);
    const batches = Math.ceil(count / (settings.batchSize * accounts));
    const avgBatchPause = (settings.batchPauseMinSeconds + settings.batchPauseMaxSeconds) / 2;
    return Math.round(count * avgDelay + batches * avgBatchPause);
  }

  remainingSecondsFor(job) {
    const pending = (job.targets || []).filter(
      (target) => target.status === 'pending' || target.status === 'running'
    ).length;
    if (pending === 0) return 0;
    const group = this.db.findGroup(job.groupId);
    let estimate = this.estimateForTargets(pending, group || { adminIds: [], adminAccountIds: [] });
    if (this.isQuiet()) {
      estimate += Math.round(this.quietWaitMs() / 1000);
    }
    return estimate;
  }

  dismissJob(jobId) {
    const job = this.db.findJob(jobId);
    if (!job) throw new Error('Job not found.');
    if (ACTIVE_STATUSES.has(job.status)) throw new Error('An active job cannot be dismissed.');
    job.dismissed = true;
    this.db.save();
    this.emitJobs();
    return true;
  }

  cancelJobsForGroup(groupId, reason) {
    const jobs = this.db.data.jobs.filter(
      (job) => job.groupId === groupId && ACTIVE_STATUSES.has(job.status)
    );
    for (const job of jobs) {
      for (const target of job.targets || []) {
        if (target.status === 'pending' || target.status === 'running') {
          target.status = 'failed';
          target.error = reason;
          target.processedAt = new Date().toISOString();
        }
      }
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.blockedReason = null;
      job.errors = (job.targets || [])
        .filter((target) => target.status === 'failed')
        .map((target) => ({
          number: target.displayName || target.name || target.number,
          name: target.displayName || target.name || '',
          phoneNumber: target.phoneNumber || '',
          error: target.error || reason,
          accountId: target.accountId || null
        }));
      job.progress = { processed: (job.targets || []).length, total: (job.targets || []).length };
    }
    if (jobs.length) {
      const group = this.db.findGroup(groupId);
      if (group) {
        group.hasOngoingAction = this.db.data.jobs.some(
          (item) => item.groupId === groupId && ACTIVE_STATUSES.has(item.status)
        );
        group.hasError = true;
      }
      this.db.save();
      this.emitJobs();
      this.emit('groups:update');
    }
  }

  emitJobs() {
    this.emit('jobs:update');
  }
}

module.exports = { QueueManager };
