import fs from 'fs';
import path from 'path';
import { getDataFilePath } from '../config/addon.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { broadcastMessage } from './websocketHub.js';

function getWebhookConfigPath() {
  return getDataFilePath('webhook-config.json');
}

function buildDefaultConfig() {
  return {
    default: {
      messageWebhookUrl: process.env.MESSAGE_WEBHOOK_URL || '',
      groupEventWebhookUrl: process.env.GROUP_EVENT_WEBHOOK_URL || '',
      reactionWebhookUrl: process.env.REACTION_WEBHOOK_URL || '',
    },
    accounts: {},
  };
}

let webhookConfig = buildDefaultConfig();

export function loadWebhookConfig() {
  const configPath = getWebhookConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  if (!fs.existsSync(configPath)) {
    webhookConfig = buildDefaultConfig();
    saveWebhookConfig();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    webhookConfig = {
      default: { ...buildDefaultConfig().default, ...(parsed?.default || {}) },
      accounts: parsed?.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
    };
    syncWebhookConfig(false);
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

export function getWebhookUrl(key, ownId) {
  const accountValue = ownId ? webhookConfig.accounts?.[ownId]?.[key] : null;
  return accountValue || webhookConfig.default?.[key] || '';
}

export function setWebhookUrl(ownId, key, url) {
  if (!ownId || !['messageWebhookUrl', 'groupEventWebhookUrl', 'reactionWebhookUrl'].includes(key)) {
    return false;
  }
  webhookConfig.accounts[ownId] ??= {};
  webhookConfig.accounts[ownId][key] = String(url || '').trim();
  return saveWebhookConfig();
}

/** Update all webhook URLs for one account with a single atomic file write. */
export function setAccountWebhookUrls(ownId, values = {}) {
  if (!ownId) return false;
  const allowed = ['messageWebhookUrl', 'groupEventWebhookUrl', 'reactionWebhookUrl'];
  const next = { ...(webhookConfig.accounts?.[ownId] || {}) };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      next[key] = String(values[key] || '').trim();
    }
  }
  webhookConfig.accounts ??= {};
  webhookConfig.accounts[ownId] = next;
  return saveWebhookConfig();
}

/** Return account-specific values together with resolved defaults. */
export function getAccountWebhookConfig(ownId) {
  if (!ownId) return null;
  const custom = webhookConfig.accounts?.[ownId] || {};
  return {
    ownId: String(ownId),
    messageWebhookUrl: custom.messageWebhookUrl || webhookConfig.default?.messageWebhookUrl || '',
    groupEventWebhookUrl: custom.groupEventWebhookUrl || webhookConfig.default?.groupEventWebhookUrl || '',
    reactionWebhookUrl: custom.reactionWebhookUrl || webhookConfig.default?.reactionWebhookUrl || '',
    custom: structuredClone(custom),
  };
}

export function setDefaultWebhookUrls(values = {}) {
  const allowed = ['messageWebhookUrl', 'groupEventWebhookUrl', 'reactionWebhookUrl'];
  webhookConfig.default ??= {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      webhookConfig.default[key] = String(values[key] || '').trim();
    }
  }
  return saveWebhookConfig();
}

export function removeWebhookConfig(ownId) {
  if (webhookConfig.accounts?.[ownId]) delete webhookConfig.accounts[ownId];
  return saveWebhookConfig();
}

export function getAllWebhookConfigs() {
  return structuredClone(webhookConfig);
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
  setWebhookUrl,
  setAccountWebhookUrls,
  getAccountWebhookConfig,
  setDefaultWebhookUrls,
  removeWebhookConfig,
  loadWebhookConfig,
  saveWebhookConfig,
  getAllWebhookConfigs,
  syncWebhookConfig,
  broadcastToWebsocket,
};
