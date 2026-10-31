const state = {
  hasUser: false,
  auth: false,
  user: null,
  page: 'login',
  accounts: [],
  groups: [],
  jobs: [],
  settings: null,
  contacts: [],
  contactsCount: 0,
  dataDir: '',
  pageData: {},
  currentGroupId: null,
  pendingQr: null,
  lastQr: {},
  modalOpen: false,
  menuOpen: false,
  subscriptionsReady: false,
  settingsDirty: false,
  loginMode: 'login',
  booting: true
};

const AVATAR_COLORS = [
  '#128C7E',
  '#1F9D8B',
  '#34B7F1',
  '#7E57C2',
  '#EF6C00',
  '#C2185B',
  '#00897B',
  '#5C6BC0',
  '#8D6E63',
  '#43A047',
  '#0F766E',
  '#B45309'
];

const ICONS = {
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  kebab: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.12a5 5 0 0 0 7.07 7.07L13 19"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  spark: '<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
};

function icon(name, size = 22, extraClass = '') {
  return `<svg class="${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePhone(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (!text) return '';
  text = text.replace(/[\s\-().]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  const hasPlus = text.startsWith('+');
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (!hasPlus && digits.length < 8) return '';
  if (digits.length < 8 || digits.length > 15) return '';
  return `+${digits}`;
}

function avatarColor(seed) {
  const text = String(seed || '?');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatar(name, id, sizeClass = '') {
  const label = (String(name || '?').trim()[0] || '?').toUpperCase();
  return `<div class="avatar ${sizeClass}" style="background:${avatarColor(id || name)}">${esc(label)}</div>`;
}

function formatPhone(phone) {
  if (!phone) return 'Not linked';
  return esc(phone);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatRelative(iso) {
  if (!iso) return 'never';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'never';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return '—';
  }
}

function accountStatusMeta(account) {
  if (account.needsRelink || account.status === 'banned') {
    return { dot: 'banned', label: 'Needs re-link', tone: 'red' };
  }
  if (account.qr) return { dot: 'disconnected', label: 'Waiting for QR scan', tone: 'amber' };
  if (account.status === 'connected') return { dot: 'connected', label: 'Connected', tone: 'green' };
  if (account.status === 'paused') return { dot: 'paused', label: 'Paused', tone: 'amber' };
  return { dot: 'disconnected', label: 'Disconnected', tone: 'gray' };
}

function jobStatusMeta(status) {
  const map = {
    queued: { label: 'Queued', tone: 'blue' },
    running: { label: 'Running', tone: 'green' },
    completed: { label: 'Completed', tone: 'green' },
    failed: { label: 'Failed', tone: 'red' },
    partial: { label: 'Partial', tone: 'amber' }
  };
  return map[status] || { label: status, tone: 'gray' };
}

function conversationLabel(job) {
  const count = job.total || (job.progress && job.progress.total) || 0;
  const verb = job.type === 'add' ? 'Adding' : 'Removing';
  const noun = count === 1 ? 'member' : 'members';
  return `${verb} ${count} ${noun}`;
}

async function call(channel, args = [], options = {}) {
  let response;
  try {
    response = await window.api.invoke(channel, ...args);
  } catch (error) {
    if (!options.silent) showToast(error.message || 'The app could not complete this action.', 'error');
    throw error;
  }
  if (!response || !response.ok) {
    const message = (response && response.error) || 'The app could not complete this action.';
    if (!options.silent) showToast(message, 'error');
    throw new Error(message);
  }
  return response.data;
}

function showToast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconName = type === 'success' ? 'checkCircle' : type === 'error' ? 'alertCircle' : 'spark';
  toast.innerHTML = `<span class="toast-icon">${icon(iconName, 17)}</span><span>${esc(message)}</span>`;
  root.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity .2s ease, transform .2s ease';
    setTimeout(() => toast.remove(), 220);
  }, type === 'error' ? 6000 : 4000);
}

function showAppRoot() {
  document.getElementById('login-root').className = 'login-root hidden';
  document.getElementById('login-root').innerHTML = '';
  document.getElementById('app-root').classList.remove('hidden');
}

function showLoginRoot() {
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('app-root').innerHTML = '';
  document.getElementById('login-root').classList.remove('hidden');
}

function navbar(title, options = {}) {
  const { back = false, subtitle = '', actions = '', brand = false } = options;
  const left = `
    ${back ? `<button class="icon-btn" data-nav-back aria-label="Go back">${icon('back')}</button>` : ''}
    ${brand ? `<div class="nav-logo">${icon('chat', 21)}</div>` : ''}
    <div>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<div class="nav-subtitle">${esc(subtitle)}</div>` : ''}
    </div>`;
  return `<header class="navbar"><div class="nav-left">${left}</div><div class="nav-right">${actions}</div></header>`;
}

function bindNavBack(callback) {
  const button = document.querySelector('[data-nav-back]');
  if (button) button.addEventListener('click', callback);
}

function bindJobActions(scope = document) {
  scope.querySelectorAll('[data-job-dismiss]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobId = button.getAttribute('data-job-dismiss');
      button.disabled = true;
      try {
        await call('jobs:dismiss', [jobId]);
      } catch (error) {
        button.disabled = false;
      }
    });
  });
  scope.querySelectorAll('[data-job-errors]').forEach((button) => {
    button.addEventListener('click', () => {
      const jobId = button.getAttribute('data-job-errors');
      const job = state.jobs.find((item) => item.id === jobId);
      if (job) openJobErrorsModal(job);
    });
  });
}

function jobCard(job) {
  const meta = jobStatusMeta(job.status);
  const total = job.total || (job.progress && job.progress.total) || 0;
  const processed = (job.progress && job.progress.processed) || 0;
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const remaining = job.estimatedRemainingSeconds || 0;
  const active = job.status === 'queued' || job.status === 'running';
  const metaRight = active
    ? job.blockedReason
      ? `<span class="blocked">${esc(job.blockedReason)}</span>`
      : `<span>~${formatDuration(remaining)} remaining</span>`
    : job.status === 'completed'
      ? `<span>Finished ${formatRelative(job.completedAt)}</span>`
      : `<span>${job.failedCount || 0} failed · ${job.skippedCount || 0} skipped</span>`;
  return `
    <div class="job-card ${job.status}">
      <div class="job-top">
        <div class="job-title">${conversationLabel(job)} <span class="group">· ${esc(job.groupName)}</span></div>
        <span class="badge ${meta.tone}">${meta.label}</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="job-meta">
        <span>${processed} of ${total} processed${job.skippedCount ? ` · ${job.skippedCount} skipped` : ''}</span>
        ${metaRight}
      </div>
      <div class="job-actions">
        ${job.errors && job.errors.length ? `<button class="btn btn-ghost" data-job-errors="${esc(job.id)}">${icon('alert', 14)} View ${job.errors.length} error${job.errors.length === 1 ? '' : 's'}</button>` : ''}
        ${!active ? `<button class="btn btn-ghost" data-job-dismiss="${esc(job.id)}">Dismiss</button>` : ''}
      </div>
    </div>`;
}

function connectedAccounts() {
  return state.accounts.filter((account) => account.status === 'connected' || account.status === 'paused');
}

async function loadSnapshot() {
  const data = await call('app:snapshot', [], { silent: true });
  state.hasUser = data.hasUser;
  state.auth = data.authenticated;
  state.user = data.user;
  state.accounts = data.accounts || [];
  state.groups = data.groups || [];
  state.jobs = data.jobs || [];
  state.settings = data.settings || null;
  state.contactsCount = data.contactsCount || 0;
}

async function enterApp() {
  await loadSnapshot();
  if (!state.auth) {
    showLogin();
    return;
  }
  showAppRoot();
  state.page = 'home';
  renderHome();
}

function showLogin() {
  state.auth = false;
  state.user = null;
  state.page = 'login';
  state.pageData = {};
  state.groups = [];
  state.accounts = [];
  state.jobs = [];
  state.contacts = [];
  state.pendingQr = null;
  state.modalOpen = false;
  closeModal();
  showLoginRoot();
  renderLogin();
}

function renderLogin() {
  const setup = !state.hasUser;
  const root = document.getElementById('login-root');
  const title = setup ? 'Create your local login' : 'Welcome back';
  const eyebrow = setup ? 'First-time setup' : 'Local access';
  const lead = setup
    ? 'Set a username and password for this computer. This login never leaves your machine.'
    : 'Sign in to manage your groups, accounts, and pacing.';
  const action = setup ? 'Create login' : 'Log in';
  root.innerHTML = `
    <div class="login-shell">
      <aside class="login-art">
        <div class="login-brand">
          <div class="mark">${icon('chat', 30)}</div>
          <h1>WhatsApp<br>Group Manager</h1>
          <p>Run adding and removing jobs across up to four admin accounts with human-like pacing, right from your desktop.</p>
        </div>
        <div class="login-features">
          <div class="login-feature"><span class="dot">${icon('shield', 16)}</span> Encrypted local sessions on your machine</div>
          <div class="login-feature"><span class="dot">${icon('clock', 16)}</span> Random delays, daily caps and quiet hours</div>
          <div class="login-feature"><span class="dot">${icon('users', 16)}</span> Up to 4 admin accounts, fully offline</div>
        </div>
      </aside>
      <section class="login-panel">
        <div class="eyebrow">${eyebrow}</div>
        <h2>${title}</h2>
        <p class="lead">${lead}</p>
        <div id="login-error" class="form-error"></div>
        <form id="login-form" autocomplete="off">
          <div class="field">
            <label for="login-username">Username</label>
            <input id="login-username" class="input" type="text" autocomplete="username" placeholder="e.g. operator" maxlength="40">
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" class="input" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters">
          </div>
          ${setup ? `
          <div class="field">
            <label for="login-confirm">Confirm password</label>
            <input id="login-confirm" class="input" type="password" autocomplete="new-password" placeholder="Repeat your password">
          </div>` : ''}
          <button id="login-submit" class="btn btn-primary btn-block btn-lg" type="submit">${action}</button>
        </form>
        <div class="login-note">
          ${setup
            ? 'This is a single local operator login. Store it safely — there is no remote recovery. The reset procedure is documented in README.md.'
            : 'Local-only gate for this computer. WhatsApp sessions stay linked when you sign out of the app.'}
        </div>
      </section>
    </div>`;

  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    errorBox.classList.remove('visible');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username) {
      errorBox.textContent = 'Enter your username.';
      errorBox.classList.add('visible');
      return;
    }
    if (password.length < 6) {
      errorBox.textContent = 'Password must be at least 6 characters.';
      errorBox.classList.add('visible');
      return;
    }
    if (setup) {
      const confirm = document.getElementById('login-confirm').value;
      if (password !== confirm) {
        errorBox.textContent = 'The passwords do not match.';
        errorBox.classList.add('visible');
        return;
      }
    }
    submit.disabled = true;
    submit.textContent = setup ? 'Creating…' : 'Signing in…';
    try {
      if (setup) {
        await call('auth:setup', [username, password], { silent: true });
        state.hasUser = true;
      } else {
        await call('auth:login', [username, password], { silent: true });
      }
      state.auth = true;
      state.user = username;
      await enterApp();
      showToast(setup ? 'Local login created.' : 'Signed in.', 'success');
      if (state.page === 'home' && state.accounts.length === 0) {
        showToast('Next: open Settings and link your first admin account.');
      }
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.add('visible');
      submit.disabled = false;
      submit.textContent = action;
    }
  });
  setTimeout(() => {
    const username = document.getElementById('login-username');
    if (username) username.focus();
  }, 60);
}

function renderHome() {
  state.page = 'home';
  const activeJobs = state.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const recentJobs = state.jobs.filter((job) => job.status !== 'queued' && job.status !== 'running');
  const jobsToShow = [...activeJobs, ...recentJobs].slice(0, 6);
  const online = state.accounts.filter((account) => account.status === 'connected').length;
  const groups = state.groups.slice().sort((a, b) => a.name.localeCompare(b.name));

  const groupsMarkup = groups.length
    ? `<div class="list">${groups.map((group) => `
      <button class="list-row clickable group-row" data-group-id="${esc(group.id)}">
        ${avatar(group.name, group.id)}
        <div class="row-main">
          <div class="row-title">${esc(group.name)}</div>
          <div class="row-subtitle">${group.memberCount} member${group.memberCount === 1 ? '' : 's'}${group.adminAccountIds && group.adminAccountIds.length ? ` · ${group.adminAccountIds.length} admin account${group.adminAccountIds.length === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div class="row-trailing">
          ${group.hasOngoingAction ? `<span class="clock" title="Job in progress">${icon('clock', 19)}</span>` : ''}
          ${group.hasError ? `<span class="alert" title="Needs attention">${icon('alert', 19)}</span>` : ''}
          ${icon('chevron', 19)}
        </div>
      </button>`).join('')}</div>`
    : `<div class="card empty-state">
        <div class="empty-icon">${icon('users', 30)}</div>
        <h3>No groups yet</h3>
        <p>Add a group from one of your connected admin accounts to start managing its members.</p>
      </div>`;

  document.getElementById('app-root').innerHTML = `
    ${navbar('WhatsApp Group Manager', {
      brand: true,
      actions: `<button class="icon-btn" data-open-settings aria-label="Settings">${icon('gear', 22)}</button>`
    })}
    <main class="content">
      <div class="content-inner">
        <div class="status-line">
          <span class="pill"><span class="dot-status ${online ? 'connected' : 'disconnected'}"></span>${online} of ${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'} online</span>
          <span class="pill">${state.groups.length} group${state.groups.length === 1 ? '' : 's'} managed</span>
          ${activeJobs.length ? `<span class="pill"><span class="dot-status connected"></span>${activeJobs.length} active job${activeJobs.length === 1 ? '' : 's'}</span>` : ''}
        </div>
        ${jobsToShow.length ? `<div class="job-stack">${jobsToShow.map(jobCard).join('')}</div>` : ''}
        <div class="page-head">
          <div>
            <h2>Your groups</h2>
            <p>Open a group to manage its members or watch live job progress.</p>
          </div>
          <div class="home-actions">
            <button class="btn btn-primary" data-add-group>${icon('plus', 18)} Add new group</button>
          </div>
        </div>
        ${groupsMarkup}
      </div>
    </main>`;

  document.querySelector('[data-open-settings]').addEventListener('click', openSettings);
  document.querySelector('[data-add-group]').addEventListener('click', openAddGroup);
  document.querySelectorAll('[data-group-id]').forEach((row) => {
    row.addEventListener('click', () => openGroup(row.getAttribute('data-group-id')));
  });
  bindJobActions();
}

function openAddGroup() {
  state.page = 'add-group';
  state.pageData.addGroup = {
    accountId: null,
    available: [],
    selected: new Set(),
    loading: false,
    error: '',
    autoTried: false
  };
  renderAddGroup();
}

function accountSelectCard(account, selected) {
  const meta = accountStatusMeta(account);
  return `
    <button class="list-row clickable ${selected ? 'selected' : ''}" data-select-account="${esc(account.id)}">
      ${avatar(account.alias, account.id)}
      <div class="row-main">
        <div class="row-title">${esc(account.alias)} <span class="badge ${meta.tone}">${meta.label}</span></div>
        <div class="row-subtitle">${formatPhone(account.phoneNumber)}</div>
      </div>
      <div class="row-trailing">${selected ? icon('checkCircle', 20) : icon('chevron', 18)}</div>
    </button>`;
}

function renderAddGroup() {
  state.page = 'add-group';
  const ag = state.pageData.addGroup;
  if (!ag) return;
  const accounts = state.accounts.filter((account) => account.status === 'connected' || account.status === 'paused');
  const selectedAccount = accounts.find((account) => account.id === ag.accountId);
  let accountSection = '';
  if (accounts.length === 0) {
    accountSection = `<div class="card empty-state">
      <div class="empty-icon">${icon('user', 30)}</div>
      <h3>No connected accounts</h3>
      <p>Link an admin account in Settings first. The app needs a connected account to read your WhatsApp groups.</p>
    </div>`;
  } else if (accounts.length === 1 && !ag.accountId) {
    accountSection = `<div class="loading-block"><span class="spinner"></span> Loading groups…</div>`;
  } else {
    accountSection = `<div class="list">${accounts.map((account) => accountSelectCard(account, account.id === ag.accountId)).join('')}</div>`;
  }

  let groupsSection = '';
  if (selectedAccount) {
    if (ag.loading) {
      groupsSection = `<div class="card loading-block"><span class="spinner"></span> Reading groups from ${esc(selectedAccount.alias)}…</div>`;
    } else if (ag.error) {
      groupsSection = `<div class="card empty-state">
        <div class="empty-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('alert', 30)}</div>
        <h3>Could not load groups</h3>
        <p>${esc(ag.error)}</p>
      </div>`;
    } else if (ag.available.length === 0) {
      groupsSection = `<div class="card empty-state">
        <div class="empty-icon">${icon('users', 30)}</div>
        <h3>No groups found</h3>
        <p>This account is not in any WhatsApp groups, or its groups are still syncing. Try again in a moment.</p>
      </div>`;
    } else {
      groupsSection = `<div class="list">${ag.available.map((group) => `
        <button class="list-row clickable ${ag.selected.has(group.id) ? 'selected' : ''}" data-available-id="${esc(group.id)}" ${group.alreadyManaged ? 'disabled' : ''}>
          <span class="check-box ${ag.selected.has(group.id) ? 'on' : ''}">${ag.selected.has(group.id) ? icon('check', 14) : ''}</span>
          ${avatar(group.name, group.id, 'sm')}
          <div class="row-main">
            <div class="row-title">${esc(group.name)}</div>
            <div class="row-subtitle">${group.memberCount} member${group.memberCount === 1 ? '' : 's'}</div>
          </div>
          <div class="row-trailing">
            ${group.alreadyManaged ? '<span class="badge gray">Managed</span>' : !group.isAdmin ? '<span class="badge amber">Not admin</span>' : ''}
          </div>
        </button>`).join('')}</div>`;
    }
  }

  const canConfirm = Boolean(selectedAccount) && ag.selected.size > 0 && !ag.loading;
  document.getElementById('app-root').innerHTML = `
    ${navbar('Add new group', {
      back: true,
      subtitle: selectedAccount ? `From ${selectedAccount.alias}` : 'Choose an account'
    })}
    <main class="content">
      <div class="content-inner narrow">
        <div class="page-head">
          <div>
            <h2>Pick groups to manage</h2>
            <p>Choose an admin account, then select one or more of its WhatsApp groups.</p>
          </div>
        </div>
        <div class="section-title"><h3>Admin account</h3><span class="meta">${accounts.length} connected</span></div>
        ${accountSection}
        ${selectedAccount ? `<div class="section-title"><h3>Groups</h3><span class="meta">${ag.available.length} available</span></div>${groupsSection}` : ''}
        ${selectedAccount ? `<div class="sticky-action"><div class="inner"><button id="confirm-add-groups" class="btn btn-primary btn-lg btn-block" ${canConfirm ? '' : 'disabled'}>Add ${ag.selected.size || ''} group${ag.selected.size === 1 ? '' : 's'}</button></div></div>` : ''}
      </div>
    </main>`;

  bindNavBack(() => {
    state.page = 'home';
    renderHome();
  });

  document.querySelectorAll('[data-select-account]').forEach((button) => {
    button.addEventListener('click', () => selectAddGroupAccount(button.getAttribute('data-select-account')));
  });

  document.querySelectorAll('[data-available-id]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const id = button.getAttribute('data-available-id');
      const group = ag.available.find((item) => item.id === id);
      if (!group || group.alreadyManaged) return;
      if (ag.selected.has(id)) ag.selected.delete(id);
      else ag.selected.add(id);
      renderAddGroup();
    });
  });

  const confirm = document.getElementById('confirm-add-groups');
  if (confirm) {
    confirm.addEventListener('click', async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      confirm.textContent = 'Adding…';
      try {
        await call('groups:add', [ag.accountId, Array.from(ag.selected)]);
        showToast(`${ag.selected.size} group${ag.selected.size === 1 ? '' : 's'} added.`, 'success');
        await loadSnapshot();
        state.page = 'home';
        renderHome();
      } catch (error) {
        confirm.disabled = false;
        confirm.textContent = `Add ${ag.selected.size} group${ag.selected.size === 1 ? '' : 's'}`;
      }
    });
  }

  if (accounts.length === 1 && !ag.accountId && !ag.loading && !ag.autoTried) {
    ag.autoTried = true;
    setTimeout(() => selectAddGroupAccount(accounts[0].id), 20);
  }
}

async function selectAddGroupAccount(accountId) {
  const ag = state.pageData.addGroup;
  if (!ag) return;
  ag.accountId = accountId;
  ag.available = [];
  ag.selected = new Set();
  ag.error = '';
  ag.loading = true;
  renderAddGroup();
  try {
    const groups = await call('groups:fetchAvailable', [accountId], { silent: true });
    ag.available = groups;
  } catch (error) {
    ag.error = error.message;
  } finally {
    ag.loading = false;
    if (state.page === 'add-group') renderAddGroup();
  }
}

async function openGroup(groupId) {
  state.page = 'group';
  state.currentGroupId = groupId;
  state.menuOpen = false;
  const cached = state.groups.find((group) => group.id === groupId);
  state.pageData.group = cached && cached.members ? cached : null;
  state.pageData.groupSummary = cached || null;
  renderGroupPage();
  try {
    const group = await call('groups:get', [groupId], { silent: true });
    if (state.page === 'group' && state.currentGroupId === groupId) {
      state.pageData.group = group;
      state.pageData.groupSummary = group;
      renderGroupPage();
    }
  } catch (error) {
    if (state.page === 'group' && state.currentGroupId === groupId) {
      showToast(error.message, 'error');
      state.page = 'home';
      renderHome();
    }
  }
}

function renderGroupPage() {
  const group = state.pageData.group;
  const summary = group || state.pageData.groupSummary;
  if (!summary) {
    document.getElementById('app-root').innerHTML = `
      ${navbar('Group', {
        back: true,
        actions: `<button class="icon-btn" data-group-menu-toggle aria-label="Group menu">${icon('kebab', 22)}</button>`
      })}
      <main class="content"><div class="content-inner"><div class="card loading-block"><span class="spinner"></span> Loading group…</div></div></main>`;
    bindNavBack(() => {
      state.page = 'home';
      renderHome();
    });
    return;
  }

  const groupJobs = state.jobs.filter((job) => job.groupId === summary.id);
  const activeJobs = groupJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const recentJobs = groupJobs.filter((job) => job.status !== 'queued' && job.status !== 'running');
  const jobsToShow = [...activeJobs, ...recentJobs].slice(0, 5);
  const members = group && Array.isArray(group.members) ? group.members : [];
  const adminIds = summary.adminIds || [];

  const membersMarkup = group
    ? members.length
      ? `<div class="list">${members.map((member) => `
        <div class="list-row">
          ${avatar(member.displayName || member.phoneNumber, member.phoneNumber, 'sm')}
          <div class="row-main">
            <div class="row-title">${esc(member.displayName || member.phoneNumber)} ${adminIds.includes(member.phoneNumber) ? '<span class="member-admin">Admin</span>' : ''}</div>
            <div class="row-subtitle">${esc(member.phoneNumber)}</div>
          </div>
        </div>`).join('')}</div>`
      : `<div class="card empty-state"><div class="empty-icon">${icon('users', 30)}</div><h3>No members found</h3><p>Refresh the group to fetch its current member list from WhatsApp.</p></div>`
    : `<div class="card loading-block"><span class="spinner"></span> Syncing members…</div>`;

  document.getElementById('app-root').innerHTML = `
    ${navbar(summary.name, {
      back: true,
      subtitle: `${summary.memberCount} member${summary.memberCount === 1 ? '' : 's'}`,
      actions: `<button class="icon-btn" data-group-menu-toggle aria-label="Group menu">${icon('kebab', 22)}</button>`
    })}
    <main class="content">
      <div class="content-inner">
        ${jobsToShow.length ? `<div class="job-stack">${jobsToShow.map(jobCard).join('')}</div>` : ''}
        <div class="list">
          <div class="group-meta-bar">
            <span>${summary.memberCount} member${summary.memberCount === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>Synced ${formatRelative(summary.lastSyncedAt)}</span>
            <button class="btn btn-secondary btn-sm" data-refresh-group>${icon('refresh', 15)} Refresh</button>
          </div>
          ${membersMarkup}
        </div>
      </div>
    </main>`;

  bindNavBack(() => {
    state.page = 'home';
    renderHome();
  });
  bindJobActions();

  const menuToggle = document.querySelector('[data-group-menu-toggle]');
  const navRight = document.querySelector('.nav-right');
  if (state.menuOpen) {
    navRight.insertAdjacentHTML('beforeend', `
      <div class="nav-menu" id="group-menu">
        <button data-group-action="add">${icon('plus', 18)} Add members</button>
        <button data-group-action="remove">${icon('user', 18)} Remove members</button>
        <button class="danger" data-group-action="delete">${icon('trash', 18)} Delete group</button>
      </div>`);
  }
  menuToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    state.menuOpen = !state.menuOpen;
    renderGroupPage();
  });
  if (state.menuOpen) {
    document.getElementById('group-menu').addEventListener('click', (event) => event.stopPropagation());
    document.querySelectorAll('[data-group-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-group-action');
        state.menuOpen = false;
        if (action === 'add') openMembers('add');
        else if (action === 'remove') openMembers('remove');
        else openDeleteGroupModal();
      });
    });
    setTimeout(() => {
      const closeMenu = () => {
        document.removeEventListener('click', closeMenu);
        if (state.menuOpen) {
          state.menuOpen = false;
          if (state.page === 'group') renderGroupPage();
        }
      };
      document.addEventListener('click', closeMenu);
    }, 0);
  }

  const refresh = document.querySelector('[data-refresh-group]');
  if (refresh) {
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Refreshing`;
      try {
        const updated = await call('groups:refresh', [summary.id], { silent: true });
        state.pageData.group = updated;
        state.pageData.groupSummary = updated;
        showToast('Member list refreshed.', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        if (state.page === 'group') renderGroupPage();
      }
    });
  }
}

async function openMembers(mode) {
  const group = state.pageData.group || state.pageData.groupSummary;
  if (!group) return;
  state.page = 'members';
  state.pageData.members = {
    mode,
    loading: true,
    error: '',
    context: null,
    pending: [],
    pendingSet: new Set(),
    memberSet: new Set(),
    busy: false,
    importing: false,
    groupName: group.name
  };
  renderMembersPage();
  try {
    const context = await call('members:context', [group.id, mode], { silent: true });
    const ctx = state.pageData.members;
    ctx.context = context;
    ctx.loading = false;
    ctx.groupName = context.group.name;
    ctx.memberSet = new Set((context.group.members || []).map((member) => member.phoneNumber));
    ctx.pendingSet = new Set((context.pendingNumbers || []).map(normalizePhone).filter(Boolean));
  } catch (error) {
    const ctx = state.pageData.members;
    ctx.loading = false;
    ctx.error = error.message;
  }
  if (state.page === 'members') renderMembersPage();
}

function memberNameFor(ctx, phone) {
  const group = ctx.context ? ctx.context.group : null;
  if (!group) return '';
  const member = (group.members || []).find((item) => item.phoneNumber === phone);
  return member ? member.displayName || '' : '';
}

function addPendingNumber(raw, rawName) {
  const ctx = state.pageData.members;
  if (!ctx) return 'invalid';
  const phone = normalizePhone(raw);
  if (!phone) return 'invalid';
  if (ctx.mode === 'add' && ctx.memberSet.has(phone)) return 'in-group';
  if (ctx.mode === 'remove' && !ctx.memberSet.has(phone)) return 'not-member';
  if (ctx.pendingSet.has(phone)) return 'duplicate';
  const name = String(rawName || '').trim() || memberNameFor(ctx, phone);
  ctx.pending.push({ number: phone, name });
  ctx.pendingSet.add(phone);
  return 'added';
}

function membersBack() {
  const ctx = state.pageData.members;
  const groupId = ctx && ctx.context ? ctx.context.group.id : state.currentGroupId;
  if (ctx && ctx.pending.length > 0) {
    openModal(`
      <div class="modal-head">
        <div class="settings-icon">${icon('alert', 22)}</div>
        <div><h3>Discard numbers?</h3><p>The ${ctx.pending.length} number${ctx.pending.length === 1 ? '' : 's'} in this list have not been queued yet.</p></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-close-modal>Keep editing</button>
        <button class="btn btn-danger" id="discard-pending">Discard</button>
      </div>`);
    document.getElementById('discard-pending').addEventListener('click', () => {
      closeModal();
      openGroup(groupId);
    });
  } else if (groupId) {
    openGroup(groupId);
  }
}

function renderMembersPage() {
  const ctx = state.pageData.members;
  if (!ctx) {
    state.page = 'home';
    renderHome();
    return;
  }
  const actionLabel = ctx.mode === 'add' ? 'Add' : 'Remove';
  const title = ctx.mode === 'add' ? 'Add members' : 'Remove members';
  const groupId = ctx.context ? ctx.context.group.id : state.currentGroupId;

  let body = '';
  if (ctx.loading) {
    body = `<div class="card loading-block"><span class="spinner"></span> Refreshing ${ctx.mode === 'add' ? 'group members' : 'the current member list'}…</div>`;
  } else if (ctx.error) {
    body = `<div class="card empty-state">
      <div class="empty-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('alert', 30)}</div>
      <h3>Could not load the member list</h3>
      <p>${esc(ctx.error)}</p>
      <button class="btn btn-secondary" style="margin-top:16px" id="retry-members">Try again</button>
    </div>`;
  } else {
    const pendingMarkup = ctx.pending.length
      ? `<div class="card pending-list">${ctx.pending.map((item, index) => `
        <div class="pending-row">
          ${avatar(item.name || item.number, item.number, 'xs')}
          <div>
            <div class="num">${esc(item.number)}</div>
            ${item.name ? `<div class="name">${esc(item.name)}</div>` : ''}
          </div>
          <button class="remove" data-remove-pending="${index}" aria-label="Remove number">${icon('x', 17)}</button>
        </div>`).join('')}</div>`
      : `<div class="card empty-state" style="padding:30px 20px">
          <div class="empty-icon" style="width:48px;height:48px;border-radius:15px;margin-bottom:10px">${icon('user', 22)}</div>
          <h3 style="font-size:15px">No numbers yet</h3>
          <p>Import a spreadsheet or add a number above. Invalid, duplicate, or ${ctx.mode === 'add' ? 'already-member' : 'non-member'} numbers are ignored.</p>
        </div>`;

    body = `
      <div class="import-zone">
        <div class="import-icon">${icon('upload', 22)}</div>
        <div>
          <h4>Import from Excel</h4>
          <p>.xlsx or .csv · two columns in order: number, then name</p>
        </div>
        <button class="btn btn-secondary" id="import-button" ${ctx.importing ? 'disabled' : ''}>${ctx.importing ? 'Reading…' : 'Choose file'}</button>
        <input id="import-file" type="file" accept=".xlsx,.xls,.csv" class="hidden">
      </div>
      <form class="manual-add" id="manual-form">
        <input id="manual-number" class="input" type="text" placeholder="Add one number, e.g. +212612345678" autocomplete="off">
        <button class="btn btn-primary" type="submit" id="manual-submit" aria-label="Add number">${icon('plus', 22)}</button>
      </form>
      <div class="pending-head">
        <h3>Pending numbers</h3>
        <span class="count">${ctx.pending.length} ready</span>
      </div>
      ${pendingMarkup}
      <div class="sticky-action"><div class="inner">
        <button id="submit-job" class="btn btn-primary btn-lg btn-block" ${ctx.pending.length === 0 || ctx.busy ? 'disabled' : ''}>
          ${ctx.busy ? 'Queuing…' : `${actionLabel} (${ctx.pending.length})`}
        </button>
      </div></div>`;
  }

  document.getElementById('app-root').innerHTML = `
    ${navbar(title, { back: true, subtitle: ctx.groupName || '' })}
    <main class="content">
      <div class="content-inner narrow">${body}</div>
    </main>`;

  bindNavBack(membersBack);
  document.querySelectorAll('[data-remove-pending]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.getAttribute('data-remove-pending'));
      const [removed] = ctx.pending.splice(index, 1);
      if (removed) ctx.pendingSet.delete(removed.number);
      renderMembersPage();
    });
  });

  if (ctx.error) {
    const retry = document.getElementById('retry-members');
    if (retry) retry.addEventListener('click', () => openMembers(ctx.mode));
    return;
  }
  if (ctx.loading) return;

  const importButton = document.getElementById('import-button');
  const importFile = document.getElementById('import-file');
  importButton.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    ctx.importing = true;
    renderMembersPage();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await call('import:parse', [file.name, bytes], { silent: true });
      let added = 0;
      for (const row of parsed.rows) {
        if (addPendingNumber(row.number, row.name) === 'added') added += 1;
      }
      ctx.importing = false;
      renderMembersPage();
      if (added > 0) showToast(`${added} number${added === 1 ? '' : 's'} added to the list.`, 'success');
      else showToast('No new valid numbers were found in this file.', 'info');
    } catch (error) {
      ctx.importing = false;
      renderMembersPage();
      showToast(error.message, 'error');
    }
  });

  const manualForm = document.getElementById('manual-form');
  manualForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('manual-number');
    const value = input.value.trim();
    if (!value) return;
    const result = addPendingNumber(value, '');
    if (result === 'added') {
      renderMembersPage();
      return;
    }
    if (result === 'invalid') showToast('Enter a valid international phone number.', 'error');
    else if (result === 'duplicate') showToast('This number is already in the list.', 'info');
    else if (result === 'in-group') showToast('This number is already in the group.', 'info');
    else if (result === 'not-member') showToast('This number is not a member of the group.', 'info');
    input.select();
  });

  const submit = document.getElementById('submit-job');
  submit.addEventListener('click', async () => {
    if (submit.disabled || ctx.pending.length === 0) return;
    ctx.busy = true;
    renderMembersPage();
    const names = {};
    for (const item of ctx.pending) names[item.number] = item.name;
    try {
      await call('jobs:create', [{
        type: ctx.mode,
        groupId,
        numbers: ctx.pending.map((item) => item.number),
        names
      }]);
      showToast('Job queued. It will run with delayed, rotated actions.', 'success');
      openGroup(groupId);
    } catch (error) {
      ctx.busy = false;
      renderMembersPage();
    }
  });
}

function openDeleteGroupModal() {
  const group = state.pageData.group || state.pageData.groupSummary;
  if (!group) return;
  openModal(`
    <div class="modal-head">
      <div class="settings-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('trash', 22)}</div>
      <div><h3>Delete group?</h3><p>This removes <strong>${esc(group.name)}</strong> from the app. Members are not removed and the group is not dissolved on WhatsApp.</p></div>
    </div>
    <div class="field">
      <label for="delete-confirm">Type the exact group name to confirm</label>
      <input id="delete-confirm" class="input" type="text" autocomplete="off" placeholder="${esc(group.name)}">
      <div class="hint">This action stops managing and tracking the group locally.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Cancel</button>
      <button class="btn btn-danger" id="confirm-delete-group" disabled>Delete</button>
    </div>`, { wide: true });

  const input = document.getElementById('delete-confirm');
  const button = document.getElementById('confirm-delete-group');
  input.addEventListener('input', () => {
    button.disabled = input.value !== group.name;
  });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      await call('groups:deleteLocal', [group.id]);
      closeModal();
      showToast('Group removed from the app.', 'success');
      await loadSnapshot();
      state.page = 'home';
      renderHome();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Delete';
    }
  });
  setTimeout(() => input.focus(), 60);
}

function openSettings() {
  state.page = 'settings';
  state.settingsDirty = false;
  renderSettings();
}

function accountRow(account) {
  const meta = accountStatusMeta(account);
  const usage = `${account.dailyActionCount || 0} / ${account.dailyActionLimit || (state.settings ? state.settings.dailyCap : 20)} actions today`;
  const extras = [];
  if (account.pausedReason) extras.push(esc(account.pausedReason));
  if (account.needsRelink) extras.push('This account was unlinked remotely. Re-link it to continue.');
  if (account.onboardingError) extras.push(`Onboarding: ${esc(account.onboardingError.split('\n')[0])}`);
  return `
    <div class="account-row" data-account-row="${esc(account.id)}">
      ${avatar(account.alias, account.id)}
      <div class="account-info">
        <div class="account-name">${esc(account.alias)} <span class="badge ${meta.tone}"><span class="dot-status ${meta.dot}"></span>${meta.label}</span></div>
        <div class="account-detail">${formatPhone(account.phoneNumber)} · ${usage}</div>
        ${extras.filter(Boolean).map((text) => `<div class="account-detail"><span class="${account.needsRelink ? 'error-text' : ''}">${text}</span></div>`).join('')}
      </div>
      <div class="account-actions">
        ${account.needsRelink || (account.status === 'disconnected' && !account.qr) ? `<button class="btn btn-ghost btn-sm" data-relink-account="${esc(account.id)}">Re-link</button>` : ''}
        ${account.qr ? `<button class="btn btn-ghost btn-sm" data-show-qr="${esc(account.id)}">Show QR</button>` : ''}
        <button class="icon-btn" data-unlink-account="${esc(account.id)}" title="Unlink ${esc(account.alias)}" aria-label="Unlink ${esc(account.alias)}">${icon('logout', 19)}</button>
      </div>
    </div>`;
}

function addAdminBlock() {
  const atLimit = state.accounts.length >= ((state.settings && state.settings.maxAccounts) || 4);
  return `<div style="padding:16px">
    <button class="btn btn-primary btn-block" id="add-admin-button" ${atLimit ? 'disabled' : ''}>
      ${icon('plus', 18)} ${atLimit ? 'Maximum of 4 accounts linked' : 'Add new admin'}
    </button>
    <div class="helper-text" style="text-align:center;margin-top:9px">On success, the new account is joined to existing groups and promoted by an existing admin.</div>
  </div>`;
}

function automationForm() {
  const settings = state.settings || {};
  return `
    <form id="automation-form">
      <div class="form-note">
        Per-account daily cap applies to each admin account. Actions use random delays, rotate to the least-used eligible account, and pause after a batch. Quiet hours block all WhatsApp actions.
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="set-daily-cap">Daily cap per account</label>
          <input id="set-daily-cap" class="input" type="number" min="1" max="200" value="${Number(settings.dailyCap) || 20}">
        </div>
        <div class="field">
          <label for="set-batch-size">Actions per batch</label>
          <input id="set-batch-size" class="input" type="number" min="1" max="100" value="${Number(settings.batchSize) || 5}">
        </div>
        <div class="field">
          <label for="set-min-delay">Minimum delay (seconds)</label>
          <input id="set-min-delay" class="input" type="number" min="5" max="3600" value="${Number(settings.minDelaySeconds) || 25}">
        </div>
        <div class="field">
          <label for="set-max-delay">Maximum delay (seconds)</label>
          <input id="set-max-delay" class="input" type="number" min="5" max="3600" value="${Number(settings.maxDelaySeconds) || 90}">
        </div>
        <div class="field">
          <label for="set-batch-min">Batch pause min (minutes)</label>
          <input id="set-batch-min" class="input" type="number" min="1" max="120" value="${Math.round((Number(settings.batchPauseMinSeconds) || 180) / 60)}">
        </div>
        <div class="field">
          <label for="set-batch-max">Batch pause max (minutes)</label>
          <input id="set-batch-max" class="input" type="number" min="1" max="120" value="${Math.round((Number(settings.batchPauseMaxSeconds) || 360) / 60)}">
        </div>
        <div class="field">
          <label for="set-quiet-start">Quiet hours start</label>
          <input id="set-quiet-start" class="input" type="time" value="${esc(settings.quietStart || '23:00')}">
        </div>
        <div class="field">
          <label for="set-quiet-end">Quiet hours end</label>
          <input id="set-quiet-end" class="input" type="time" value="${esc(settings.quietEnd || '07:00')}">
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" type="submit" id="save-settings">Save automation settings</button>
      </div>
    </form>`;
}

function renderSettings() {
  state.page = 'settings';
  const accountsBody = state.accounts.length
    ? state.accounts.map(accountRow).join('')
    : '<div class="account-empty">No admin accounts linked yet. Add one to start reading groups from WhatsApp.</div>';
  document.getElementById('app-root').innerHTML = `
    ${navbar('Settings', {
      back: true,
      actions: `<button class="icon-btn" data-app-logout aria-label="Log out of app">${icon('logout', 21)}</button>`
    })}
    <main class="content">
      <div class="content-inner narrow">
        <div class="section-title"><h3>General</h3></div>
        <div class="list">
          <button class="settings-row" id="contacts-row">
            <div class="settings-icon">${icon('users', 21)}</div>
            <div class="row-main">
              <div class="row-title">Contacts</div>
              <div class="row-subtitle">${state.contactsCount} known contact${state.contactsCount === 1 ? '' : 's'} across linked accounts</div>
            </div>
            <div class="row-trailing">${icon('chevron', 19)}</div>
          </button>
        </div>

        <div class="section-title"><h3>Admin accounts</h3><span class="meta">${state.accounts.length} of 4 linked</span></div>
        <div class="list" id="settings-accounts-body">${accountsBody}</div>
        <div id="add-admin-container">${addAdminBlock()}</div>

        <div class="section-title"><h3>Rotation &amp; pacing</h3></div>
        <div class="card settings-section">${automationForm()}</div>

        <div class="section-title"><h3>Local data</h3></div>
        <div class="card settings-section">
          <div class="row-title" style="font-size:14px">Session encryption</div>
          <div class="helper-text" style="margin-top:5px">Each Baileys auth folder is encrypted with AES-256-GCM using a key derived from your local login password. The database never leaves this computer.</div>
          <div class="helper-text" style="margin-top:10px">Data folder: <span style="color:var(--ink-soft);word-break:break-all">${esc(state.dataDir || 'Loading…')}</span></div>
        </div>
      </div>
    </main>`;

  bindNavBack(() => {
    state.page = 'home';
    renderHome();
  });
  document.getElementById('contacts-row').addEventListener('click', openContacts);
  document.querySelector('[data-app-logout]').addEventListener('click', openAppLogoutModal);
  bindAccountActions();
  bindAutomationForm();

  const addAdmin = document.getElementById('add-admin-button');
  if (addAdmin) addAdmin.addEventListener('click', openAddAdminModal);
}

function bindAccountActions() {
  const container = document.getElementById('settings-accounts-body');
  if (!container) return;
  container.querySelectorAll('[data-unlink-account]').forEach((button) => {
    button.addEventListener('click', () => openUnlinkAccountModal(button.getAttribute('data-unlink-account')));
  });
  container.querySelectorAll('[data-relink-account]').forEach((button) => {
    button.addEventListener('click', () => openRelinkAccount(button.getAttribute('data-relink-account')));
  });
  container.querySelectorAll('[data-show-qr]').forEach((button) => {
    button.addEventListener('click', () => openExistingQr(button.getAttribute('data-show-qr')));
  });
}

function updateSettingsLive() {
  if (state.page !== 'settings') return;
  const body = document.getElementById('settings-accounts-body');
  if (body) {
    body.innerHTML = state.accounts.length
      ? state.accounts.map(accountRow).join('')
      : '<div class="account-empty">No admin accounts linked yet. Add one to start reading groups from WhatsApp.</div>';
    bindAccountActions();
  }
  const addContainer = document.getElementById('add-admin-container');
  if (addContainer) {
    addContainer.innerHTML = addAdminBlock();
    const button = document.getElementById('add-admin-button');
    if (button) button.addEventListener('click', openAddAdminModal);
  }
  if (state.pendingQr) {
    const account = state.accounts.find((item) => item.id === state.pendingQr.accountId);
    if (account && account.status === 'connected') {
      const alias = account.alias;
      state.pendingQr = null;
      closeModal();
      showToast(`${alias} connected and linked.`, 'success');
      loadSnapshot().then(() => {
        if (state.page === 'settings') renderSettings();
      }).catch(() => {});
    }
  }
}

function bindAutomationForm() {
  const form = document.getElementById('automation-form');
  if (!form) return;
  form.addEventListener('input', () => {
    state.settingsDirty = true;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('save-settings');
    if (button.disabled) return;
    const minDelay = Number(document.getElementById('set-min-delay').value);
    const maxDelay = Number(document.getElementById('set-max-delay').value);
    const batchMin = Number(document.getElementById('set-batch-min').value);
    const batchMax = Number(document.getElementById('set-batch-max').value);
    if (maxDelay < minDelay) {
      showToast('Maximum delay must be greater than or equal to the minimum.', 'error');
      return;
    }
    if (batchMax < batchMin) {
      showToast('Maximum batch pause must be greater than or equal to the minimum.', 'error');
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const updated = await call('settings:update', [{
        dailyCap: Number(document.getElementById('set-daily-cap').value),
        batchSize: Number(document.getElementById('set-batch-size').value),
        minDelaySeconds: minDelay,
        maxDelaySeconds: maxDelay,
        batchPauseMinSeconds: batchMin * 60,
        batchPauseMaxSeconds: batchMax * 60,
        quietStart: document.getElementById('set-quiet-start').value,
        quietEnd: document.getElementById('set-quiet-end').value,
        failurePauseThreshold: (state.settings && state.settings.failurePauseThreshold) || 3
      }]);
      state.settings = updated;
      state.settingsDirty = false;
      showToast('Automation settings saved.', 'success');
      renderSettings();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Save automation settings';
    }
  });
}

function openUnlinkAccountModal(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  openModal(`
    <div class="modal-head">
      <div class="settings-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('logout', 22)}</div>
      <div><h3>Unlink ${esc(account.alias)}?</h3><p>This logs the account out of WhatsApp and deletes its encrypted session folder from this computer. The app stops using it as an admin.</p></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Cancel</button>
      <button class="btn btn-danger" id="confirm-unlink">Log out</button>
    </div>`, { wide: true });
  const button = document.getElementById('confirm-unlink');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Unlinking…';
    try {
      await call('accounts:remove', [accountId]);
      closeModal();
      showToast(`${account.alias} unlinked.`, 'success');
      await loadSnapshot();
      if (state.page === 'settings') renderSettings();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Log out';
    }
  });
}

function openRelinkAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  state.pendingQr = { accountId, alias: account.alias };
  renderQrModal('Re-link this account', 'Scan the QR code with the same or another WhatsApp account.');
  call('accounts:relink', [accountId], { silent: true }).catch((error) => {
    const status = document.getElementById('qr-status-text');
    if (status) status.textContent = error.message;
  });
}

function openAppLogoutModal() {
  openModal(`
    <div class="modal-head">
      <div class="settings-icon">${icon('logout', 22)}</div>
      <div><h3>End local session?</h3><p>Your WhatsApp accounts stay linked. You will need your local username and password to open the app again.</p></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Cancel</button>
      <button class="btn btn-danger" id="confirm-app-logout">Log out</button>
    </div>`, { wide: true });
  const button = document.getElementById('confirm-app-logout');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Signing out…';
    try {
      await call('auth:logoutApp', []);
      closeModal();
      showLogin();
      showToast('Local session ended. WhatsApp accounts remain linked.', 'success');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Log out';
    }
  });
}

async function openContacts() {
  state.page = 'contacts';
  state.contacts = null;
  state.pageData.contactSearch = '';
  renderContacts();
  try {
    const contacts = await call('contacts:list', [], { silent: true });
    state.contacts = contacts;
    state.contactsCount = contacts.length;
  } catch (error) {
    state.contacts = [];
    showToast(error.message, 'error');
  }
  if (state.page === 'contacts') renderContacts();
}

function renderContactRows() {
  if (!Array.isArray(state.contacts)) {
    return '<div class="card loading-block"><span class="spinner"></span> Loading contacts…</div>';
  }
  const query = (state.pageData.contactSearch || '').toLowerCase();
  const contacts = state.contacts.filter((contact) => {
    if (!query) return true;
    return (
      (contact.name || '').toLowerCase().includes(query) ||
      (contact.phoneNumber || '').toLowerCase().includes(query)
    );
  });
  if (!contacts.length) {
    return `<div class="card empty-state">
      <div class="empty-icon">${icon('users', 30)}</div>
      <h3>${state.contacts.length ? 'No matching contacts' : 'No contacts yet'}</h3>
      <p>${state.contacts.length ? 'Try a different name or number.' : 'Contacts sync when an account connects. Use refresh to fetch the latest contact names from every linked account.'}</p>
    </div>`;
  }
  return `<div class="list">${contacts.map((contact) => `
    <div class="list-row">
      ${avatar(contact.name || contact.phoneNumber, contact.phoneNumber, 'sm')}
      <div class="row-main">
        <div class="row-title">${esc(contact.name || 'Unknown contact')}</div>
        <div class="row-subtitle">${esc(contact.phoneNumber)}</div>
        ${contact.sourceAccounts && contact.sourceAccounts.length ? `<div class="contact-sources">${esc(contact.sourceAccounts.join(', '))}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function renderContacts() {
  state.page = 'contacts';
  document.getElementById('app-root').innerHTML = `
    ${navbar('Contacts', {
      back: true,
      subtitle: `${Array.isArray(state.contacts) ? state.contacts.length : '…'} known`,
      actions: `<button class="icon-btn" id="refresh-contacts" aria-label="Refresh contacts">${icon('refresh', 21)}</button>`
    })}
    <main class="content">
      <div class="content-inner narrow">
        <div class="contacts-toolbar">
          <div class="search-wrap">
            ${icon('search', 18)}
            <input id="contact-search" class="input" type="text" placeholder="Search name or phone number" value="${esc(state.pageData.contactSearch || '')}" autocomplete="off">
          </div>
        </div>
        <div id="contacts-list-container">
          ${state.contacts === null || state.contacts === undefined
            ? '<div class="card loading-block"><span class="spinner"></span> Loading contacts…</div>'
            : renderContactRows()}
        </div>
      </div>
    </main>`;

  bindNavBack(() => {
    state.page = 'settings';
    renderSettings();
  });

  const search = document.getElementById('contact-search');
  search.addEventListener('input', () => {
    state.pageData.contactSearch = search.value;
    document.getElementById('contacts-list-container').innerHTML = renderContactRows();
  });

  const refresh = document.getElementById('refresh-contacts');
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    refresh.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>`;
    try {
      const result = await call('contacts:refresh', []);
      state.contacts = result.contacts;
      state.contactsCount = result.count;
      document.getElementById('contacts-list-container').innerHTML = renderContactRows();
      showToast(`${result.count} contact${result.count === 1 ? '' : 's'} synced.`, 'success');
    } catch (error) {
      // Error toast is shown by call().
    } finally {
      refresh.disabled = false;
      refresh.innerHTML = icon('refresh', 21);
    }
  });
}

function openAddAdminModal() {
  if (state.accounts.length >= ((state.settings && state.settings.maxAccounts) || 4)) {
    showToast('You can link up to 4 admin accounts.', 'error');
    return;
  }
  openModal(`
    <div class="modal-head">
      <div class="settings-icon">${icon('user', 22)}</div>
      <div><h3>Add new admin account</h3><p>Give this WhatsApp account an alias. It will be joined to your existing groups and promoted by an existing admin.</p></div>
    </div>
    <form id="add-admin-form">
      <div class="field">
        <label for="new-account-alias">Account alias</label>
        <input id="new-account-alias" class="input" type="text" maxlength="40" placeholder="e.g. Account 2" autocomplete="off">
      </div>
    </form>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Cancel</button>
      <button class="btn btn-primary" id="create-account">Show QR code</button>
    </div>`, { wide: true });
  const input = document.getElementById('new-account-alias');
  const button = document.getElementById('create-account');
  setTimeout(() => input.focus(), 60);
  const submit = async () => {
    if (button.disabled) return;
    const alias = input.value.trim();
    if (!alias) {
      showToast('Enter an alias for this account.', 'error');
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const result = await call('accounts:add', [alias], { silent: true });
      state.pendingQr = { accountId: result.id, alias };
      renderQrModal('Scan to link', `Open WhatsApp on the phone for ${alias}, then scan this code.`);
      loadSnapshot().catch(() => {});
    } catch (error) {
      showToast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'Show QR code';
    }
  };
  button.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
}

function currentQrFor(accountId) {
  if (state.lastQr[accountId]) return state.lastQr[accountId];
  const account = state.accounts.find((item) => item.id === accountId);
  return account && account.qr ? account.qr : null;
}

function renderQrModal(title, description) {
  const pending = state.pendingQr;
  if (!pending) return;
  const account = state.accounts.find((item) => item.id === pending.accountId);
  const qr = currentQrFor(pending.accountId);
  openModal(`
    <div class="modal-head">
      <div class="settings-icon">${icon('link', 22)}</div>
      <div><h3>${esc(title)}</h3><p>${esc(description)}</p></div>
    </div>
    <div class="qr-wrap">
      <div class="qr-frame" id="qr-frame">
        ${qr ? `<img src="${qr}" alt="WhatsApp pairing QR code">` : `<div class="qr-loading"><span class="spinner"></span><span id="qr-status-text">Waiting for WhatsApp…</span></div>`}
      </div>
      <ol class="qr-steps">
        <li><span class="step-num">1</span> Open WhatsApp on your phone.</li>
        <li><span class="step-num">2</span> Tap Menu or Settings and choose Linked devices.</li>
        <li><span class="step-num">3</span> Tap Link a device, then point your phone at this screen.</li>
      </ol>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Close</button>
    </div>`, { wide: true });
  const close = () => {
    state.pendingQr = null;
  };
  const closeButton = document.querySelector('[data-close-modal]');
  if (closeButton) closeButton.addEventListener('click', close);
}

function openExistingQr(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  state.pendingQr = { accountId, alias: account.alias };
  renderQrModal('Scan to finish linking', `Scan this code with the phone for ${account.alias}.`);
}

function updateQrModal(payload) {
  state.lastQr[payload.accountId] = payload.qr;
  if (!state.pendingQr || state.pendingQr.accountId !== payload.accountId) return;
  const frame = document.getElementById('qr-frame');
  if (frame) {
    frame.innerHTML = `<img src="${payload.qr}" alt="WhatsApp pairing QR code">`;
  }
}

function openModal(html, options = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${options.wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  state.modalOpen = true;
  root.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      if (options.onClose) options.onClose();
      closeModal();
    });
  });
}

function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  state.modalOpen = false;
}

function openJobErrorsModal(job) {
  const rows = job.errors || [];
  openModal(`
    <div class="modal-head">
      <div class="settings-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('alert', 22)}</div>
      <div><h3>${esc(job.groupName)}</h3><p>${rows.length} number${rows.length === 1 ? '' : 's'} could not be processed for this ${job.type === 'add' ? 'add' : 'remove'} job.</p></div>
    </div>
    <div class="errors-list">
      ${rows.map((error) => {
        const account = error.accountId ? state.accounts.find((item) => item.id === error.accountId) : null;
        return `<div class="error-item"><strong>${esc(error.number)}${error.name ? ` · ${esc(error.name)}` : ''}</strong>${esc(error.error)}${account ? `<div style="opacity:.75;margin-top:3px">Attempted by ${esc(account.alias)}</div>` : ''}</div>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal>Close</button>
    </div>`, { wide: true });
}

function handleAccountsUpdate(accounts) {
  state.accounts = accounts;
  if (state.pendingQr) {
    const pending = state.accounts.find((item) => item.id === state.pendingQr.accountId);
    if (pending && pending.status === 'connected') {
      const alias = pending.alias;
      state.pendingQr = null;
      closeModal();
      showToast(`${alias} connected. It will be added to your managed groups.`, 'success');
      loadSnapshot().then(() => {
        if (state.page === 'settings') renderSettings();
        else if (state.page === 'home') renderHome();
      }).catch(() => {});
      return;
    }
  }
  if (state.page === 'settings') updateSettingsLive();
  else if (state.page === 'home' && !state.modalOpen) renderHome();
}

function handleGroupsUpdate(groups) {
  state.groups = groups;
  if (state.page === 'home' && !state.modalOpen) {
    renderHome();
  } else if (state.page === 'group' && state.currentGroupId) {
    const group = groups.find((item) => item.id === state.currentGroupId);
    if (group) {
      state.pageData.groupSummary = group;
      if (group.members) state.pageData.group = group;
      else if (state.pageData.group) state.pageData.group = { ...state.pageData.group, ...group };
      if (!state.modalOpen) renderGroupPage();
    }
  }
}

function handleJobsUpdate(jobs) {
  state.jobs = jobs;
  if (state.modalOpen) return;
  if (state.page === 'home') renderHome();
  else if (state.page === 'group') renderGroupPage();
}

function subscribeEvents() {
  if (state.subscriptionsReady) return;
  state.subscriptionsReady = true;
  window.api.on('accounts:update', handleAccountsUpdate);
  window.api.on('groups:update', handleGroupsUpdate);
  window.api.on('jobs:update', handleJobsUpdate);
  window.api.on('qr:update', (payload) => {
    if (!payload || !payload.accountId) return;
    updateQrModal(payload);
  });
  window.api.on('toast', (payload) => {
    if (payload && payload.message) showToast(payload.message, payload.type || 'info');
  });
  window.api.on('contacts:update', (payload) => {
    if (payload && typeof payload.count === 'number') state.contactsCount = payload.count;
    if (state.page === 'contacts') {
      call('contacts:list', [], { silent: true }).then((contacts) => {
        state.contacts = contacts;
        state.contactsCount = contacts.length;
        if (state.page === 'contacts') {
          const container = document.getElementById('contacts-list-container');
          if (container) container.innerHTML = renderContactRows();
          const subtitle = document.querySelector('.nav-subtitle');
          if (subtitle) subtitle.textContent = `${contacts.length} known`;
        }
      }).catch(() => {});
    }
  });
  window.api.on('settings:update', (settings) => {
    state.settings = settings;
  });
  window.api.on('auth:changed', (payload) => {
    if (payload && payload.authenticated === false && state.auth) showLogin();
  });
}

async function boot() {
  subscribeEvents();
  try {
    const status = await call('auth:status', [], { silent: true });
    state.hasUser = status.hasUser;
    state.auth = status.authenticated;
    state.dataDir = status.dataDir || '';
    if (status.authenticated) {
      await enterApp();
    } else {
      showLogin();
    }
  } catch (error) {
    showLogin();
    showToast(error.message || 'Could not start the app.', 'error');
  } finally {
    state.booting = false;
  }
}

document.addEventListener('DOMContentLoaded', boot);
