/**
 * nav.js — injects the correct navbar depending on auth state
 * Include this on every page BEFORE the closing </body> tag.
 * It calls /api/me to detect login state and renders the right nav.
 */
(async function () {
  let user = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) user = await r.json();
  } catch (_) {}

  const placeholder = document.getElementById('navbar-placeholder');
  if (!placeholder) return;

  const currentPath = window.location.pathname;

  function navLink(href, label) {
    const active = currentPath === href || (href !== '/' && currentPath.startsWith(href));
    return `<a class="nav-link${active ? ' active' : ''}" href="${href}">${label}</a>`;
  }

  const publicLinks = `
    ${navLink('/', 'Home')}
    ${navLink('/about', 'About')}
    ${navLink('/contact', 'Contact')}
    ${navLink('/apply', 'Apply as Writer')}
  `;

  const authLinks = user
    ? `${navLink('/dashboard', 'Dashboard')}
       <a class="nav-link" href="#" id="navLogout">Logout</a>`
    : `${navLink('/login', 'Login')}
       <a class="btn btn-primary btn-sm ms-2 px-3" href="/register">Get Started</a>`;

  placeholder.innerHTML = `
    <nav class="navbar navbar-expand-lg site-navbar">
      <div class="container">
        <a class="navbar-brand" href="/">
          <span class="brand-icon-sm">✍️</span> DBRAM Research
        </a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#mainNav">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="mainNav">
          <ul class="navbar-nav me-auto mb-2 mb-lg-0">
            ${publicLinks.split('\n').filter(Boolean).map(l => `<li class="nav-item">${l.trim()}</li>`).join('')}
          </ul>
          <div class="d-flex align-items-center gap-2">
            ${user ? `<span class="text-muted small me-1">Hi, ${user.name}</span>` : ''}
            ${authLinks}
          </div>
        </div>
      </div>
    </nav>
  `;

  const logoutBtn = document.getElementById('navLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/';
    });
  }
})();
