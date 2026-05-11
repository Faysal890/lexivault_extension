const KEY_STORAGE  = 'lxApiKey';
const LANG_STORAGE = 'lxDefaultLang';

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('api-key');
  const toggleBtn   = document.getElementById('toggle-key');
  const eyeIcon     = document.getElementById('eye-icon');
  const langSelect  = document.getElementById('default-lang');
  const saveBtn     = document.getElementById('save-btn');
  const statusEl    = document.getElementById('save-status');
  const statusDot   = document.getElementById('status-dot');
  const statusText  = document.getElementById('status-text');
  const keyToggle   = document.getElementById('key-toggle');
  const keySection  = document.getElementById('key-section');
  const chevron     = document.getElementById('chevron');
  const headerLogo  = document.getElementById('header-logo');

  if (headerLogo) {
    headerLogo.onerror = () => headerLogo.classList.add('hidden');
  }

  // ── Load saved settings ────────────────────────────────────────────────
  const stored = await chrome.storage.local.get([KEY_STORAGE, LANG_STORAGE]);

  if (stored[KEY_STORAGE]) {
    apiKeyInput.value = stored[KEY_STORAGE];
    setConnected(stored[KEY_STORAGE]);
  }

  if (stored[LANG_STORAGE]) langSelect.value = stored[LANG_STORAGE];

  // ── Collapse toggle ────────────────────────────────────────────────────
  keyToggle.addEventListener('click', () => {
    const open = keySection.classList.toggle('open');
    chevron.classList.toggle('open', open);
    keyToggle.setAttribute('aria-expanded', String(open));
  });

  // ── Show / hide key value ──────────────────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    const hidden        = apiKeyInput.type === 'password';
    apiKeyInput.type    = hidden ? 'text' : 'password';
    eyeIcon.textContent = hidden ? '🔒' : '👁';
  });

  // ── Save ──────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const key  = apiKeyInput.value.trim();
    const lang = langSelect.value;

    if (key && !/^lx_[a-zA-Z0-9]+_[a-zA-Z0-9]+$/.test(key)) {
      showStatus('Key should start with "lx_". Check you copied the full key.', 'warn');
      return;
    }

    if (key) {
      await chrome.storage.local.set({ [KEY_STORAGE]: key, [LANG_STORAGE]: lang });
      setConnected(key);
    } else {
      await chrome.storage.local.remove(KEY_STORAGE);
      await chrome.storage.local.set({ [LANG_STORAGE]: lang });
      setDisconnected();
    }

    showStatus('Settings saved!', 'success');
  });

  // ── Helpers ───────────────────────────────────────────────────────────
  function setConnected(key) {
    statusDot.className    = 'status-dot connected';
    statusText.textContent = `Connected  ·  ${key.slice(0, 14)}…`;
  }

  function setDisconnected() {
    statusDot.className    = 'status-dot';
    statusText.textContent = 'No API key set';
  }

  function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className   = type;
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className   = '';
    }, 3000);
  }
});
