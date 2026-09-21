(()=>{const $=s=>document.querySelector(s);try{document.documentElement.dataset.theme=localStorage.getItem('aigccat.theme')||'dark';}catch{}
$('#theme').onclick=()=>{const theme=document.documentElement.dataset.theme==='light'?'dark':'light';document.documentElement.dataset.theme=theme;try{localStorage.setItem('aigccat.theme',theme);}catch{}};
function target(){const next=new URLSearchParams(location.search).get('next')||'/';try{const u=new URL(next,location.origin);return u.origin===location.origin&&!u.pathname.includes('login')?u.pathname+u.search+(u.hash||location.hash):'/';}catch{return '/';}}
$('#show-password').onclick=()=>{const show=$('#password').type==='password';$('#password').type=show?'text':'password';$('#show-password').textContent=show?'隐藏':'显示';$('#show-password').setAttribute('aria-label',show?'隐藏密码':'显示密码');};
let busy=false;$('#login-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const button=$('button[type=submit]');button.disabled=true;button.textContent='正在登录…';$('#message').textContent='';try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value,remember:$('#remember').checked})});const j=await r.json();if(!r.ok)throw Error(j.error||'登录失败，请重试');$('#password').value='';location.replace(target());}catch(e){$('#message').textContent=e.message||'连接失败，请稍后重试';}finally{busy=false;button.disabled=false;button.textContent='登录工作区 ↗';}};
fetch('/api/auth/me').then(r=>{if(r.ok)location.replace(target());}).catch(()=>{});
// 临时登录入口：仅当服务端开启（ALLOW_TEST_LOGIN≠0）时出现，点击即以 test 账号进入
fetch('/api/auth/features').then(r=>r.ok?r.json():null).then(j=>{
if(!j||!j.test_login)return;
const b=document.createElement('button');
b.type='button';b.id='test-login';b.textContent='临时登录（体验账号，无需密码）';
b.style.cssText='margin-top:10px;width:100%;padding:10px;border:1px dashed rgba(128,128,128,.6);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.85';
b.onclick=async()=>{
if(busy)return;busy=true;b.disabled=true;b.textContent='正在进入…';$('#message').textContent='';
try{const r=await fetch('/api/auth/test-login',{method:'POST'});const j2=await r.json();if(!r.ok)throw Error(j2.error||'临时登录失败');location.replace(target());}
catch(e){$('#message').textContent=e.message||'连接失败，请稍后重试';busy=false;b.disabled=false;b.textContent='临时登录（体验账号，无需密码）';}
};
$('#login-form').appendChild(b);
}).catch(()=>{});
})();
