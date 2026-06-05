// Tab Switcher Dynamic — Background Service Worker
//
// KEY DESIGN DECISION — favicons:
//   Content scripts run in the HOST PAGE's security context (e.g. mail.google.com).
//   Loading an <img> from a local-network address (router, NAS, localhost…) inside
//   a content script triggers Chrome's Private Network Access (PNA) permission
//   prompt — which STEALS KEYBOARD FOCUS and breaks the Ctrl+Q cycling entirely.
//
//   Fix: ALL favicon fetching happens HERE in the service worker.
//   Extensions with <all_urls> host permission may fetch any URL, including
//   private IPs, without triggering PNA prompts.
//   We convert every favicon to a base64 data: URL before it ever reaches the
//   content script.  Content scripts receive ONLY data: or null — zero network
//   requests, zero PNA prompts.

'use strict';

const KEY_MRU   = 'mruStack';
const KEY_THUMB = 'thumbnails';
const KEY_FAVI  = 'favicons';

const MAX_STACK = 50;
const MAX_THUMB = 30;
const MAX_FAVI  = 60;

// ─── Session-storage helpers ──────────────────────────────────────────────────

async function getMRU()       { const r = await chrome.storage.session.get(KEY_MRU);   return r[KEY_MRU]   ?? []; }
async function setMRU(v)      { await chrome.storage.session.set({ [KEY_MRU]:   v }); }
async function getThumbs()    { const r = await chrome.storage.session.get(KEY_THUMB); return r[KEY_THUMB] ?? {}; }
async function getFaviCache() { const r = await chrome.storage.session.get(KEY_FAVI);  return r[KEY_FAVI]  ?? {}; }
async function setFaviCache(v){ await chrome.storage.session.set({ [KEY_FAVI]: v }); }

// ─── MRU maintenance ─────────────────────────────────────────────────────────

async function touchTab(tabId) {
  let s = await getMRU();
  s = s.filter(id => id !== tabId);
  s.unshift(tabId);
  if (s.length > MAX_STACK) s.length = MAX_STACK;
  await setMRU(s);
}

// ─── Screenshot capture ───────────────────────────────────────────────────────

function scheduleCapture(windowId, tabId) {
  setTimeout(async () => {
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 40 });
      const t = await getThumbs();
      t[String(tabId)] = url;
      const keys = Object.keys(t);
      if (keys.length > MAX_THUMB) delete t[keys[0]];
      await chrome.storage.session.set({ [KEY_THUMB]: t });
    } catch { /* chrome://, PDFs, etc. */ }
  }, 400);
}

// ─── Favicon → data URL ───────────────────────────────────────────────────────

// FileReader is NOT available in service workers; use ArrayBuffer + btoa instead.
async function blobToDataUrl(blob) {
  if (!blob || blob.size === 0) return null;
  const ab    = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let str = '';
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    for (let j = i; j < end; j++) str += String.fromCharCode(bytes[j]);
  }
  return `data:${blob.type || 'image/x-icon'};base64,${btoa(str)}`;
}

async function cacheFavicon(tabId, favIconUrl) {
  if (!favIconUrl) return;

  // Already a data URL — store it directly, no fetch needed
  if (favIconUrl.startsWith('data:')) {
    const c = await getFaviCache();
    c[String(tabId)] = favIconUrl;
    const keys = Object.keys(c);
    if (keys.length > MAX_FAVI) delete c[keys[0]];
    await setFaviCache(c);
    return;
  }

  // Fetch from network — extension service workers can fetch any URL in
  // their host_permissions without triggering PNA UI prompts.
  try {
    const res = await fetch(favIconUrl, { credentials: 'omit' });
    if (!res.ok) return;
    const dataUrl = await blobToDataUrl(await res.blob());
    if (!dataUrl) return;
    const c = await getFaviCache();
    c[String(tabId)] = dataUrl;
    const keys = Object.keys(c);
    if (keys.length > MAX_FAVI) delete c[keys[0]];
    await setFaviCache(c);
  } catch { /* unreachable host, etc. — silently skip */ }
}

// ─── Tab event listeners ──────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  touchTab(tabId);
  scheduleCapture(windowId, tabId);
  // Fetch & cache this tab's favicon (non-blocking)
  chrome.tabs.get(tabId)
    .then(tab => { if (tab.favIconUrl) cacheFavicon(tabId, tab.favIconUrl); })
    .catch(() => {});
});

// Cache updated favicons as tabs navigate
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.favIconUrl) cacheFavicon(tabId, changeInfo.favIconUrl);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  let stack = await getMRU();
  stack = stack.filter(id => id !== tabId);
  await setMRU(stack);
  const [thumbs, favis] = await Promise.all([getThumbs(), getFaviCache()]);
  delete thumbs[String(tabId)];
  delete favis[String(tabId)];
  await Promise.all([
    chrome.storage.session.set({ [KEY_THUMB]: thumbs }),
    setFaviCache(favis)
  ]);
});

// ─── Seed on install / startup ────────────────────────────────────────────────

async function seedIfEmpty() {
  const stack = await getMRU();
  if (stack.length > 0) return;
  const tabs = await chrome.tabs.query({});
  await setMRU(tabs.map(t => t.id));
  // Kick off favicon caching for every open tab (non-blocking)
  for (const t of tabs) {
    if (t.favIconUrl) cacheFavicon(t.id, t.favIconUrl);
  }
}

chrome.runtime.onInstalled.addListener(seedIfEmpty);
chrome.runtime.onStartup.addListener(seedIfEmpty);

// ─── Build switcher payload ───────────────────────────────────────────────────

async function buildPayload(windowId) {
  const [stack, thumbs, faviCache, windowTabs] = await Promise.all([
    getMRU(),
    getThumbs(),
    getFaviCache(),
    chrome.tabs.query({ windowId })
  ]);

  const byId = Object.fromEntries(windowTabs.map(t => [t.id, t]));

  // All MRU-tracked tabs in this window (most-recent-first)
  const trackedIds   = stack.filter(id => byId[id]);
  // Any tab that opened before the extension was installed (never onActivated'd)
  const untrackedIds = windowTabs.map(t => t.id).filter(id => !stack.includes(id));
  const orderedIds   = [...trackedIds, ...untrackedIds];

  const tabs = orderedIds.map(id => ({
    id,
    title:       byId[id].title || 'Untitled',
    url:         byId[id].url   || '',
    faviDataUrl: faviCache[String(id)] || null,  // ← always data: or null, NEVER a raw URL
    thumbnail:   thumbs[String(id)]   || null,   // ← always data: or null
  }));

  return { tabs };
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

async function getSettings() {
  const r = await chrome.storage.sync.get({ overlayEnabled: true });
  return r;
}

// ─── Command: open the switcher ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-switcher') return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;

  const payload = await buildPayload(activeTab.windowId);
  if (payload.tabs.length < 2) return;

  const { overlayEnabled } = await getSettings();

  const sent = await sendToTab(activeTab.id, { type: 'TSD_SHOW', headless: !overlayEnabled, ...payload });
  if (!sent) {
    // Tab was open before the extension was installed — inject the content script now
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
      await sendToTab(activeTab.id, { type: 'TSD_SHOW', headless: !overlayEnabled, ...payload });
    } catch {
      // Restricted page (chrome://, new tab, Web Store, PDF) — can't inject.
      // Fall back: jump directly to the most-recently-used other tab so the
      // user isn't left stranded.  They can then press Ctrl+Q again on that
      // normal tab to get the full overlay.
      const next = payload.tabs.find(t => t.id !== activeTab.id);
      if (next) chrome.tabs.update(next.id, { active: true });
    }
  }
});

async function sendToTab(tabId, msg) {
  try { await chrome.tabs.sendMessage(tabId, msg); return true; }
  catch { return false; }
}

// ─── Messages from content script ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TSD_SWITCH') {
    chrome.tabs.update(msg.tabId, { active: true });
    return;
  }
  if (msg.type === 'TSD_GET_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (!active) { sendResponse(null); return; }
      buildPayload(active.windowId).then(sendResponse);
    });
    return true;
  }
});
