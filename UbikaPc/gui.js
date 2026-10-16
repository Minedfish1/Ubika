const http = require('http');

/**
 * GUI mínima do Ubika PC: página local (http://localhost:PORT) com o
 * código de pareamento em destaque e status do host. Zero dependências.
 */

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubika PC</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#0d0418;color:#fff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}
  h1{color:#B39DDB;letter-spacing:6px;font-size:22px;margin:0 0 6px}
  .sub{color:#8a7fa8;font-size:12px;margin-bottom:26px}
  .code{font-size:64px;font-weight:900;letter-spacing:14px;background:#140822;border:2px solid #673AB7;border-radius:18px;padding:18px 30px 18px 44px;margin-bottom:8px}
  .codehint{color:#8a7fa8;font-size:12px;margin-bottom:26px}
  .paired{color:#66BB6A;font-size:26px;font-weight:800;margin-bottom:26px}
  .rows{width:340px;background:#140822;border:1px solid #2a1750;border-radius:14px;padding:14px 18px}
  .row{display:flex;justify-content:space-between;padding:7px 0;font-size:14px;border-bottom:1px solid #1e0d33}
  .row:last-child{border:0}
  .ok{color:#66BB6A}.bad{color:#EF5350}.mut{color:#8a7fa8}
  .dl{font-size:12px;color:#8a7fa8;margin-top:10px;max-height:90px;overflow:auto}
</style></head><body>
<h1>UBIKA PC</h1>
<div class="sub" id="dev">—</div>
<div id="main"></div>
<div class="rows" id="rows"></div>
<div class="dl" id="dl"></div>
<script>
async function tick(){
  try{
    const s = await (await fetch('/status.json')).json();
    dev.textContent = s.deviceId + '  ·  ' + (s.publicIp || s.lanIp || 'sem ip');
    if(s.paired){
      main.innerHTML = '<div class="paired">✓ PC CONECTADO À SUA CONTA</div><div class="codehint" style="text-align:center">Feche esta janela quando quiser — o Ubika segue rodando.</div>';
    } else {
      main.innerHTML = '<div class="code">'+(s.pairCode||'······')+'</div><div class="codehint" style="text-align:center">Digite este código no app Ubika do seu celular</div>';
    }
    const r=(k,v)=>{rows.innerHTML+='<div class="row"><span class="mut">'+k+'</span><span>'+v+'</span></div>'};
    rows.innerHTML='';
    r('Relay VPS', s.online?'<b class="ok">online</b>':'<b class="bad">offline</b>');
    r('Sunshine', s.sunshineInstalled?(s.sunshineRunning?'<b class="ok">rodando</b>':'<span class="mut">instalado</span>'):'<b class="bad">ausente</b>');
    r('Display virtual (VDD)', s.vddInstalled?'<b class="ok">ok</b>':'<b class="bad">ausente</b>');
    r('Catálogo', '<span class="mut">'+(s.librarySize||0)+' jogos</span>');
    r('Uptime', '<span class="mut">'+Math.floor(s.uptime/60)+'min</span>');
    dl.innerHTML=(s.downloads||[]).map(d=>d.gameName+': '+(d.progress||0)+'%'+(d.state==='done'?' ✓':'')).join('<br>');
  }catch(e){}
}
tick(); setInterval(tick,3000);
</script></body></html>`;

function startGui(port, getState) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/status.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getState()));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  srv.listen(port, '127.0.0.1');
  srv.on('error', () => {}); // porta ocupada → segue sem GUI
  return srv;
}

module.exports = { startGui };
