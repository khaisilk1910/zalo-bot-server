import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataFilePath } from '../config/addon.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { broadcastMessage } from './websocketHub.js';

const WEBHOOK_EVENTS = ['message', 'group_event', 'reaction'];
const LEGACY_KEY_TO_EVENT = {
  messageWebhookUrl: 'message',
  groupEventWebhookUrl: 'group_event',
  reactionWebhookUrl: 'reaction',
};
const EVENT_TO_LEGACY_KEY = Object.fromEntries(
  Object.entries(LEGACY_KEY_TO_EVENT).map(([key, event]) => [event, key]),
);
const EVENT_LABEL = {
  message: 'Tin nhắn',
  group_event: 'Sự kiện nhóm',
  reaction: 'Reaction',
};
const MAX_WEBHOOKS_PER_ACCOUNT = 50;

function getWebhookConfigPath() {
  return getDataFilePath('webhook-config.json');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength = 120) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLength);
}

function cleanOwnId(value) {
  return cleanText(value, 128);
}

function normalizeUrl(value) {
  return String(value ?? '').trim().slice(0, 4096);
}

function buildDefaultConfig() {
  return {
    version: 2,
    default: {
      messageWebhookUrl: process.env.MESSAGE_WEBHOOK_URL || '',
      groupEventWebhookUrl: process.env.GROUP_EVENT_WEBHOOK_URL || '',
      reactionWebhookUrl: process.env.REACTION_WEBHOOK_URL || '',
    },
    accounts: {},
  };
}

function normalizeEvents(events) {
  const source = Array.isArray(events) ? events : [];
  return [...new Set(source.map((item) => String(item)).filter((item) => WEBHOOK_EVENTS.includes(item)))];
}

function normalizeWebhook(raw = {}, fallbackId = '') {
  const timestamp = nowIso();
  return {
    id: cleanText(raw.id || fallbackId || crypto.randomUUID(), 128),
    name: cleanText(raw.name || 'Webhook', 100) || 'Webhook',
    url: normalizeUrl(raw.url),
    events: normalizeEvents(raw.events),
    enabled: raw.enabled !== false,
    createdAt: cleanText(raw.createdAt, 64) || timestamp,
    updatedAt: cleanText(raw.updatedAt, 64) || timestamp,
  };
}

function compatWebhookId(eventType) {
  return `compat-${String(eventType).replace(/[^a-z0-9_-]/gi, '-')}`;
}

function isCompatibilityWebhook(webhook) {
  return typeof webhook?.id === 'string' && webhook.id.startsWith('compat-');
}

function orderedEvents(events) {
  const eventSet = new Set(normalizeEvents(events));
  return WEBHOOK_EVENTS.filter((eventType) => eventSet.has(eventType));
}

function compatibilityWebhookId(events) {
  const normalized = orderedEvents(events);
  if (normalized.length === WEBHOOK_EVENTS.length) return 'compat-default';
  if (normalized.length === 1) return compatWebhookId(normalized[0]);
  return `compat-${normalized.join('-')}`;
}

function compatibilityWebhookName(events) {
  const normalized = orderedEvents(events);
  if (normalized.length > 1) return 'Webhook mặc định (tương thích cũ)';
  return `${EVENT_LABEL[normalized[0]] || 'Webhook'} (tương thích cũ)`;
}

function getCompatibilityAssignments(webhooks = []) {
  const assignments = new Map();
  for (const webhook of webhooks) {
    if (!isCompatibilityWebhook(webhook) || !webhook.url) continue;
    for (const eventType of orderedEvents(webhook.events)) {
      // The old format has exactly one destination per event. If a malformed
      // config contains duplicates, keep the first one to make migration
      // deterministic and avoid creating duplicate compatibility targets.
      if (assignments.has(eventType)) continue;
      assignments.set(eventType, {
        url: webhook.url,
        enabled: webhook.enabled !== false,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
        sourceId: webhook.id,
        sourceName: webhook.name,
      });
    }
  }
  return assignments;
}

function buildCompatibilityWebhooks(assignments) {
  const groups = new Map();
  for (const eventType of WEBHOOK_EVENTS) {
    const assignment = assignments.get(eventType);
    if (!assignment?.url) continue;
    const key = `${assignment.enabled !== false ? '1' : '0'}\u0000${assignment.url}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ eventType, ...assignment });
  }

  return [...groups.values()].map((entries) => {
    const events = entries.map((entry) => entry.eventType);
    const sourceIds = new Set(entries.map((entry) => entry.sourceId).filter(Boolean));
    const sourceNames = new Set(entries.map((entry) => entry.sourceName).filter(Boolean));
    const preserveSource = sourceIds.size === 1
      && entries.every((entry) => entry.sourceId && sourceIds.has(entry.sourceId));
    const id = preserveSource ? [...sourceIds][0] : compatibilityWebhookId(events);
    const name = preserveSource && sourceNames.size === 1
      ? [...sourceNames][0]
      : compatibilityWebhookName(events);
    const createdAt = entries.map((entry) => entry.createdAt).filter(Boolean).sort()[0];
    const updatedAt = entries.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1);

    return normalizeWebhook({
      id,
      name,
      url: entries[0].url,
      events,
      enabled: entries[0].enabled !== false,
      createdAt,
      updatedAt,
    }, id);
  });
}

function replaceCompatibilityWebhooks(webhooks = [], assignments = new Map()) {
  const current = Array.isArray(webhooks) ? webhooks : [];
  const firstCompatIndex = current.findIndex(isCompatibilityWebhook);
  const insertIndex = firstCompatIndex === -1
    ? current.length
    : current.slice(0, firstCompatIndex).filter((item) => !isCompatibilityWebhook(item)).length;
  const regular = current.filter((item) => !isCompatibilityWebhook(item));
  const compatibility = buildCompatibilityWebhooks(assignments);
  return [
    ...regular.slice(0, insertIndex),
    ...compatibility,
    ...regular.slice(insertIndex),
  ];
}

function compactCompatibilityWebhooks(webhooks = []) {
  const current = Array.isArray(webhooks) ? webhooks : [];
  if (!current.some(isCompatibilityWebhook)) return current;
  return replaceCompatibilityWebhooks(current, getCompatibilityAssignments(current));
}

function normalizeAccount(raw = {}) {
  const timestamp = nowIso();
  let webhooks = Array.isArray(raw?.webhooks)
    ? raw.webhooks.map((item) => normalizeWebhook(item)).filter((item) => item.url && item.events.length)
    : [];

  // Migrate v1's three fixed URLs into compatibility entries. When two or
  // more legacy event types use the same URL they are compacted into one
  // multi-event webhook, so the modern manager shows one card instead of
  // three identical cards.
  for (const [legacyKey, eventType] of Object.entries(LEGACY_KEY_TO_EVENT)) {
    const legacyUrl = normalizeUrl(raw?.[legacyKey]);
    if (!legacyUrl) continue;
    const duplicate = webhooks.some((item) => item.url === legacyUrl && item.events.includes(eventType));
    if (!duplicate) {
      webhooks.push(normalizeWebhook({
        id: compatWebhookId(eventType),
        name: `${EVENT_LABEL[eventType]} (tương thích cũ)`,
        url: legacyUrl,
        events: [eventType],
        enabled: true,
        createdAt: raw?.createdAt,
        updatedAt: raw?.updatedAt,
      }, compatWebhookId(eventType)));
    }
  }

  webhooks = compactCompatibilityWebhooks(webhooks);

  return {
    label: cleanText(raw?.label, 100),
    webhooks: webhooks.slice(0, MAX_WEBHOOKS_PER_ACCOUNT),
    createdAt: cleanText(raw?.createdAt, 64) || timestamp,
    updatedAt: cleanText(raw?.updatedAt, 64) || timestamp,
  };
}

function normalizeConfig(raw = {}) {
  const defaults = buildDefaultConfig();
  const accounts = {};
  if (raw?.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const [rawOwnId, account] of Object.entries(raw.accounts)) {
      const ownId = cleanOwnId(rawOwnId);
      if (!ownId) continue;
      accounts[ownId] = normalizeAccount(account);
    }
  }

  return {
    version: 2,
    default: {
      ...defaults.default,
      ...(raw?.default && typeof raw.default === 'object' ? {
        messageWebhookUrl: normalizeUrl(raw.default.messageWebhookUrl),
        groupEventWebhookUrl: normalizeUrl(raw.default.groupEventWebhookUrl),
        reactionWebhookUrl: normalizeUrl(raw.default.reactionWebhookUrl),
      } : {}),
    },
    accounts,
  };
}

let webhookConfig = buildDefaultConfig();

function touchAccount(account) {
  account.updatedAt = nowIso();
}

function ensureAccount(ownId, label = '') {
  const cleanId = cleanOwnId(ownId);
  if (!cleanId) return null;
  webhookConfig.accounts ??= {};
  if (!webhookConfig.accounts[cleanId]) {
    webhookConfig.accounts[cleanId] = normalizeAccount({ label });
  } else if (label !== undefined && label !== null && String(label).trim()) {
    webhookConfig.accounts[cleanId].label = cleanText(label, 100);
    touchAccount(webhookConfig.accounts[cleanId]);
  }
  return webhookConfig.accounts[cleanId];
}

function derivedLegacyUrl(account, eventType) {
  const compat = account?.webhooks?.find((item) => (
    isCompatibilityWebhook(item)
    && item.enabled
    && item.url
    && item.events.includes(eventType)
  ));
  if (compat) return compat.url;
  return account?.webhooks?.find((item) => item.enabled && item.url && item.events.includes(eventType))?.url || '';
}

function serializeCompat() {
  const cloned = structuredClone(webhookConfig);
  for (const account of Object.values(cloned.accounts || {})) {
    for (const [legacyKey, eventType] of Object.entries(LEGACY_KEY_TO_EVENT)) {
      account[legacyKey] = derivedLegacyUrl(account, eventType);
    }
  }
  return cloned;
}

export function loadWebhookConfig() {
  const configPath = getWebhookConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  if (!fs.existsSync(configPath)) {
    webhookConfig = buildDefaultConfig();
    saveWebhookConfig();
    return;
  }

  try {
    const rawText = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawText);
    webhookConfig = normalizeConfig(parsed);
    syncWebhookConfig(false);

    // Persist the v2 canonical shape after a successful v1 migration.
    if (Number(parsed?.version) !== 2 || JSON.stringify(parsed) !== JSON.stringify(webhookConfig)) {
      saveWebhookConfig();
    }
  } catch (error) {
    const backupPath = `${configPath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(configPath, backupPath); } catch {}
    console.error(`[Webhook] Cấu hình lỗi, dùng mặc định. Backup: ${backupPath}. ${error.message}`);
    webhookConfig = buildDefaultConfig();
    saveWebhookConfig();
  }
}

export function saveWebhookConfig() {
  try {
    writeJsonAtomicSync(getWebhookConfigPath(), webhookConfig);
    return true;
  } catch (error) {
    console.error('[Webhook] Không thể lưu cấu hình:', error.message || error);
    return false;
  }
}

/**
 * Return every enabled destination for one event. Account-specific webhooks
 * override the single default URL; duplicates are removed by URL.
 */
export function getWebhookTargets(eventType, ownId) {
  if (!WEBHOOK_EVENTS.includes(eventType)) return [];
  const cleanId = cleanOwnId(ownId);
  const account = cleanId ? webhookConfig.accounts?.[cleanId] : null;
  const accountUrls = (account?.webhooks || [])
    .filter((item) => item.enabled && item.url && item.events.includes(eventType))
    .map((item) => item.url);

  if (accountUrls.length) return [...new Set(accountUrls)];
  const fallbackKey = EVENT_TO_LEGACY_KEY[eventType];
  const fallbackUrl = normalizeUrl(webhookConfig.default?.[fallbackKey]);
  return fallbackUrl ? [fallbackUrl] : [];
}

export function getWebhookUrl(key, ownId) {
  const eventType = LEGACY_KEY_TO_EVENT[key];
  if (!eventType) return '';
  return getWebhookTargets(eventType, ownId)[0] || '';
}

export function setWebhookUrl(ownId, key, url) {
  return setAccountWebhookUrls(ownId, { [key]: url });
}

/** Backward-compatible updater for the old three fixed webhook fields. */
export function setAccountWebhookUrls(ownId, values = {}) {
  const account = ensureAccount(ownId);
  if (!account) return false;

  const assignments = getCompatibilityAssignments(account.webhooks);
  const timestamp = nowIso();

  for (const [legacyKey, eventType] of Object.entries(LEGACY_KEY_TO_EVENT)) {
    if (!Object.prototype.hasOwnProperty.call(values, legacyKey)) continue;
    const url = normalizeUrl(values[legacyKey]);
    if (!url) {
      assignments.delete(eventType);
      continue;
    }

    const current = assignments.get(eventType);
    assignments.set(eventType, {
      url,
      enabled: true,
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
      // Mark the changed event as a fresh compatibility assignment. Rebuild
      // will automatically merge it with other legacy events using the same URL.
      sourceId: '',
      sourceName: '',
    });
  }

  account.webhooks = replaceCompatibilityWebhooks(account.webhooks, assignments);
  touchAccount(account);
  return saveWebhookConfig();
}

/** Return v1 fields plus the v2 webhook list for one account. */
export function getAccountWebhookConfig(ownId) {
  const cleanId = cleanOwnId(ownId);
  if (!cleanId) return null;
  const account = webhookConfig.accounts?.[cleanId];
  const custom = account ? structuredClone(account) : { label: '', webhooks: [] };
  return {
    ownId: cleanId,
    label: custom.label || '',
    messageWebhookUrl: derivedLegacyUrl(custom, 'message') || webhookConfig.default?.messageWebhookUrl || '',
    groupEventWebhookUrl: derivedLegacyUrl(custom, 'group_event') || webhookConfig.default?.groupEventWebhookUrl || '',
    reactionWebhookUrl: derivedLegacyUrl(custom, 'reaction') || webhookConfig.default?.reactionWebhookUrl || '',
    webhooks: custom.webhooks || [],
    custom,
  };
}

export function setDefaultWebhookUrls(values = {}) {
  for (const key of Object.keys(LEGACY_KEY_TO_EVENT)) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      webhookConfig.default[key] = normalizeUrl(values[key]);
    }
  }
  return saveWebhookConfig();
}

export function removeWebhookConfig(ownId) {
  const cleanId = cleanOwnId(ownId);
  if (!cleanId) return false;
  if (webhookConfig.accounts?.[cleanId]) delete webhookConfig.accounts[cleanId];
  return saveWebhookConfig();
}

export function getAllWebhookConfigs() {
  return serializeCompat();
}

export function listWebhookAccounts() {
  return Object.entries(webhookConfig.accounts || {}).map(([ownId, account]) => ({
    ownId,
    label: account.label || '',
    webhookCount: account.webhooks.length,
    enabledCount: account.webhooks.filter((item) => item.enabled).length,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }));
}

export function createWebhookAccount(ownId, label = '') {
  const cleanId = cleanOwnId(ownId);
  if (!cleanId || webhookConfig.accounts?.[cleanId]) return null;
  const account = ensureAccount(cleanId, label);
  if (!saveWebhookConfig()) return null;
  return { ownId: cleanId, ...structuredClone(account) };
}

export function updateWebhookAccount(ownId, values = {}) {
  const currentId = cleanOwnId(ownId);
  const nextId = cleanOwnId(values.ownId ?? currentId);
  if (!currentId || !nextId || !webhookConfig.accounts?.[currentId]) return null;
  if (nextId !== currentId && webhookConfig.accounts[nextId]) return null;

  const account = webhookConfig.accounts[currentId];
  if (Object.prototype.hasOwnProperty.call(values, 'label')) {
    account.label = cleanText(values.label, 100);
  }
  touchAccount(account);

  if (nextId !== currentId) {
    webhookConfig.accounts[nextId] = account;
    delete webhookConfig.accounts[currentId];
  }
  if (!saveWebhookConfig()) return null;
  return { ownId: nextId, ...structuredClone(account) };
}

export function getWebhookAccount(ownId) {
  const cleanId = cleanOwnId(ownId);
  const account = cleanId ? webhookConfig.accounts?.[cleanId] : null;
  return account ? { ownId: cleanId, ...structuredClone(account) } : null;
}

export function createAccountWebhook(ownId, values = {}) {
  const account = ensureAccount(ownId);
  if (!account || account.webhooks.length >= MAX_WEBHOOKS_PER_ACCOUNT) return null;
  const events = normalizeEvents(values.events);
  const url = normalizeUrl(values.url);
  if (!url || !events.length) return null;
  const webhook = normalizeWebhook({
    id: crypto.randomUUID(),
    name: values.name,
    url,
    events,
    enabled: values.enabled !== false,
  });
  account.webhooks.push(webhook);
  touchAccount(account);
  if (!saveWebhookConfig()) return null;
  return structuredClone(webhook);
}

export function updateAccountWebhook(ownId, webhookId, values = {}) {
  const account = webhookConfig.accounts?.[cleanOwnId(ownId)];
  if (!account) return null;
  const id = cleanText(webhookId, 128);
  const index = account.webhooks.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const current = account.webhooks[index];
  const events = Object.prototype.hasOwnProperty.call(values, 'events')
    ? normalizeEvents(values.events)
    : current.events;
  const url = Object.prototype.hasOwnProperty.call(values, 'url')
    ? normalizeUrl(values.url)
    : current.url;
  if (!url || !events.length) return null;

  const next = normalizeWebhook({
    ...current,
    name: Object.prototype.hasOwnProperty.call(values, 'name') ? values.name : current.name,
    url,
    events,
    enabled: Object.prototype.hasOwnProperty.call(values, 'enabled') ? values.enabled !== false : current.enabled,
    updatedAt: nowIso(),
  }, current.id);
  account.webhooks[index] = next;
  touchAccount(account);
  if (!saveWebhookConfig()) return null;
  return structuredClone(next);
}

export function removeAccountWebhook(ownId, webhookId) {
  const account = webhookConfig.accounts?.[cleanOwnId(ownId)];
  if (!account) return false;
  const id = cleanText(webhookId, 128);
  const index = account.webhooks.findIndex((item) => item.id === id);
  if (index === -1) return false;
  account.webhooks.splice(index, 1);
  touchAccount(account);
  return saveWebhookConfig();
}

export function getAccountWebhook(ownId, webhookId) {
  const account = webhookConfig.accounts?.[cleanOwnId(ownId)];
  const id = cleanText(webhookId, 128);
  const webhook = account?.webhooks?.find((item) => item.id === id);
  return webhook ? structuredClone(webhook) : null;
}

export function getWebhookEventTypes() {
  return [...WEBHOOK_EVENTS];
}

export function syncWebhookConfig(persist = true) {
  const defaults = webhookConfig.default ?? (webhookConfig.default = {});
  if (process.env.MESSAGE_WEBHOOK_URL) defaults.messageWebhookUrl = process.env.MESSAGE_WEBHOOK_URL;
  if (process.env.GROUP_EVENT_WEBHOOK_URL) defaults.groupEventWebhookUrl = process.env.GROUP_EVENT_WEBHOOK_URL;
  if (process.env.REACTION_WEBHOOK_URL) defaults.reactionWebhookUrl = process.env.REACTION_WEBHOOK_URL;
  return persist ? saveWebhookConfig() : true;
}

export function broadcastToWebsocket(data) {
  try {
    broadcastMessage(JSON.stringify(data));
    return true;
  } catch (error) {
    console.error('[WebSocket] Không thể broadcast:', error.message || error);
    return false;
  }
}

export default {
  getWebhookUrl,
  getWebhookTargets,
  setWebhookUrl,
  setAccountWebhookUrls,
  getAccountWebhookConfig,
  setDefaultWebhookUrls,
  removeWebhookConfig,
  getAllWebhookConfigs,
  listWebhookAccounts,
  createWebhookAccount,
  updateWebhookAccount,
  getWebhookAccount,
  createAccountWebhook,
  updateAccountWebhook,
  removeAccountWebhook,
  getAccountWebhook,
  getWebhookEventTypes,
  loadWebhookConfig,
  saveWebhookConfig,
  syncWebhookConfig,
  broadcastToWebsocket,
};
