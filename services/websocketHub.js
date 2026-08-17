import { WebSocket } from 'ws';

const clients = new Set();

export function registerWebSocketClient(ws) {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

export function broadcastMessage(message) {
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(message);
    } catch (error) {
      console.warn('[WebSocket] Không thể gửi tới client:', error.message || error);
      try { client.terminate(); } catch {}
      clients.delete(client);
    }
  }
}

export function closeAllWebSocketClients() {
  for (const client of clients) {
    try { client.close(1001, 'Server shutting down'); } catch {}
  }
  clients.clear();
}

export function getWebSocketClientCount() {
  return clients.size;
}
