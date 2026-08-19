(() => {
  const prefix = (() => {
    const markerPaths = ['/admin-login','/zalo-login','/accounts','/proxies','/account-webhook-manager','/messages','/list','/change-password','/user-management','/reset-password'];
    const path = window.location.pathname;
    for (const marker of markerPaths) {
      const idx = path.lastIndexOf(marker);
      if (idx >= 0) return path.slice(0, idx);
    }
    return path.endsWith('/') ? path.slice(0,-1) : '';
  })();

  window.zaloUi = {
    path(pathname) {
      const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
      return `${prefix}${clean}` || clean;
    },
    async json(url, options = {}) {
      const response = await fetch(window.zaloUi.path(url), {
        credentials: 'same-origin',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body ? {'Content-Type':'application/json'} : {}),
          ...(options.headers || {}),
        },
      });
      let data = null;
      try { data = await response.json(); } catch { data = { success:false, error:`HTTP ${response.status}` }; }
      if (!response.ok) {
        const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    },
    toast(message, type = 'info', duration = 3600) {
      let stack = document.querySelector('.toast-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        document.body.appendChild(stack);
      }
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;
      stack.appendChild(toast);
      setTimeout(() => toast.remove(), duration);
    },
    escape(value) {
      return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
    },
    confirm(message) { return window.confirm(message); },
  };

  document.addEventListener('click', async (event) => {
    const logout = event.target.closest('[data-logout]');
    if (!logout) return;
    logout.disabled = true;
    try {
      await window.zaloUi.json('/api/logout', { method:'POST' });
      window.location.href = window.zaloUi.path('/admin-login');
    } catch (error) {
      window.zaloUi.toast(error.message || 'Không thể đăng xuất', 'error');
      logout.disabled = false;
    }
  });
})();
