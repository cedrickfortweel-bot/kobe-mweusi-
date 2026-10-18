module.exports = {
  content: ['./buyer.html', './seller.html', './agent.html', './admin.html', './*.js'],
  corePlugins: { preflight: false },
  safelist: ['km-action', 'km-action-primary', 'km-action-secondary', 'km-surface', 'km-field', 'km-page-shell'],
  theme: {
    extend: {
      colors: {
        kobe: { ink: '#0e1011', surface: '#171a1c', line: '#282d2f', moss: '#c8ff35', muted: '#9aa3a0' }
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'ui-serif', 'Georgia', 'serif']
      },
      borderRadius: { kobe: '18px' },
      boxShadow: { kobe: '0 18px 45px rgba(0,0,0,.18)' }
    }
  }
};