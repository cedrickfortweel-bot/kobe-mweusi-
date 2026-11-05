(() => {
  const preferenceKey = 'kobe-theme';
  const root = document.documentElement;

  function readTheme() {
    try {
      return localStorage.getItem(preferenceKey) === 'oled' ? 'oled' : 'light';
    } catch (error) {
      console.error('Unable to read the saved theme preference.', error);
      return 'light';
    }
  }

  function applyTheme(theme, save = false) {
    root.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'oled' ? '#000000' : '#f5f7f4';

    if (save) {
      try {
        localStorage.setItem(preferenceKey, theme);
      } catch (error) {
        console.error('Unable to save the theme preference.', error);
      }
    }
  }

  applyTheme(readTheme());

  function mountThemeControl() {
    const adminPage = document.body.classList.contains('admin-page');
    const header = adminPage ? null : document.querySelector('header.top, header.topbar, header.admin-topbar');
    const host = adminPage || !header
      ? document.body
      : header.querySelector('.top-actions, .right') || header;
    if (!host || host.querySelector('.kobe-theme-toggle')) return;

    const control = document.createElement('button');
    control.className = 'kobe-theme-toggle';
    if (adminPage || !header) control.classList.add('kobe-theme-floating');
    control.type = 'button';
    control.setAttribute('aria-pressed', String(root.dataset.theme === 'oled'));
    control.addEventListener('click', () => {
      applyTheme(root.dataset.theme === 'oled' ? 'light' : 'oled', true);
      updateControl();
    });

    function updateControl() {
      const isOled = root.dataset.theme === 'oled';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = isOled
        ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
        : '<path d="M20.2 15.6A8.5 8.5 0 0 1 8.4 3.8 8.5 8.5 0 1 0 20.2 15.6Z"/>';
      control.replaceChildren(icon);
      control.setAttribute('aria-pressed', String(isOled));
      control.setAttribute('aria-label', isOled ? 'Switch to light theme' : 'Switch to OLED theme');
      control.title = isOled ? 'Switch to light theme' : 'Switch to OLED theme';
    }

    updateControl();
    host.append(control);
  }

  function clearLegacyLightOverrides() {
    root.style.removeProperty('--shell');
    root.style.removeProperty('--shell-dim');
    root.style.removeProperty('--on');
    root.style.removeProperty('--ai');
    document.body.classList.remove('light');
    document.body.style.removeProperty('--acc');
    document.body.style.removeProperty('--on');
    document.body.style.removeProperty('--ai');
    applyTheme(readTheme());
  }

  function initialize() {
    clearLegacyLightOverrides();
    mountThemeControl();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
