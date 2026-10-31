const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'auth:status',
  'auth:setup',
  'auth:login',
  'auth:logoutApp',
  'app:snapshot',
  'groups:fetchAvailable',
  'groups:add',
  'groups:get',
  'groups:refresh',
  'groups:deleteLocal',
  'members:context',
  'jobs:create',
  'jobs:list',
  'jobs:dismiss',
  'contacts:list',
  'contacts:refresh',
  'accounts:list',
  'accounts:add',
  'accounts:relink',
  'accounts:remove',
  'settings:get',
  'settings:update',
  'import:parse',
  'app:dataDir'
]);

const EVENT_CHANNELS = new Set([
  'accounts:update',
  'groups:update',
  'jobs:update',
  'contacts:update',
  'qr:update',
  'toast',
  'auth:changed',
  'settings:update'
]);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.resolve({ ok: false, error: `Blocked channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform
});
