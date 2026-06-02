// Tab Switcher Dynamic — Popup Script

function openShortcutsPage() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
}

document.getElementById('btn-shortcut').addEventListener('click', openShortcutsPage);
document.getElementById('link-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  openShortcutsPage();
});
