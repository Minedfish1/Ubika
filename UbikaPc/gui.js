const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * GUI local do Ubika PC (http://127.0.0.1:PORT):
 * conta (login/criar), código de pareamento, status, configurações
 * (com seletor de pasta navegável) e diagnóstico. Zero dependências.
 */

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubika PC</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#0d0418;color:#fff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px}
  h1{color:#B39DDB;letter-spacing:6px;font-size:22px;margin:0 0 6px}
  .sub{color:#8a7fa8;font-size:12px;margin-bottom:26px}
  .card{width:360px;background:#140822;border:1px solid #2a1750;border-radius:14px;padding:16px 18px;margin-bottom:14px}
  .card h2{color:#B39DDB;font-size:12px;letter-spacing:3px;margin:0 0 12px}
  .code{font-size:56px;font-weight:900;letter-spacing:12px;text-align:center;background:#0d0418;border:2px solid #673AB7;border-radius:14px;padding:14px 10px 14px 22px;margin-bottom:6px}
  .codehint{color:#8a7fa8;font-size:12px;text-align:center}
  .paired{color:#66BB6A;font-size:15px;font-weight:800;text-align:center;margin-bottom:10px}
  .row{display:flex;justify-content:space-between;padding:7px 0;font-size:14px;border-bottom:1px solid #1e0d33}
  .row:last-child{border:0}
  .ok{color:#66BB6A}.bad{color:#EF5350}.mut{color:#8a7fa8}
  input{background:#0d0418;border:1px solid #2a1750;border-radius:10px;color:#fff;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#7C4DFF}
  .dirrow{display:flex;gap:8px}
  .dirrow input{flex:1;margin-bottom:8px}
  .dirrow button{width:46px;margin:0 0 8px;font-size:16px;padding:10px 0}
  button{background:#673AB7;color:#fff;border:0;border-radius:10px;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;width:100%;margin-top:4px}
  button.ghost{background:#1e0d33}
  button:disabled{opacity:.5}
  .tabs{display:flex;gap:8px;margin-bottom:12px}
  .tabs button{margin:0;background:#1e0d33}
  .tabs button.on{background:#673AB7}
  .msg{font-size:12px;min-height:16px;margin-top:8px;text-align:center}
  .dl{font-size:12px;color:#8a7fa8;margin-top:4px;max-height:90px;overflow:auto;width:360px}
  .browser{background:#0d0418;border:1px solid #2a1750;border-radius:10px;margin-bottom:8px;overflow:hidden}
  .bpath{font-size:11px;color:#8a7fa8;padding:8px 10px;word-break:break-all;border-bottom:1px solid #1e0d33;background:#12081f}
  .blist{max-height:180px;overflow-y:auto}
  .d{padding:9px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #160b26;display:flex;gap:8px;align-items:center}
  .d:hover{background:#1e0d33}
  .d:last-child{border-bottom:0}
  .d .i{opacity:.8}
  .catgrid{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;margin-top:8px}
  .g{display:flex;gap:10px;background:#0d0418;border:1px solid #2a1750;border-radius:10px;padding:8px}
  .g img{width:52px;height:68px;object-fit:cover;border-radius:6px;background:#1e0d33}
  .g .gi{flex:1;min-width:0}
  .g .t{font-size:13px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .g .s{font-size:11px;color:#8a7fa8;margin:2px 0 6px}
  .g .act{display:flex;flex-direction:column;gap:4px;justify-content:center}
  .g button{width:auto;padding:7px 12px;font-size:11px;margin:0;white-space:nowrap}
  .g button.play{background:#2E7D32}
  .g button.del{background:#3A0D10;color:#EF5350}
  .g .ver{font-size:10px;color:#5a4a80;margin-top:2px}
  .lockbox{text-align:center;padding:18px 6px;color:#8a7fa8;font-size:13px;line-height:1.7}
  .lockbox .lk{font-size:30px;margin-bottom:8px}
</style></head><body>
<h1>UBIKA PC</h1>
<div class="sub" id="dev">—</div>

<div class="card"><h2>CONTA</h2><div id="acct">…</div></div>
<div class="card"><div id="main"></div></div>
<div class="card" id="concard"><h2>CATÁLOGO</h2><div id="console"></div></div>
<div class="card"><h2>STATUS</h2><div id="rows"></div></div>
<div class="card"><h2>CONFIGURAÇÕES</h2>
  <div class="mut" style="font-size:12px;margin-bottom:6px">Pasta dos jogos</div>
  <div class="dirrow">
    <input id="dir" placeholder="C:\\Ubika\\games">
    <button onclick="browse('')" title="Escolher pasta">📁</button>
  </div>
  <div class="browser" id="browser" style="display:none">
    <div class="bpath" id="bpath"></div>
    <div class="blist" id="blist"></div>
    <div style="display:flex;gap:8px;padding:8px">
      <button style="margin:0" onclick="pickDir()">USAR ESTA PASTA</button>
      <button class="ghost" style="margin:0" onclick="browser.style.display='none'">✕</button>
    </div>
  </div>
  <button onclick="saveSettings()">SALVAR PASTA</button>
  <div class="msg" id="setmsg"></div>
</div>
<div class="card"><h2>DIAGNÓSTICO</h2>
  <button id="spd" onclick="speedTest()">TESTAR VELOCIDADE</button>
  <div class="msg" id="speed"></div>
</div>
<div class="dl" id="dl"></div>

<script>
let tab='login';
function acctForm(){
  acct.innerHTML =
    '<div class="tabs">'+
      '<button id="tl" class="'+(tab==='login'?'on':'')+'" onclick="tab=\\'login\\';acctForm()">ENTRAR</button>'+
      '<button id="tr" class="'+(tab==='register'?'on':'')+'" onclick="tab=\\'register\\';acctForm()">CRIAR CONTA</button>'+
    '</div>'+
    '<input id="em" type="email" placeholder="email" autocomplete="username" style="width:100%;margin-bottom:8px">'+
    '<input id="pw" type="password" placeholder="senha (mín. 6)" autocomplete="current-password" style="width:100%;margin-bottom:8px">'+
    '<button onclick="doAuth()">'+(tab==='login'?'ENTRAR':'CRIAR CONTA')+'</button>'+
    '<div class="msg" id="amsg"></div>';
}
async function doAuth(){
  const m=document.getElementById('amsg');
  const body={mode:tab,email:em.value.trim(),password:pw.value};
  if(!body.email||!body.password){m.innerHTML='<span class="bad">Preencha email e senha</span>';return}
  m.innerHTML='<span class="mut">Conectando…</span>';
  try{
    const r=await (await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    m.innerHTML=r.ok?'<span class="ok">✓ Conectado como '+r.email+'</span>':'<span class="bad">'+errTxt(r.error)+'</span>';
    setTimeout(tick,800);
  }catch(e){m.innerHTML='<span class="bad">'+e.message+'</span>'}
}
async function doLogout(){
  await fetch('/api/logout',{method:'POST'});
  tick();
}
function errTxt(e){
  return {CREDENCIAIS_INVALIDAS:'Email ou senha incorretos',EMAIL_JA_CADASTRADO:'Email já cadastrado',
    EMAIL_INVALIDO:'Email inválido',SENHA_CURTA_MIN_6:'Senha precisa de 6+ caracteres'}[e]||e||'Erro';
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

// ---------- Seletor de pasta ----------
let dirList=[],bCur='',bParent='';
async function browse(p){
  const r=await (await fetch('/api/dirs?path='+encodeURIComponent(p||''))).json();
  if(!r.ok){document.getElementById('setmsg').innerHTML='<span class="bad">'+esc(r.error||'Erro')+'</span>';return}
  dirList=r.dirs||[];bCur=r.path||'';bParent=r.parent;
  browser.style.display='block';
  bpath.textContent=bCur||'Este computador';
  let h='';
  if(r.parent!==null&&r.parent!==undefined)
    h+='<div class="d" onclick="browse(bParent)"><span class="i">↩</span> ..</div>';
  h+=dirList.map(function(d,i){
    return '<div class="d" onclick="browseIdx('+i+')"><span class="i">📁</span> '+esc(d.name)+'</div>';
  }).join('');
  if(!dirList.length) h+='<div class="d mut">(pasta vazia)</div>';
  blist.innerHTML=h;
}
function browseIdx(i){browse(dirList[i].full)}
function browseIdx(i){browse(dirList[i].full)}
function pickDir(){dir.value=bCur;browser.style.display='none'}

async function saveSettings(){
  const m=document.getElementById('setmsg');
  try{
    const r=await (await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({downloadDir:dir.value.trim()})})).json();
    m.innerHTML=r.ok?'<span class="ok">✓ Pasta salva</span>':'<span class="bad">'+esc(r.error||'Erro')+'</span>';
  }catch(e){m.innerHTML='<span class="bad">'+e.message+'</span>'}
}
async function speedTest(){
  const b=document.getElementById('spd'),o=document.getElementById('speed');
  b.disabled=true;o.innerHTML='<span class="mut">Testando… (baixa ~25 MB)</span>';
  try{
    const r=await (await fetch('/speedtest',{method:'POST'})).json();
    o.innerHTML=r.ok?'⬇ <b>'+r.mbps+' Mbps</b> · ping '+r.pingMs+'ms':'<span class="bad">Falhou: '+esc(r.detail||r.error||'erro')+'</span>';
  }catch(e){o.innerHTML='<span class="bad">Falhou: '+e.message+'</span>'}
  b.disabled=false;
}
// ---------- Console: catálogo só com celular ligado (USB/BT) + app aberto ----------
let catQ='',catGames=[],catLock=false;
async function loadCatalog(){
  const r=await (await fetch('/api/catalog?q='+encodeURIComponent(catQ))).json();
  if(!r.ok)return;
  catGames=r.games||[];renderCatalog();
}
function renderCatalog(){
  if(catLock)return;
  console.innerHTML='<input id="cq" placeholder="Buscar jogo…" style="width:100%" oninput="catQ=this.value" onkeydown="if(event.key===\'Enter\')loadCatalog()">'+
    '<button onclick="loadCatalog()">BUSCAR</button>'+
    '<div class="catgrid">'+catGames.map(function(g,i){
      var acts='';
      if(g.installed&&g.playable)
        acts='<button class="play" onclick="gAct('+i+',\'launch\')">▶ JOGAR</button>'+
             '<button class="del" onclick="gAct('+i+',\'excluir_jogo\',1)">🗑</button>';
      else if(g.installed)
        acts='<span class="ver">instalado (sem exe)</span>'+
             '<button class="del" onclick="gAct('+i+',\'excluir_jogo\',1)">🗑</button>';
      else
        acts=(g.versions||[]).map(function(v,vi){
          return '<button onclick="gDl('+i+','+vi+')">⬇ '+esc(v.source||'fonte')+(v.size?' · '+esc(v.size):'')+'</button>';
        }).join('');
      return '<div class="g"><img src="'+esc(g.coverUrl||'')+'" onerror="this.style.visibility=\'hidden\'">'+
        '<div class="gi"><div class="t">'+esc(g.title)+'</div>'+
        '<div class="s">'+(g.installed?'✓ instalado':'')+'</div>'+
        (g.versions||[]).map(function(v){return '<div class="ver">'+esc(v.source||'')+'</div>'}).join('')+
        '</div><div class="act">'+acts+'</div></div>';
    }).join('')+'</div>';
  var q=document.getElementById('cq');q.value=catQ;
}
async function gDl(i,vi){
  var g=catGames[i],v=(g.versions||[])[vi];if(!v)return;
  var r=await (await fetch('/api/game_action',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'iniciar_download',gameName:g.title,magnetLink:v.magnet||'',link:(v.links&&v.links[0])||'',coverUrl:g.coverUrl})})).json();
  document.getElementById('setmsg').innerHTML=r.ok?'<span class="ok">✓ '+esc(g.title)+' baixando</span>':'<span class="bad">'+esc(r.error||'Erro')+'</span>';
}
async function gAct(i,action,confirm){
  var g=catGames[i];
  if(confirm&&!window.confirm('Apagar "'+g.title+'" do PC?'))return;
  var r=await (await fetch('/api/game_action',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:action,installId:g.installId})})).json();
  if(action==='excluir_jogo'&&r.ok)loadCatalog();
}
async function tick(){
  try{
    const s=await (await fetch('/status.json')).json();
    dev.textContent=s.deviceId+'  ·  '+(s.publicIp||s.lanIp||'sem ip');
    if(s.account&&s.account.userId){
      acct.innerHTML='<div class="row"><span class="mut">Conectado</span><span class="ok"><b>'+esc(s.account.email||s.account.userId)+'</b></span></div>'+
        '<div class="row"><span class="mut">Plano</span><span>'+esc(s.account.plan||'—')+'</span></div>'+
        '<button class="ghost" onclick="doLogout()">SAIR DA CONTA</button>';
    }else if(!document.getElementById('em')){ acctForm(); }
    const ttl=s.pairCodeTtlSec!=null?'  ·  troca em '+Math.floor(s.pairCodeTtlSec/60)+'m'+String(s.pairCodeTtlSec%60).padStart(2,'0')+'s':'';
    main.innerHTML=(s.paired?'<div class="paired">✓ PC CONECTADO</div>':'')+
      '<div class="code">'+(s.pairCode||'······')+'</div><div class="codehint">'+
      (s.paired?'Parear outro aparelho? Digite no app do celular':'Digite este código no app Ubika do seu celular')+ttl+'</div>';
    const r=(k,v)=>{rows.innerHTML+='<div class="row"><span class="mut">'+k+'</span><span>'+v+'</span></div>'};
    rows.innerHTML='';
    r('Relay VPS',s.online?'<b class="ok">online</b>':'<b class="bad">offline</b>');
    r('Sunshine',s.sunshineInstalled?(s.sunshineRunning?'<b class="ok">rodando</b>':'<span class="mut">instalado</span>'):'<b class="bad">ausente</b>');
    r('Display virtual (VDD)',s.vddInstalled?'<b class="ok">ok</b>':'<b class="bad">ausente</b>');
    r('Catálogo','<span class="mut">'+(s.librarySize||0)+' jogos</span>');
    r('Uptime','<span class="mut">'+Math.floor(s.uptime/60)+'min</span>');
    if(document.activeElement!==dir) dir.value=s.downloadDir||'';
    dl.innerHTML=(s.downloads||[]).map(d=>esc(d.gameName)+': '+(d.progress||0)+'%'+(d.state==='done'?' ✓':'')).join('<br>');
    // Console: só libera o catálogo com o celular ligado no PC + app aberto
    const wasLock=catLock;catLock=!s.consoleActive;
    if(catLock){
      console.innerHTML='<div class="lockbox"><div class="lk">🔌</div>'+
        'Conecte o celular por <b>USB</b> ou <b>Bluetooth</b><br>com o app Ubika aberto para liberar o catálogo'+
        (s.appForeground?'<br><span class="mut" style="font-size:11px">app aberto ✓ · aguardando link USB/Bluetooth…</span>':'')+
        '</div>';
    }else{
      if(wasLock||!document.getElementById('cq'))renderCatalog();
      if(!catGames.length)loadCatalog();
    }
  }catch(e){}
}
tick();setInterval(tick,3000);
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

/** Lista drives (path vazio) ou subpastas de um caminho — pro seletor de pasta. */
function listDirs(p) {
  if (!p) {
    const drives = [];
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const d = `${c}:\\`;
      try { if (fs.existsSync(d)) drives.push({ name: d, full: d }); } catch {}
    }
    return { ok: true, path: '', parent: null, dirs: drives };
  }
  const full = path.resolve(p);
  const parent = path.dirname(full);
  let dirs;
  try {
    dirs = fs.readdirSync(full, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map(e => ({ name: e.name, full: path.join(full, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 300);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: full, parent: parent === full ? '' : parent, dirs };
}

/**
 * handlers: { getState(), onSpeedTest(), onAuth(mode,email,password), onLogout(), onSettings(body) }
 */
function startGui(port, handlers) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

    if (url.pathname === '/status.json') return json(handlers.getState());
    if (url.pathname === '/api/dirs') return json(listDirs(url.searchParams.get('path') || ''));
    if (url.pathname === '/api/catalog' && handlers.onCatalog) {
      try { return json(await handlers.onCatalog(url.searchParams.get('q') || '')); }
      catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/game_action' && req.method === 'POST' && handlers.onGameAction) {
      const b = await readBody(req);
      try { return json(await handlers.onGameAction(b)); } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url.pathname === '/speedtest' && req.method === 'POST' && handlers.onSpeedTest) {
      try { return json(await handlers.onSpeedTest()); }
      catch (e) { return json({ ok: false, error: 'SPEED_TEST_FAILED', detail: e.message }); }
    }
    if (url.pathname === '/api/auth' && req.method === 'POST' && handlers.onAuth) {
      const b = await readBody(req);
      try { return json(await handlers.onAuth(String(b.mode || 'login'), String(b.email || ''), String(b.password || ''))); }
      catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/logout' && req.method === 'POST' && handlers.onLogout) {
      try { return json(await handlers.onLogout()); } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/settings' && req.method === 'POST' && handlers.onSettings) {
      const b = await readBody(req);
      try { return json(await handlers.onSettings(b)); } catch (e) { return json({ ok: false, error: e.message }); }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  srv.listen(port, '127.0.0.1');
  srv.on('error', () => {}); // porta ocupada → segue sem GUI
  return srv;
}

module.exports = { startGui };
