// Simula o app mobile: conecta na VPS, dispara iniciar_download e ouve progresso.
const { io } = require('socket.io-client');

const USER_ID = 'utilizador_teste_123';
const MAGNET_TESTE = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';

const SERVER = process.env.UBIKA_SERVER || 'http://localhost:3000';
const SECRET = process.env.UBIKA_SHARED_SECRET || '';
const socket = io(SERVER, { query: { device: 'android', userId: USER_ID }, auth: { token: SECRET }, timeout: 10000 });
const log = (...a) => console.log('[MOBILE]', ...a);

socket.on('connect', () => {
  log('conectado', socket.id);

  socket.on('download_progress', d => {
    log(`progresso: ${d.gameName} | ${d.state} | ${d.progress}% | ${(d.downSpeed/1e6).toFixed(2)} MB/s | peers=${d.peers}`);
  });

  // ping
  socket.emit('send_to_pc', { userId: USER_ID, payload: { action: 'ping' } }, ack => {
    log('ping ack:', JSON.stringify(ack));
  });

  // status
  socket.emit('send_to_pc', { userId: USER_ID, payload: { action: 'status' } }, ack => {
    log('status ack:', JSON.stringify(ack));
  });

  // iniciar download
  setTimeout(() => {
    socket.emit('send_to_pc', {
      userId: USER_ID,
      payload: { action: 'iniciar_download', gameName: 'Big Buck Bunny (teste)', magnetLink: MAGNET_TESTE },
    }, ack => {
      log('iniciar_download ack:', JSON.stringify(ack).slice(0, 300));
    });
  }, 500);

  // lista após 4s
  setTimeout(() => {
    socket.emit('send_to_pc', { userId: USER_ID, payload: { action: 'listar_downloads' } }, ack => {
      log('listar_downloads:', JSON.stringify(ack).slice(0, 500));
    });
  }, 4000);

  // ação desconhecida (contrato)
  setTimeout(() => {
    socket.emit('send_to_pc', { userId: USER_ID, payload: { action: 'acao_inexistente' } }, ack => {
      log('acao_inexistente ack:', JSON.stringify(ack));
    });
  }, 5000);

  setTimeout(() => { log('fim do teste'); process.exit(0); }, 20000);
});

socket.on('connect_error', e => { log('connect_error', e.message); process.exit(1); });
