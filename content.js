(function () {
  'use strict';

  const API_BASE = 'https://lexivault.app/api/v1';
  const MYMEMORY = 'https://api.mymemory.translated.net/get';
  const LOGO_URL = chrome.runtime.getURL('assets/logo.ico');

  const LANGUAGES = [
    { code: 'bn', name: 'Bengali'    },
    { code: 'hi', name: 'Hindi'      },
    { code: 'ar', name: 'Arabic'     },
    { code: 'es', name: 'Spanish'    },
    { code: 'fr', name: 'French'     },
    { code: 'pt', name: 'Portuguese' },
    { code: 'tr', name: 'Turkish'    },
    { code: 'ur', name: 'Urdu'       },
    { code: 'id', name: 'Indonesian' },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let floatingIcon         = null;
  let shadowHost           = null;
  let cardShadowRoot       = null;
  let selectionText        = '';
  let selectionRect        = null;
  let outsideClickListener = null;
  let selectionChangeTimer = null;

  // logoDataUrl: loaded once as data: URL so it works on strict-CSP sites
  // (Google, YouTube block chrome-extension:// in img src)
  let logoDataUrl = null;

  // ── Logo loading ──────────────────────────────────────────────────────────
  // Fetch the extension resource and convert to a data URL. Content scripts
  // can fetch chrome-extension:// URLs freely; the resulting data: URL bypasses
  // any host-page Content Security Policy.
  (async function loadLogo() {
    try {
      const resp = await fetch(LOGO_URL);
      if (!resp.ok) return;
      const blob = await resp.blob();
      logoDataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      // If the icon or card was rendered with the "LV" fallback before the
      // logo finished loading, swap them in now so the user sees the real logo.
      if (floatingIcon) applyLogoToElement(floatingIcon);
      if (cardShadowRoot) {
        const img = cardShadowRoot.getElementById('lv-logo');
        const fb  = cardShadowRoot.getElementById('lv-logo-fb');
        if (img) { img.src = logoDataUrl; img.style.display = ''; }
        if (fb)  { fb.style.display = 'none'; }
      }
    } catch (_) {}
  })();

  // ── Init ──────────────────────────────────────────────────────────────────
  // selectionchange fires at document level and cannot be intercepted by page
  // scripts — use it to track selection text reliably on all sites.
  document.addEventListener('selectionchange', onSelectionChange);

  // mouseup (capture phase) is the primary trigger for showing the icon.
  // Capture phase fires before any page bubble-phase handler.
  document.addEventListener('mouseup', onMouseUp, true);

  // ── Selection tracking (selectionchange) ─────────────────────────────────
  function onSelectionChange() {
    clearTimeout(selectionChangeTimer);

    const sel  = window.getSelection();
    const text = sel ? sel.toString().trim() : '';

    if (!text || text.length > 100) {
      selectionText = '';
      // Only hide the icon if the selection was fully cleared
      if (!text) hideFloatingIcon();
      return;
    }

    // Skip if the selected text is inside an editable field
    if (isInEditableField(sel)) {
      selectionText = '';
      hideFloatingIcon();
      return;
    }

    selectionText = text;

    // Fallback path: if mouseup never fires (site swallows it), show the icon
    // after the selection stabilises. mouseup clears this timer when it runs.
    selectionChangeTimer = setTimeout(() => {
      if (!floatingIcon && selectionText) {
        try {
          const range = sel.getRangeAt(0);
          const rect  = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            selectionRect = rect;
            showFloatingIcon();
          }
        } catch (_) {}
      }
    }, 400);
  }

  // ── mouseup (capture): immediate trigger ──────────────────────────────────
  function onMouseUp(e) {
    // Ignore clicks on our own UI elements
    if (floatingIcon && floatingIcon.contains(e.target)) return;
    if (shadowHost   && e.target === shadowHost)          return;

    // Cancel the selectionchange fallback; we handle it here directly
    clearTimeout(selectionChangeTimer);

    // Read the live selection here. Relying on the cached `selectionText`
    // (set by selectionchange) is unreliable — on some sites/browsers the
    // selectionchange event is dispatched *after* mouseup, so the cache is
    // stale at this point and the icon would never appear.
    const sel  = window.getSelection();
    const text = sel ? sel.toString().trim() : '';

    if (!text || text.length > 100 || isInEditableField(sel)) {
      selectionText = '';
      hideFloatingIcon();
      return;
    }

    selectionText = text;

    // Capture the final selection rect; fall back to mouse position for
    // selections inside Shadow DOM (getBoundingClientRect returns zero there)
    try {
      if (sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        selectionRect = (rect.width > 0 || rect.height > 0)
          ? rect
          : { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 };
      } else {
        selectionRect = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 };
      }
    } catch (_) {
      selectionRect = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 };
    }

    showFloatingIcon();
  }

  function isInEditableField(sel) {
    if (!sel || !sel.anchorNode) return false;
    const node = sel.anchorNode.nodeType === Node.TEXT_NODE
      ? sel.anchorNode.parentElement
      : sel.anchorNode;
    return !!(node && node.closest('input, textarea, select, [contenteditable]'));
  }

  // ── Floating icon ─────────────────────────────────────────────────────────
  function showFloatingIcon() {
    if (!selectionRect) return;

    if (!floatingIcon) {
      floatingIcon = document.createElement('div');
      Object.assign(floatingIcon.style, {
        position:       'fixed',
        zIndex:         '2147483647',
        width:          '20px',
        height:         '20px',
        borderRadius:   '40%',
        background:     '#4f46e5',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'pointer',
        boxShadow:      '0 2px 10px rgba(79,70,229,0.55)',
        border:         '2px solid #fff',
        userSelect:     'none',
        transition:     'transform 0.12s ease',
        overflow:       'hidden',
      });

      applyLogoToElement(floatingIcon);

      floatingIcon.addEventListener('mouseenter', () => {
        floatingIcon.style.transform = 'scale(1.15)';
      });
      floatingIcon.addEventListener('mouseleave', () => {
        floatingIcon.style.transform = 'scale(1)';
      });
      floatingIcon.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      });
      floatingIcon.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onIconClick();
      });

      document.body.appendChild(floatingIcon);
    }

    const sz   = 26;
    let left = selectionRect.left + (selectionRect.width || 0) / 2 - sz / 2;
    let top  = selectionRect.top - sz - 8;

    left = Math.max(6, Math.min(left, window.innerWidth  - sz - 6));
    top  = Math.max(6, Math.min(top,  window.innerHeight - sz - 6));

    floatingIcon.style.left    = left + 'px';
    floatingIcon.style.top     = top  + 'px';
    floatingIcon.style.display = 'flex';
  }

  // Fill an element with the logo image (data URL) or the "LV" text fallback
  function applyLogoToElement(el) {
    el.innerHTML = '';
    if (logoDataUrl) {
      const img = document.createElement('img');
      img.src = logoDataUrl;
      Object.assign(img.style, {
        width: '100%', height: '100%',
        objectFit: 'cover', display: 'block',
        pointerEvents: 'none',
      });
      el.appendChild(img);
    } else {
      const fb = document.createElement('span');
      fb.textContent = 'LV';
      Object.assign(fb.style, {
        fontSize: '11px', fontWeight: '700',
        color: '#fff', fontFamily: 'sans-serif',
        pointerEvents: 'none', letterSpacing: '0.3px',
      });
      el.appendChild(fb);
    }
  }

  function hideFloatingIcon() {
    if (floatingIcon) {
      floatingIcon.remove();
      floatingIcon = null;
    }
  }

  // ── Icon click ────────────────────────────────────────────────────────────
  function onIconClick() {
    // Snapshot before any async gap so the word is safe even if selection clears
    const word = selectionText;
    const rect = selectionRect;

    hideFloatingIcon();
    removeOutsideClickListener();

    if (!word) return;

    // The outside-click listener is installed inside createCard, after the
    // shadow host actually exists — installing it here would race with the
    // async storage read inside createCard and could leave the card with no
    // close-on-outside behaviour.
    createCard(word, rect);
  }

  function removeOutsideClickListener() {
    if (outsideClickListener) {
      document.removeEventListener('mousedown', outsideClickListener, true);
      outsideClickListener = null;
    }
  }

  // ── Card lifecycle ────────────────────────────────────────────────────────
  function closeCard() {
    if (shadowHost) {
      shadowHost.remove();
      shadowHost     = null;
      cardShadowRoot = null;
    }
  }

  async function createCard(word, rect) {
    closeCard();

    let lxDefaultLang = 'bn';
    try {
      const stored = await chrome.storage.local.get(['lxDefaultLang']);
      if (stored && stored.lxDefaultLang) lxDefaultLang = stored.lxDefaultLang;
    } catch (_) {}

    // After the await, guard against the user having dismissed already
    if (!word) return;

    shadowHost = document.createElement('div');
    Object.assign(shadowHost.style, {
      position: 'fixed',
      zIndex:   '2147483646',
      width:    '300px',
      top:      '-9999px',
      left:     '-9999px',
    });

    cardShadowRoot = shadowHost.attachShadow({ mode: 'open' });
    cardShadowRoot.innerHTML = buildCSS() + buildHTML(lxDefaultLang);
    document.body.appendChild(shadowHost);

    positionCard(rect);
    attachListeners(word);

    const titleEl = cardShadowRoot.getElementById('lv-word');
    if (titleEl) titleEl.textContent = word;

    // Install outside-click only now that the shadow host actually exists.
    // setTimeout(0) defers past the current mousedown so the click that
    // opened the card doesn't immediately close it.
    setTimeout(installOutsideClickListener, 0);

    await fetchTranslation(word, lxDefaultLang);
  }

  function installOutsideClickListener() {
    removeOutsideClickListener();
    outsideClickListener = function (e) {
      // Clicks inside the shadow root retarget to shadowHost at the document
      // level, so this single check covers all in-card interactions.
      if (shadowHost && e.target === shadowHost) return;
      closeCard();
      removeOutsideClickListener();
    };
    // Capture phase so this fires even when the page swallows bubble events
    document.addEventListener('mousedown', outsideClickListener, true);
  }

  function positionCard(rect) {
    if (!shadowHost || !rect) return;

    const CARD_W = 300;
    const CARD_H = 210;

    let top  = (rect.bottom || rect.top) + 10;
    let left = rect.left || 0;

    if (left + CARD_W > window.innerWidth  - 8) left = window.innerWidth  - CARD_W - 8;
    if (top  + CARD_H > window.innerHeight - 8) top  = (rect.top || 0)    - CARD_H - 10;

    shadowHost.style.left = Math.max(8, left) + 'px';
    shadowHost.style.top  = Math.max(8, top)  + 'px';
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  function buildHTML(defaultLang) {
    const logoSrc  = logoDataUrl || '';
    const imgStyle = logoSrc  ? '' : 'display:none;';
    const fbStyle  = logoSrc  ? 'display:none;' : '';

    const opts = LANGUAGES.map(l =>
      `<option value="${l.code}"${l.code === defaultLang ? ' selected' : ''}>${l.name}</option>`
    ).join('');

    return `
      <div id="lv-card">
        <div id="lv-header">
          <div id="lv-logo-wrap">
            <img id="lv-logo" src="${logoSrc}" alt="" style="${imgStyle}">
            <span id="lv-logo-fb" style="${fbStyle}">LV</span>
          </div>
          <span id="lv-word"></span>
          <button id="lv-close" aria-label="Close">&#x2715;</button>
        </div>

        <div id="lv-lang-row">
          <span id="lv-lang-label">TO</span>
          <select id="lv-lang-select">${opts}</select>
        </div>

        <div id="lv-meaning-area">
          <div id="lv-spinner-wrap"><div id="lv-spinner"></div></div>
          <div id="lv-meaning"></div>
          <button id="lv-edit-btn" aria-label="Edit meaning">&#9998; Edit</button>
          <textarea id="lv-manual" placeholder="Enter meaning here…"></textarea>
        </div>

        <div id="lv-status" role="alert" aria-live="polite"></div>

        <div id="lv-footer">
          <button id="lv-save" disabled>
            <span id="lv-save-label">Save to LexiVault</span>
          </button>
        </div>
      </div>
    `;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function buildCSS() {
    return `<style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      #lv-card {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        width: 300px;
        background: #ffffff;
        border-radius: 10px;
        border-top: 3px solid #4f46e5;
        box-shadow: 0 4px 24px rgba(0,0,0,0.13), 0 1px 6px rgba(0,0,0,0.07);
        overflow: hidden;
      }

      #lv-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 11px 9px;
        background: #ffffff;
        border-bottom: 1px solid #f0f0f0;
      }

      #lv-logo-wrap {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        border-radius: 5px;
        overflow: hidden;
        background: #4f46e5;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #lv-logo {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      #lv-logo-fb {
        font-size: 9px;
        font-weight: 800;
        color: #fff;
        letter-spacing: 0.2px;
        line-height: 1;
      }

      #lv-word {
        flex: 1;
        font-size: 15px;
        font-weight: 600;
        color: #111827;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #lv-close {
        all: unset;
        cursor: pointer;
        color: #9ca3af;
        font-size: 13px;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        flex-shrink: 0;
        transition: color 0.1s, background 0.1s;
      }
      #lv-close:hover { color: #374151; background: #f3f4f6; }

      #lv-lang-row {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 11px;
        background: #fafafa;
        border-bottom: 1px solid #f0f0f0;
      }

      #lv-lang-label {
        font-size: 10px;
        font-weight: 700;
        color: #9ca3af;
        letter-spacing: 0.8px;
        flex-shrink: 0;
      }

      #lv-lang-select {
        flex: 1;
        font-size: 12.5px;
        color: #374151;
        font-weight: 500;
        border: 1px solid #e5e7eb;
        border-radius: 5px;
        padding: 4px 6px;
        background: #ffffff;
        cursor: pointer;
        outline: none;
        font-family: inherit;
        transition: border-color 0.15s;
      }
      #lv-lang-select:focus { border-color: #4f46e5; }

      #lv-meaning-area {
        padding: 16px 12px 12px;
        min-height: 72px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }

      #lv-spinner-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
      }

      #lv-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid #e5e7eb;
        border-top-color: #4f46e5;
        border-radius: 50%;
        animation: lv-spin 0.7s linear infinite;
      }

      @keyframes lv-spin { to { transform: rotate(360deg); } }

      #lv-meaning {
        display: none;
        width: 100%;
        font-size: 20px;
        font-weight: 700;
        color: #111827;
        text-align: center;
        line-height: 1.4;
        word-break: break-word;
        letter-spacing: -0.01em;
      }

      #lv-edit-btn {
        display: none;
        all: unset;
        cursor: pointer;
        font-size: 11px;
        color: #6b7280;
        padding: 3px 9px;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        font-family: inherit;
        transition: color 0.1s, border-color 0.1s;
      }
      #lv-edit-btn:hover { color: #4f46e5; border-color: #c7d2fe; }

      #lv-manual {
        display: none;
        width: 100%;
        min-height: 58px;
        font-size: 13px;
        color: #374151;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        padding: 7px 9px;
        resize: vertical;
        font-family: inherit;
        outline: none;
        line-height: 1.5;
        background: #fafafa;
      }
      #lv-manual:focus {
        border-color: #4f46e5;
        box-shadow: 0 0 0 2px rgba(79,70,229,0.1);
        background: #fff;
      }

      #lv-status {
        padding: 0 12px;
        font-size: 11.5px;
        line-height: 1.4;
      }
      #lv-status.success { color: #059669; padding-bottom: 5px; }
      #lv-status.error   { color: #dc2626; padding-bottom: 5px; }
      #lv-status.warn    { color: #b45309; padding-bottom: 5px; }

      #lv-footer {
        padding: 8px 12px 12px;
        border-top: 1px solid #f0f0f0;
      }

      #lv-save {
        all: unset;
        display: block;
        width: 100%;
        background: #4f46e5;
        color: #ffffff;
        border-radius: 7px;
        padding: 9px 0;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        letter-spacing: 0.01em;
        transition: background 0.15s;
      }
      #lv-save:hover:not(:disabled) { background: #4338ca; }
      #lv-save:disabled { opacity: 0.4; cursor: not-allowed; }
    </style>`;
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  function attachListeners(word) {
    const root = cardShadowRoot;
    if (!root) return;

    root.getElementById('lv-close').addEventListener('click', () => {
      closeCard();
      removeOutsideClickListener();
    });

    root.getElementById('lv-lang-select').addEventListener('change', async e => {
      const lang = e.target.value;
      chrome.storage.local.set({ lxDefaultLang: lang });
      await fetchTranslation(word, lang);
    });

    root.getElementById('lv-edit-btn').addEventListener('click', () => {
      const meaningEl = root.getElementById('lv-meaning');
      const editBtn   = root.getElementById('lv-edit-btn');
      const manual    = root.getElementById('lv-manual');
      const saveBtn   = root.getElementById('lv-save');

      manual.value            = meaningEl.textContent.trim();
      meaningEl.style.display = 'none';
      editBtn.style.display   = 'none';
      manual.style.display    = 'block';
      saveBtn.disabled        = manual.value.trim().length === 0;
      manual.focus();
      manual.select();
    });

    root.getElementById('lv-manual').addEventListener('input', () => {
      if (!cardShadowRoot) return;
      const manual  = root.getElementById('lv-manual');
      const saveBtn = root.getElementById('lv-save');
      saveBtn.disabled = manual.value.trim().length === 0;
    });

    root.getElementById('lv-save').addEventListener('click', async () => {
      await saveWord(word);
    });
  }

  // ── Translation ───────────────────────────────────────────────────────────
  // MyMemory occasionally returns scraped metadata (tutorials, code comments)
  // instead of a real translation. Catch the most common pollution patterns.
  function isGarbageTranslation(word, translated) {
    const t = translated.trim();
    // Contains a URL → definitely not a word translation
    if (/https?:\/\//i.test(t)) return true;
    // For single-word input the result should stay short; a long sentence
    // means MyMemory matched a document excerpt rather than the word itself
    if (!word.includes(' ') && t.length > 120) return true;
    return false;
  }

  async function fetchTranslation(word, langCode) {
    const root = cardShadowRoot;
    if (!root) return;

    const spinnerWrap = root.getElementById('lv-spinner-wrap');
    const meaning     = root.getElementById('lv-meaning');
    const editBtn     = root.getElementById('lv-edit-btn');
    const manual      = root.getElementById('lv-manual');
    const saveBtn     = root.getElementById('lv-save');
    const statusEl    = root.getElementById('lv-status');

    spinnerWrap.style.display = 'flex';
    meaning.style.display     = 'none';
    editBtn.style.display     = 'none';
    manual.style.display      = 'none';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
    saveBtn.disabled = true;

    try {
      const url  = `${MYMEMORY}?q=${encodeURIComponent(word)}&langpair=en|${langCode}`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (!cardShadowRoot) return;

      const translated = data?.responseData?.translatedText;
      const status     = data?.responseStatus;

      if (
        translated &&
        status === 200 &&
        translated.toLowerCase().trim() !== word.toLowerCase().trim() &&
        !isGarbageTranslation(word, translated)
      ) {
        spinnerWrap.style.display = 'none';
        meaning.style.display     = 'block';
        editBtn.style.display     = 'block';
        meaning.textContent       = translated.slice(0, 500);
        saveBtn.disabled = false;
      } else {
        showManualFallback('No translation found. Enter a meaning manually:');
      }
    } catch (_) {
      if (!cardShadowRoot) return;
      showManualFallback('Translation unavailable. Enter a meaning manually:');
    }
  }

  function showManualFallback(hintText) {
    const root = cardShadowRoot;
    if (!root) return;

    root.getElementById('lv-spinner-wrap').style.display = 'none';
    root.getElementById('lv-meaning').style.display      = 'none';
    root.getElementById('lv-edit-btn').style.display     = 'none';

    const manual  = root.getElementById('lv-manual');
    const saveBtn = root.getElementById('lv-save');

    manual.placeholder   = hintText;
    manual.value         = '';
    manual.style.display = 'block';
    saveBtn.disabled     = true;
  }

  function getCurrentMeaning() {
    const root = cardShadowRoot;
    if (!root) return null;

    const manual  = root.getElementById('lv-manual');
    const meaning = root.getElementById('lv-meaning');

    if (manual.style.display !== 'none') {
      return manual.value.trim().slice(0, 500) || null;
    }
    return meaning.textContent.trim().slice(0, 500) || null;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveWord(word) {
    const root = cardShadowRoot;
    if (!root) return;

    const saveBtn   = root.getElementById('lv-save');
    const saveLabel = root.getElementById('lv-save-label');

    const meaning = getCurrentMeaning();
    if (!meaning) {
      setStatus('Please enter a meaning first.', 'error');
      return;
    }

    const { lxApiKey } = await chrome.storage.local.get(['lxApiKey']);
    if (!lxApiKey) {
      setStatus('No API key — click the extension icon in the toolbar.', 'error');
      return;
    }

    if (!cardShadowRoot) return;

    saveBtn.disabled      = true;
    saveLabel.textContent = 'Saving…';

    try {
      const resp = await fetch(`${API_BASE}/words`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${lxApiKey}`,
        },
        body: JSON.stringify({ englishWord: word, meaning, tags: 'extension' }),
      });

      if (!cardShadowRoot) return;

      if (resp.status === 201) {
        setStatus('Saved  +5 XP ✓', 'success');
        saveLabel.textContent = 'Saved ✓';
        return;
      }

      saveLabel.textContent = 'Save to LexiVault';
      let body = {};
      try { body = await resp.json(); } catch (_) {}

      if (resp.status === 401 || resp.status === 403) {
        setStatus('Invalid or expired API key.', 'error');
        saveBtn.disabled = true;
      } else if (resp.status === 409) {
        setStatus('Already in your vault.', 'warn');
        saveLabel.textContent = 'Already Saved';
        saveBtn.disabled      = true;
      } else if (resp.status === 422) {
        setStatus(body?.error?.message || 'Validation error.', 'error');
        saveBtn.disabled = false;
      } else {
        setStatus('Save failed. Try again.', 'error');
        saveBtn.disabled = false;
      }
    } catch (_) {
      if (!cardShadowRoot) return;
      saveLabel.textContent = 'Save to LexiVault';
      saveBtn.disabled      = false;
      setStatus('Save failed. Check your connection.', 'error');
    }
  }

  function setStatus(msg, type) {
    const root = cardShadowRoot;
    if (!root) return;
    const el = root.getElementById('lv-status');
    if (!el) return;
    el.textContent = msg;
    el.className   = type;
  }

})();
