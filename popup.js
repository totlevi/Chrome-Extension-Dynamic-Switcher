// Tab Switcher Dynamic — Popup Script

const toggle = document.getElementById('toggle-overlay');

// Load saved setting
chrome.storage.sync.get({ overlayEnabled: true }, ({ overlayEnabled }) => {
  toggle.checked = overlayEnabled;
});

// Save on change
toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ overlayEnabled: toggle.checked });
});

function openShortcutsPage() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
}

document.getElementById('btn-shortcut').addEventListener('click', openShortcutsPage);
document.getElementById('link-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  openShortcutsPage();
});
