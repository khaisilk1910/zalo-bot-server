import fs from 'fs';
import path from 'path';
import { getDataDirectory } from '../config/addon.js';
import { writeFileAtomicSync } from './atomicFile.js';

const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const pendingWrites = new Map();
const flushTimers = new Map();

function safePart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getHistoryDir(ownId) {
  const dir = path.join(getDataDirectory(), 'history', 'groups', safePart(ownId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getHistoryFile(ownId, groupId) {
  return path.join(getHistoryDir(ownId), `${safePart(groupId)}.jsonl`);
}

function jsonStringifySafe(value) {
  return JSON.stringify(value, (_key, current) => typeof current === 'bigint' ? current.toString() : current);
}

function cloneSerializable(value) {
  try {
    return JSON.parse(jsonStringifySafe(value));
  } catch (error) {
    console.warn('[History] Không thể serialize message đầy đủ:', error.message);
    return {
      threadId: value?.threadId,
      type: value?.type,
      isSelf: value?.isSelf,
      data: value?.data ?? null,
    };
  }
}

function messageKey(message) {
  const data = message?.data || {};
  const msgId = data.msgId ?? data.msgID ?? message?.msgId ?? message?.msgID;
  const cliMsgId = data.cliMsgId ?? data.cliMsgID ?? message?.cliMsgId ?? message?.cliMsgID;
  const uidFrom = data.uidFrom ?? data.uid ?? '';
  const ts = data.ts ?? data.time ?? data.timestamp ?? message?._storedAt ?? '';
  if (msgId || cliMsgId) return `${msgId ?? ''}:${cliMsgId ?? ''}:${uidFrom}`;
  return `${uidFrom}:${ts}:${jsonStringifySafe(data.content ?? '')}`;
}

function parseHistoryContent(content, file = '') {
  if (!content?.trim()) return [];
  const messages = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (error) {
      console.warn(`[History] Bỏ qua record lỗi${file ? ` trong ${file}` : ''}: ${error.message}`);
    }
  }
  return messages;
}

function parseHistoryFile(file) {
  if (!fs.existsSync(file)) return [];
  return parseHistoryContent(fs.readFileSync(file, 'utf8'), file);
}

function dedupeMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const message of messages) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}

function compactHistoryFileSync(file, maxMessages = DEFAULT_MAX_MESSAGES) {
  try {
    const kept = dedupeMessages(parseHistoryFile(file)).slice(-maxMessages);
    const content = kept.map(jsonStringifySafe).join('\n');
    writeFileAtomicSync(file, content ? `${content}\n` : '');
  } catch (error) {
    console.error(`[History] Lỗi compact ${file}:`, error.message);
  }
}

function scheduleFlush(file) {
  if (flushTimers.has(file)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(file);
    flushFile(file);
  }, FLUSH_DELAY_MS);
  timer.unref?.();
  flushTimers.set(file, timer);
}

function flushFile(file) {
  const records = pendingWrites.get(file);
  if (!records?.length) return;
  pendingWrites.delete(file);

  try {
    // Ghi một batch nhỏ mỗi ~100 ms. Cách này tránh appendFileSync cho từng message
    // nhưng vẫn đảm bảo getCachedGroupHistory() luôn nhìn thấy dữ liệu vừa flush,
    // không có race giữa async append và read.
    fs.appendFileSync(file, records.join(''), 'utf8');
    const stat = fs.statSync(file);
    const maxFileBytes = Number.parseInt(process.env.GROUP_HISTORY_MAX_FILE_BYTES || '', 10) || DEFAULT_MAX_FILE_BYTES;
    if (stat.size > maxFileBytes) {
      const maxMessages = Number.parseInt(process.env.GROUP_HISTORY_MAX_MESSAGES || '', 10) || DEFAULT_MAX_MESSAGES;
      compactHistoryFileSync(file, maxMessages);
    }
  } catch (error) {
    console.error(`[History] Không thể ghi ${file}:`, error.message);
    pendingWrites.set(file, [...records, ...(pendingWrites.get(file) || [])]);
    scheduleFlush(file);
  }
}

function flushFileSync(file) {
  const timer = flushTimers.get(file);
  if (timer) clearTimeout(timer);
  flushTimers.delete(file);
  const records = pendingWrites.get(file);
  if (!records?.length) return;
  pendingWrites.delete(file);
  fs.appendFileSync(file, records.join(''), 'utf8');
}

export function flushAllGroupHistorySync() {
  for (const file of [...pendingWrites.keys()]) {
    try { flushFileSync(file); } catch (error) {
      console.error(`[History] Không thể flush ${file}:`, error.message);
    }
  }
}

/** Store a group message without blocking the listener on disk I/O. */
export function storeGroupMessage(ownId, message) {
  const groupId = message?.threadId;
  if (!ownId || !groupId) return false;

  try {
    const file = getHistoryFile(ownId, groupId);
    const record = cloneSerializable(message);
    record._accountId = String(ownId);
    record._storedAt = Date.now();
    const line = `${jsonStringifySafe(record)}\n`;
    const queue = pendingWrites.get(file) || [];
    queue.push(line);
    pendingWrites.set(file, queue);
    scheduleFlush(file);
    return true;
  } catch (error) {
    console.error(`[History] Không thể queue history group ${groupId}:`, error.message);
    return false;
  }
}

export function getCachedGroupHistory(ownId, groupId, count = 50) {
  const safeCount = Math.min(Math.max(Number.parseInt(count, 10) || 50, 1), 200);
  const file = getHistoryFile(ownId, groupId);
  flushFileSync(file);
  const allMessages = dedupeMessages(parseHistoryFile(file));
  const selected = allMessages.slice(-safeCount);
  const latest = selected[selected.length - 1];
  const latestData = latest?.data || {};

  return {
    lastActionId: String(latestData.msgId ?? latestData.msgID ?? latestData.cliMsgId ?? latestData.cliMsgID ?? ''),
    lastActionIdOther: '',
    more: allMessages.length > selected.length ? 1 : 0,
    groupMsgs: selected,
    source: 'local_persistent_cache',
    cachedCount: allMessages.length,
  };
}
