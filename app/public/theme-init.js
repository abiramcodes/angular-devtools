(function () {
  const t = new URLSearchParams(location.search).get('theme');
  // chrome.devtools.panels.themeName: 'dark' = dark, 'default' = light
  // No param: follow prefers-color-scheme (leave data-theme unset).
  const theme = t === 'dark' ? 'dark' : t === 'default' || t === 'light' ? 'light' : null;

  if (theme) document.documentElement.dataset.theme = theme;

  // Inject a <style> tag (not an inline style) so _base.scss html{background:var(--bg)}
  // can override it after the stylesheet loads and update live on theme switches.
  const prefersDark = !theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (!theme && prefersDark);
  const s = document.createElement('style');
  s.textContent = 'html{background:' + (isDark ? '#0b0b0e' : '#ffffff') + '}';
  document.head.insertBefore(s, document.head.firstChild);
})();
