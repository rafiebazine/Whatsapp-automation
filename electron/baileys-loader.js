let loader = null;

function loadBaileys() {
  if (!loader) {
    loader = import('@whiskeysockets/baileys');
  }
  return loader;
}

module.exports = { loadBaileys };
