import http from 'http';
import { WebSocketServer } from 'ws';
import app, { sessionMiddleware } from './app.js';
import { getDataDirectory } from './config/addon.js';
import {
  registerWebSocketClient,
  closeAllWebSocketClients,
} from './services/websocketHub.js';
import { flushAllGroupHistorySync } from './utils/groupHistoryStore.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const dataDir = getDataDirectory();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT không hợp lệ: ${process.env.PORT}`);
}

console.log('=========================================');
console.log('Khởi động server với thông số:');
console.log(`- Port: ${PORT}`);
console.log(`- Thư mục dữ liệu: ${dataDir}`);
console.log('=========================================');

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024,
  maxFragments: 1024,
  maxBufferedChunks: 4096,
});

function onUpgradeSocketError(error) {
  console.warn('[WebSocket] Socket error trong lúc upgrade:', error.message || error);
}

server.on('upgrade', (request, socket, head) => {
  socket.on('error', onUpgradeSocketError);

  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Parse the exact same express-session cookie used by the HTTP UI/API.
  // ws recommends authenticating in the HTTP upgrade event.
  sessionMiddleware(request, {}, () => {
    if (!request.session?.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.removeListener('error', onUpgradeSocketError);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  registerWebSocketClient(ws);
});

// Reap half-open/stale WebSocket connections so dashboards/reloads do not leak
// client objects indefinitely after Wi-Fi/browser disconnects.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, 30_000);
wsHeartbeat.unref?.();
wss.on('close', () => clearInterval(wsHeartbeat));

wss.on('error', (error) => {
  console.error('[WebSocket] Server error:', error.message || error);
});

server.on('error', (error) => {
  console.error('[HTTP] Server error:', error);
});

server.keepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS || '65000', 10);
server.headersTimeout = Math.max(server.keepAliveTimeout + 5000, 70000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server đang chạy trên port ${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] Nhận ${signal}, đang dọn dẹp...`);
  flushAllGroupHistorySync();
  closeAllWebSocketClients();
  wss.close();

  const forceTimer = setTimeout(() => {
    console.error('[Shutdown] Buộc dừng do quá thời gian chờ.');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close((error) => {
    clearTimeout(forceTimer);
    if (error) {
      console.error('[Shutdown] Lỗi đóng HTTP server:', error);
      process.exit(1);
    }
    console.log('[Shutdown] Server đã đóng an toàn.');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
