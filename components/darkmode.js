// Runs in <head> before the page renders to avoid a flash of the wrong theme / size.
// Theme is stored in both localStorage (for synchronous first-paint) and ext.storage.local
// (so content scripts like forum-hover.js on Bitcointalk can use the same theme).
;(function () {
  const html = document.documentElement;
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const ext = globalThis.browser ?? globalThis.chrome;

  function getPreferredTheme() {
    const storedTheme = localStorage.getItem('theme');
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
    return mediaQuery.matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    html.setAttribute('data-bs-theme', theme);
    ext?.storage?.local?.set({ theme });
  }

  applyTheme(getPreferredTheme());

  mediaQuery.addEventListener('change', () => {
    const storedTheme = localStorage.getItem('theme');
    if (storedTheme !== 'light' && storedTheme !== 'dark') {
      applyTheme(getPreferredTheme());
    }
  });

  // Keep popup and sidebar in sync when the theme is changed in the other view.
  window.addEventListener('storage', event => {
    if (event.key === 'theme') applyTheme(getPreferredTheme());
  });

  // The toolbar popup is opened as main.html?popup (see manifest.json); the sidebar as main.html.
  if (new URLSearchParams(location.search).has('popup')) {
    html.classList.add('is-popup');
  }
})();
