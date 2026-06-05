// Tab Switcher Dynamic — Content Script
//
// Renders the HUD overlay with Firefox-style MRU cycling.
//
// ── Interaction model ──────────────────────────────────────────────────────────
//   Ctrl+Q                → open overlay, pre-select index 1 (most-recent other tab)
//   Ctrl+Q  (again, held) → advance selection  (next less-recent tab)
//   Ctrl+Shift+Q          → retreat selection  (next more-recent tab)
//   ← → / Tab / Shift+Tab → same navigation
//   Release Ctrl          → commit  (Firefox-style: release to jump)
//   Enter / card click    → commit
//   Escape                → cancel (stay on current tab)
//
// ── No network requests ────────────────────────────────────────────────────────
//   The background service worker pre-fetches all favicons and sends them as
//   base64 data: URLs.  This script never loads any external URL, which
//   eliminates Chrome's Private Network Access (PNA) popup entirely.

(function () {
  'use strict';

  if (window.__tsd_injected) return;   // prevent double-injection
  window.__tsd_injected = true;

  // ── State ───────────────────────────────────────────────────────────────────
  let host          = null;
  let shadow        = null;
  let tabs          = [];
  let selIdx        = 1;
  let mouseHasMoved = false;   // true once mouse actually moves after overlay opens
  let headless      = false;   // true when overlay is disabled — cycle silently, no DOM

  // Bug fix: listen for Control keyup at all times (not just after open() completes).
  // If the user releases Ctrl before the async message → open() chain finishes,
  // the event would otherwise be missed and the overlay would stay stuck open.
  document.addEventListener('keyup', (e) => {
    if (isOpen() && (e.key === 'Control' || e.key === 'Meta')) commit();
  }, true);

  // ── Message listener ────────────────────────────────────────────────────────
  // TSD_SHOW fires every time the user presses Ctrl+Q (the extension command).
  // Chrome intercepts the Ctrl+Q keydown at the browser level, so the content
  // script's keydown listener NEVER sees it — the only way to know another Q
  // was pressed is via this message from the background.
  // → First press:      open the overlay at index 1 (most-recent other tab)
  // → Subsequent presses (Ctrl still held): advance the selection by one step
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TSD_SHOW') {
      if (!isOpen()) {
        open(msg.tabs, msg.headless);   // first press — show overlay (or start headless cycle)
      } else {
        move(+1);                       // Ctrl still held, Q pressed again — cycle forward
      }
    }
  });

  // ── Open ────────────────────────────────────────────────────────────────────
  function isOpen() { return host !== null || headless; }

  function open(tabList, isHeadless) {
    if (isOpen() || !tabList || tabList.length < 2) return;

    tabs      = tabList;
    selIdx    = Math.min(1, tabs.length - 1);
    headless  = !!isHeadless;

    if (headless) {
      // No DOM — just track state and wait for Ctrl release or Enter.
      // The always-on keyup listener (below) will call commit() on Ctrl release.
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup',   onKeyUp,   true);
      return;
    }

    host = document.createElement('div');
    host.id = '__tsd_host';
    Object.assign(host.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'auto', fontFamily: 'initial'
    });

    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = buildHTML();
    injectStyles();
    document.body.appendChild(host);
    document.body.style.overflow = 'hidden';

    mouseHasMoved = false;

    shadow.querySelectorAll('.card').forEach((card, i) => {
      card.addEventListener('click',      () => { selIdx = i; commit(); });
      // Only update selection on hover if the mouse has actually moved since the
      // overlay opened — prevents phantom selection when the cursor happens to be
      // sitting over a card at the moment the overlay appears.
      card.addEventListener('mouseenter', () => { if (mouseHasMoved) { selIdx = i; updateHighlight(); } });
    });
    shadow.getElementById('backdrop').addEventListener('click', cancel);

    // Use plain boolean (true) instead of options object — avoids a subtle
    // removeEventListener mismatch bug in some Chrome versions.
    document.addEventListener('keydown',   onKeyDown,   true);
    document.addEventListener('keyup',     onKeyUp,     true);
    document.addEventListener('mousemove', onMouseMove, true);

    requestAnimationFrame(scrollToSelected);
  }

  // ── Destroy ──────────────────────────────────────────────────────────────────
  function destroy() {
    if (!isOpen()) return;
    document.removeEventListener('keydown',   onKeyDown,   true);
    document.removeEventListener('keyup',     onKeyUp,     true);
    document.removeEventListener('mousemove', onMouseMove, true);
    if (host) {
      document.body.style.overflow = '';
      host.remove();
      host = shadow = null;
    }
    headless = false;
    tabs = []; selIdx = 1;
  }

  function commit() {
    if (!isOpen()) return;
    const tab = tabs[selIdx];
    destroy();
    if (tab) chrome.runtime.sendMessage({ type: 'TSD_SWITCH', tabId: tab.id });
  }

  function cancel() { destroy(); }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  function onKeyDown(e) {
    if (!isOpen()) return;

    // NOTE: Ctrl+Q is NOT handled here. Chrome intercepts it as an extension
    // command and never fires the keydown event on the page. Cycling via Ctrl+Q
    // is handled in the TSD_SHOW message listener above instead.

    switch (e.key) {
      case 'Tab':
        e.preventDefault(); e.stopPropagation();
        move(e.shiftKey ? -1 : +1);
        break;
      case 'ArrowRight': case 'ArrowDown':
        e.preventDefault(); e.stopPropagation();
        move(+1); break;
      case 'ArrowLeft': case 'ArrowUp':
        e.preventDefault(); e.stopPropagation();
        move(-1); break;
      case 'Enter':
        e.preventDefault(); e.stopPropagation();
        commit(); break;
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        cancel(); break;
    }
  }

  function onMouseMove() { mouseHasMoved = true; }

  // onKeyUp is intentionally empty — Ctrl release is handled by the always-on
  // listener added at init time (above), which avoids a race where Ctrl is
  // released before open() finishes and no listener exists yet.
  function onKeyUp(_e) {}

  // ── Navigation ───────────────────────────────────────────────────────────────
  function move(delta) {
    selIdx = (selIdx + delta + tabs.length) % tabs.length;
    updateHighlight();
    scrollToSelected();
  }

  function updateHighlight() {
    shadow && shadow.querySelectorAll('.card').forEach((el, i) =>
      el.classList.toggle('selected', i === selIdx)
    );
  }

  function scrollToSelected() {
    const card = shadow && shadow.querySelector('.card.selected');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // ── HTML ─────────────────────────────────────────────────────────────────────
  function buildHTML() {
    return `
      <div id="backdrop"></div>
      <div id="panel" role="dialog" aria-label="Tab Switcher Dynamic">
        <div id="header">
          <span id="hdr-icon">⇥</span>
          <span id="hdr-name">Tab Switcher Dynamic</span>
          <span id="hdr-count">${tabs.length} tab${tabs.length !== 1 ? 's' : ''}</span>
        </div>
        <div id="track-wrap"><div id="track">${tabs.map(buildCard).join('')}</div></div>
        <div id="hint">
          <kbd>Ctrl+Q</kbd> cycle &nbsp;·&nbsp;
          <kbd>←</kbd><kbd>→</kbd> navigate &nbsp;·&nbsp;
          <kbd>Enter</kbd> switch &nbsp;·&nbsp;
          <kbd>Esc</kbd> cancel
        </div>
      </div>`;
  }

  function buildCard(tab, i) {
    const sel  = i === selIdx;
    const curr = i === 0;

    // ── Thumbnail ──
    // tab.thumbnail  → data: JPEG captured by background  — safe, no network request
    // tab.faviDataUrl → data: URL fetched by background    — safe, no network request
    // Fallback       → CSS colour derived from URL         — safe, no network request
    let thumbHtml;
    if (tab.thumbnail) {
      thumbHtml = `<img class="thumb" src="${tab.thumbnail}" alt="">`;
    } else {
      const bg  = hashColor(tab.url);
      const ico = tab.faviDataUrl
        ? `<img class="fi-big" src="${esc(tab.faviDataUrl)}" alt="">`
        : `<span class="fi-default">🌐</span>`;
      thumbHtml = `<div class="thumb thumb-fb" style="background:${bg}">${ico}</div>`;
    }

    // ── Footer favicon ──
    const favHtml = tab.faviDataUrl
      ? `<img class="fav" src="${esc(tab.faviDataUrl)}" alt="">`
      : `<span class="fav fav-empty">🌐</span>`;

    const badge = curr ? `<span class="badge">Current</span>` : '';

    return `
      <div class="card${sel ? ' selected' : ''}${curr ? ' current' : ''}" data-i="${i}">
        <div class="thumb-wrap">${thumbHtml}${badge}</div>
        <div class="foot">${favHtml}<span class="title">${esc(tab.title || urlHost(tab.url) || 'Untitled')}</span></div>
      </div>`;
  }

  // ── Styles (Shadow DOM — fully isolated from host page CSS) ──────────────────
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      #backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.6);
        backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
      }
      #panel {
        position: relative;
        background: rgba(14,14,22,.95);
        backdrop-filter: blur(30px) saturate(160%);
        -webkit-backdrop-filter: blur(30px) saturate(160%);
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 18px;
        padding: 18px 20px 16px;
        max-width: min(92vw, 960px); min-width: 340px;
        box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 48px 96px rgba(0,0,0,.8);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        user-select: none;
      }
      #header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
      #hdr-icon  { font-size: 18px; line-height: 1; }
      #hdr-name  { font-size: 13px; font-weight: 600; color: rgba(255,255,255,.85); flex: 1; }
      #hdr-count {
        font-size: 11px; color: rgba(255,255,255,.3);
        background: rgba(255,255,255,.08); padding: 2px 8px; border-radius: 99px;
      }
      #track-wrap {
        overflow-x: auto; overflow-y: hidden;
        scrollbar-width: none; -ms-overflow-style: none; padding-bottom: 2px;
      }
      #track-wrap::-webkit-scrollbar { display: none; }
      #track { display: flex; gap: 10px; padding: 4px 2px 6px; align-items: flex-start; }

      .card {
        flex-shrink: 0; width: 152px; border-radius: 10px; overflow: hidden;
        cursor: pointer; border: 2px solid transparent;
        background: rgba(255,255,255,.05);
        transition: border-color .1s, transform .1s, box-shadow .1s;
      }
      .card:hover   { border-color: rgba(255,255,255,.2); }
      .card.selected {
        border-color: #4c9ffe;
        box-shadow: 0 0 0 1px rgba(76,159,254,.3), 0 0 28px rgba(76,159,254,.4);
        transform: translateY(-3px);
      }
      .card.current          { opacity: .5; }
      .card.current.selected { opacity: .75; }

      .thumb-wrap { position: relative; width: 100%; height: 92px; overflow: hidden; }
      .thumb { width: 100%; height: 100%; object-fit: cover; display: block; background: rgba(255,255,255,.04); }
      .thumb-fb { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
      .fi-big { width: 36px; height: 36px; border-radius: 8px; opacity: .8; }
      .fi-default { font-size: 26px; line-height: 1; }

      .badge {
        position: absolute; top: 5px; left: 5px;
        background: rgba(0,0,0,.72); color: rgba(255,255,255,.5);
        font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
        padding: 2px 6px; border-radius: 5px;
      }
      .foot { display: flex; align-items: center; gap: 6px; padding: 7px 8px; background: rgba(0,0,0,.22); min-height: 30px; }
      .fav  { width: 14px; height: 14px; flex-shrink: 0; border-radius: 2px; }
      .fav-empty { font-size: 12px; line-height: 14px; flex-shrink: 0; }
      .title { font-size: 11px; color: rgba(255,255,255,.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      #hint { margin-top: 14px; text-align: center; font-size: 11px; color: rgba(255,255,255,.28); }
      #hint kbd {
        display: inline-block; padding: 1px 5px; border-radius: 4px;
        border: 1px solid rgba(255,255,255,.18);
        font-family: inherit; font-size: 10px;
        color: rgba(255,255,255,.45); background: rgba(255,255,255,.07); line-height: 1.5;
      }
    `;
    shadow.appendChild(s);
  }

  // ── Tiny utilities ───────────────────────────────────────────────────────────
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function urlHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
  function hashColor(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360},35%,18%)`;
  }

})();
