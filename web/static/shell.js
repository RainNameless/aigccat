(() => {
  const key = 'aigccat.theme';
  const rawFetch=window.fetch.bind(window);
  let redirecting=false;
  function login(){const embedded=window.top!==window.self;const next=embedded?'/admin.html#models':location.pathname+location.search+location.hash;(embedded?window.top:window).location.replace('/login.html?next='+encodeURIComponent(next));}
  window.fetch=async(...args)=>{
    const response=await rawFetch(...args);
    const url=new URL(args[0] instanceof Request?args[0].url:String(args[0]),location.href);
    if(response.status===401&&url.origin===location.origin&&url.pathname.startsWith('/api/')&&!redirecting){
      redirecting=true;login();
    }
    return response;
  };
  let theme = 'dark';
  try { theme = localStorage.getItem(key) === 'light' ? 'light' : 'dark'; } catch {}
  function apply(value) {
    document.documentElement.dataset.theme = value;
    document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === value)));
    window.dispatchEvent(new CustomEvent('aigccat-theme', { detail: value }));
  }
  window.addEventListener('aigccat-set-theme',event=>{theme=event.detail==='light'?'light':'dark';try{localStorage.setItem(key,theme);}catch{}apply(theme);});
  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    // Firefox locks import maps when the first module starts loading.
    // Wait until the document's import map has been parsed.
    import('/image-interactions.js?v=1').catch(error=>console.error('图片交互加载失败',error));
    const page = location.pathname.includes('admin.html') ? 'admin' : location.pathname.includes('account.html') ? 'account' : location.pathname.includes('settings') ? 'settings' : location.pathname.includes('comparison') ? 'comparison' : location.pathname.includes('library') ? 'library' : 'home';
    document.body.dataset.page = page;
    const old = document.querySelector('body > header');
    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<a class="app-brand" href="/" aria-label="aigccat 首页"><strong>aigccat</strong></a><nav class="app-nav" aria-label="主导航"><a data-page-link="library" href="/library.html"><i data-lucide="library"></i>资产库</a><a data-page-link="canvas" href="/library.html#canvas"><i data-lucide="git-fork"></i>资产图谱</a></nav><div class="app-actions"></div>`;
    const actions = header.querySelector('.app-actions');
    const account=document.createElement('nav');account.className='account-nav';account.setAttribute('aria-label','账号菜单');
    account.innerHTML='<span class="account-status" role="status">正在验证登录…</span>';actions.after(account);
    async function loadAccount(){
      try{
        const response=await rawFetch('/api/auth/me');
        if(response.status===401){login();return;}
        if(!response.ok)throw Error('账号服务暂时不可用');
        const {user}=await response.json();account.replaceChildren();
        const admin=document.createElement('a');admin.href='/admin.html';admin.textContent='后台管理';admin.title=(user.display_name||user.username)+' · '+user.username;admin.dataset.accountLink='admin';account.append(admin);
        const logout=document.createElement('button');logout.textContent='退出登录';logout.onclick=async()=>{logout.disabled=true;try{const r=await rawFetch('/api/auth/logout',{method:'POST'});if(r.ok||r.status===401)location.replace('/login.html');else throw Error();}catch{logout.textContent='重试退出';logout.disabled=false;}};account.append(logout);
      }catch{
        account.replaceChildren();const retry=document.createElement('button');retry.textContent='账号加载失败 · 重试';retry.onclick=loadAccount;account.append(retry);
      }
    }
    loadAccount();
    if (page === 'home') old?.querySelectorAll('#assets-header,#service-status,#bridge,#tasks-button').forEach(el => actions.append(el));
    if (page === 'library') { const ledger = document.getElementById('ledger'); if (ledger) actions.append(ledger); }
    if (page === 'comparison' && old) { old.className = 'comparison-heading'; old.querySelector('a')?.remove(); old.before(header); }
    else if (old) old.replaceWith(header);
    else document.body.prepend(header);
    function route() {
      const active = page === 'library' && location.hash === '#canvas' ? 'canvas' : page;
      document.body.dataset.view = active;
      header.querySelectorAll('[data-page-link]').forEach(a => {
        if (a.dataset.pageLink === active) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
    }
    route(); window.addEventListener('hashchange', route);
    if (page === 'comparison') {
      const note = document.querySelector('body > .note');
      if (note) document.querySelector('main').after(note);
      const description = document.querySelector('.comparison-heading p');
      if (description) description.textContent = '同一参考输入 · 统一灯光与取景 · 初始版本 v001';
    }
    // All account and model settings live in the unified admin workspace.
    header.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => {
      theme = b.dataset.themeChoice;
      try { localStorage.setItem(key, theme); } catch {}
      apply(theme);
    }));
    window.addEventListener('storage', e => { if (e.key === key) apply(e.newValue === 'light' ? 'light' : 'dark'); });
    apply(theme);
    window.lucide?.createIcons();
  });
})();
