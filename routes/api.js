import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
    findUser,
    getUserInfo,
    sendFriendRequest,
    sendMessage,
    createGroup,
    getGroupInfo,
    addUserToGroup,
    removeUserFromGroup,
    sendImageToUser,
    sendImagesToUser,
    sendImageToGroup,
    sendImagesToGroup,
    // New APIs for account management
    getLoggedAccounts,
    getAccountDetails,
    // N8N-friendly wrapper APIs
    findUserByAccount,
    findUserByUsernameByAccount,
    getAvatarUrlProfileByAccount,
    getCloseFriendsByAccount,
    getFullAvatarByAccount,
    getMultiUsersByPhonesByAccount,
    getUserInfoByAccount,
    sendFriendRequestByAccount,
    sendMessageByAccount,
    createGroupByAccount,
    getGroupInfoByAccount,
    addUserToGroupByAccount,
    removeUserFromGroupByAccount,
    sendImageByAccount,
    sendImageToUserByAccount,
    sendImagesToUserByAccount,
    sendImageToGroupByAccount,
    sendImagesToGroupByAccount,
    sendFileByAccount,
    sendFile,
    // Friend Management
    acceptFriendRequestByAccount,
    blockUserByAccount,
    unblockUserByAccount,
    blockViewFeedByAccount,
    changeFriendAliasByAccount,
    removeFriendAliasByAccount,
    getAllFriendsByAccount,
    getAliasListByAccount,
    getFriendRecommendationsByAccount,
    getReceivedFriendRequestsByAccount,
    getSentFriendRequestByAccount,
    undoFriendRequestByAccount,
    rejectFriendRequestByAccount,
    getFriendOnlinesByAccount,
    getFriendRequestStatusByAccount,
    // Group Management
    addGroupDeputyByAccount,
    removeGroupDeputyByAccount,
    changeGroupAvatarByAccount,
    changeGroupNameByAccount,
    changeGroupOwnerByAccount,
    disperseGroupByAccount,
    enableGroupLinkByAccount,
    disableGroupLinkByAccount,
    getAllGroupsByAccount,
    getGroupChatHistoryByAccount,
    getGroupLinkInfoByAccount,
    getGroupMembersInfoByAccount,
    inviteUserToGroupsByAccount,
    joinGroupByAccount,
    leaveGroupByAccount,
    updateGroupSettingsByAccount,
    getGroupLinkDetailByAccount,
    getGroupInviteBoxListByAccount,
    getGroupInviteBoxInfoByAccount,
    joinGroupInviteBoxByAccount,
    deleteGroupInviteBoxByAccount,
    getGroupBlockedMemberByAccount,
    addGroupBlockedMemberByAccount,
    removeGroupBlockedMemberByAccount,
    getPendingGroupMembersByAccount,
    reviewPendingMemberRequestByAccount,
    getRelatedFriendGroupByAccount,
    // Message Interaction
    addReactionByAccount,
    deleteMessageByAccount,
    forwardMessageByAccount,
    parseLinkByAccount,
    sendCardByAccount,
    sendLinkByAccount,
    sendStickerByAccount,
    sendVideoByAccount,
    sendVoiceByAccount,
    undoByAccount,
    sendDeliveredEventByAccount,
    sendSeenEventByAccount,
    sendTypingEventByAccount,
    // Board & Notes
    createNoteByAccount,
    editNoteByAccount,
    getFriendBoardListByAccount,
    getListBoardByAccount,
    // Polls
    createPollByAccount,
    getPollDetailByAccount,
    lockPollByAccount,
    addPollOptionsByAccount,
    sharePollByAccount,
    votePollByAccount,
    // Reminders
    createReminderByAccount,
    editReminderByAccount,
    removeReminderByAccount,
    getReminderByAccount,
    getListReminderByAccount,
    getReminderResponsesByAccount,
    // Quick Messages
    addQuickMessageByAccount,
    getQuickMessageListByAccount,
    removeQuickMessageByAccount,
    updateQuickMessageByAccount,
    // Labels
    getLabelsByAccount,
    updateLabelsByAccount,
    // Conversation Management
    addUnreadMarkByAccount,
    removeUnreadMarkByAccount,
    deleteChatByAccount,
    getArchivedChatListByAccount,
    getAutoDeleteChatByAccount,
    updateAutoDeleteChatByAccount,
    getHiddenConversationsByAccount,
    setHiddenConversationsByAccount,
    updateHiddenConversPinByAccount,
    resetHiddenConversPinByAccount,
    getMuteByAccount,
    setMuteByAccount,
    getPinConversationsByAccount,
    setPinnedConversationsByAccount,
    getUnreadMarkByAccount,
    // Account Management
    changeAccountAvatarByAccount,
    deleteAvatarListByAccount,
    getAvatarListByAccount,
    reuseAvatarByAccount,
    updateProfileByAccount,
    updateLangByAccount,
    updateSettingsByAccount,
    getSettingsByAccount,
    updateActiveStatusByAccount,
    getBizAccountByAccount,
    // Others
    lastOnlineByAccount,
    sendReportByAccount,
    removeFriendByAccount,
    getStickersByAccount,
    getStickersDetailByAccount,
    searchStickerByAccount,
    getStickerCategoryDetailByAccount,
    updateArchivedChatListByAccount,
    updateProfileBioByAccount,
    upgradeGroupToCommunityByAccount
} from '../api/zalo/zalo.js';
import { validateUser, adminMiddleware, addUser, getAllUsers, changePassword, resetUserPassword, getUserFilePath } from '../services/authService.js';
import { getDataFilePath } from '../config/addon.js';
import {
    setAccountWebhookUrls,
    getAccountWebhookConfig,
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
} from '../services/webhookService.js';
import { triggerN8nWebhook } from '../utils/helpers.js';
import { proxyService } from '../services/proxyService.js';

const router = express.Router();

// Zalo identifiers frequently exceed JavaScript's safe integer range. JSON
// numbers above Number.MAX_SAFE_INTEGER are already rounded by JSON.parse and
// cannot be recovered. Reject those values early and require callers to send
// IDs as strings. Safe numeric IDs are normalized to strings for consistency.
const ZALO_ID_KEYS = new Set([
  'threadId', 'threadID', 'groupId', 'userId', 'memberId', 'friendId',
  'ownId', 'uid', 'uidFrom', 'idTo', 'conversationId',
  'msgId', 'cliMsgId', 'globalMsgId', 'ownerId', 'actionId',
  'reminderId', 'topicId', 'photoId'
]);
const ZALO_ID_LIST_KEYS = new Set([
  'threadIds', 'groupIds', 'userIds', 'memberIds', 'friendIds',
  'msgIds'
]);

function normalizeZaloIdsInPlace(value, key = '') {
  if (value === null || value === undefined) return value;

  if (ZALO_ID_KEYS.has(key)) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${key} vượt giới hạn số nguyên an toàn của JavaScript; hãy gửi ID dưới dạng chuỗi JSON.`);
      }
      return String(value);
    }
    const text = typeof value === 'string' ? value : String(value);
    return text.toLowerCase().startsWith('zalo:') ? text.slice(5) : text;
  }

  if (ZALO_ID_LIST_KEYS.has(key)) {
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => {
      if (typeof item === 'number' && !Number.isSafeInteger(item)) {
        throw new Error(`${key} chứa ID vượt giới hạn số nguyên an toàn của JavaScript; hãy gửi ID dưới dạng chuỗi JSON.`);
      }
      const text = String(item);
      return text.toLowerCase().startsWith('zalo:') ? text.slice(5) : text;
    });
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = normalizeZaloIdsInPlace(value[i]);
    }
    return value;
  }

  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      value[childKey] = normalizeZaloIdsInPlace(childValue, childKey);
    }
  }
  return value;
}

router.use((req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') {
      normalizeZaloIdsInPlace(req.body);
    }
    next();
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Lightweight unauthenticated health endpoint for Home Assistant/monitoring.
// Không chạm Zalo API để phản hồi nhanh và không làm tăng nguy cơ rate-limit.
router.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version || '1.2.1',
  });
});

// Dành cho ES Module: xác định __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API xác thực
// Đăng nhập
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu' });
    }

    const user = validateUser(username, password);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Tài khoản hoặc mật khẩu không chính xác' });
    }

    if (!req.session) {
      return res.status(500).json({ success: false, message: 'Lỗi server: session không khả dụng' });
    }

    // Regenerate session ID after authentication to avoid session fixation.
    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        console.error('[Auth] Không thể regenerate session:', regenerateError.message);
        return res.status(500).json({ success: false, message: 'Không thể tạo phiên đăng nhập' });
      }

      req.session.authenticated = true;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.save((saveError) => {
        if (saveError) {
          console.error('[Auth] Không thể lưu session:', saveError.message);
          return res.status(500).json({ success: false, message: 'Không thể lưu phiên đăng nhập' });
        }
        return res.json({ success: true, user });
      });
    });
  } catch (error) {
    console.error('[Auth] Login error:', error.message);
    return res.status(500).json({ success: false, message: 'Lỗi server khi xử lý đăng nhập' });
  }
});

// Đăng xuất (hỗ trợ cả GET và POST)
router.all('/logout', (req, res) => {
  console.log('Logout requested');
  if (req.session) {
    req.session.destroy(err => {
      if (err) {
        console.error('Error destroying session:', err);
        return res.status(500).json({ success: false, message: 'Lỗi khi đăng xuất' });
      }
      console.log('Session destroyed successfully');
      res.json({ success: true, message: 'Đã đăng xuất thành công' });
    });
  } else {
    console.log('No session to destroy');
    res.json({ success: true, message: 'Đã đăng xuất thành công' });
  }
});

// Lấy thông tin người dùng hiện tại
router.get('/user', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
  }

  res.json({
    success: true,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// API quản lý người dùng (chỉ admin)
// Lấy danh sách người dùng
router.get('/users', adminMiddleware, (req, res) => {
  const users = getAllUsers();
  res.json({ success: true, users });
});

// Thêm người dùng mới
router.post('/users', adminMiddleware, (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 8 ký tự' });
  }

  const success = addUser(username, password, role || 'user');
  if (!success) {
    return res.status(400).json({ success: false, message: 'Tài khoản đã tồn tại' });
  }

  res.json({ success: true, message: 'Đã thêm người dùng thành công' });
});

// Đổi mật khẩu
router.post('/change-password', (req, res) => {
  if (!req.session?.authenticated) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
  }

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ mật khẩu cũ và mới' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
  }

  const success = changePassword(req.session.username, oldPassword, newPassword);
  if (!success) {
    return res.status(400).json({ success: false, message: 'Mật khẩu cũ không chính xác' });
  }
  return res.json({ success: true, message: 'Đã đổi mật khẩu thành công' });
});

// Kiểm tra phiên đăng nhập
router.get('/check-auth', (req, res) => {
  if (req.session.authenticated) {
    return res.json({
      authenticated: true,
      username: req.session.username,
      role: req.session.role
    });
  }

  res.json({ authenticated: false });
});

// Endpoint debug đăng nhập cũ đã bị vô hiệu hóa để tránh log/luồng auth song song.
router.all('/simple-login', (_req, res) =>
  res.status(410).json({ success: false, error: 'deprecated_endpoint', use: '/api/login' })
);


router.post('/findUser', findUser);
router.post('/getUserInfo', getUserInfo);
router.post('/sendFriendRequest', sendFriendRequest);
router.post('/sendmessage', sendMessage);
router.post('/createGroup', createGroup);
router.post('/getGroupInfo', getGroupInfo);
router.post('/addUserToGroup', addUserToGroup);
router.post('/removeUserFromGroup', removeUserFromGroup);
router.post('/sendImageToUser', sendImageToUser);
router.post('/sendImagesToUser', sendImagesToUser);
router.post('/sendImageToGroup', sendImageToGroup);
router.post('/sendImagesToGroup', sendImagesToGroup);
router.post('/sendFile', sendFile);

// ===== NEW ACCOUNT MANAGEMENT APIs =====
// API để lấy danh sách tài khoản đã đăng nhập
router.get('/accounts', getLoggedAccounts);

function isValidOptionalWebhookUrl(value) {
  if (value == null || String(value).trim() === '') return true;
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidWebhookUrl(value) {
  if (!value || String(value).trim().length > 4096) return false;
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidWebhookAccountId(value) {
  const text = String(value || '').trim();
  return text.length > 0 && text.length <= 128 && !/[\x00-\x1f\x7f]/.test(text);
}

function normalizeWebhookEvents(value) {
  const allowed = new Set(getWebhookEventTypes());
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(String).filter((event) => allowed.has(event)))];
}

// Webhook configuration APIs used by the web UI and Home Assistant integration.
router.get('/account-webhooks', (_req, res) => {
  res.json({ success: true, data: getAllWebhookConfigs() });
});

router.get('/account-webhook/:ownId', (req, res) => {
  const data = getAccountWebhookConfig(req.params.ownId);
  if (!data) return res.status(400).json({ success: false, error: 'ownId is required' });
  return res.json({ success: true, data });
});

router.post('/account-webhook', (req, res) => {
  const { ownId, messageWebhookUrl, groupEventWebhookUrl, reactionWebhookUrl } = req.body || {};
  if (!ownId) return res.status(400).json({ success: false, error: 'ownId is required' });
  const values = { messageWebhookUrl, groupEventWebhookUrl, reactionWebhookUrl };
  for (const [key, value] of Object.entries(values)) {
    if (!isValidOptionalWebhookUrl(value)) {
      return res.status(400).json({ success: false, error: `${key} must be an http/https URL or empty` });
    }
  }
  if (!setAccountWebhookUrls(String(ownId), values)) {
    return res.status(500).json({ success: false, error: 'Không thể lưu cấu hình webhook' });
  }
  return res.json({ success: true, data: getAccountWebhookConfig(String(ownId)) });
});

router.delete('/account-webhook/:ownId', (req, res) => {
  if (!removeWebhookConfig(req.params.ownId)) {
    return res.status(500).json({ success: false, error: 'Không thể xóa cấu hình webhook' });
  }
  return res.json({ success: true });
});


// ===== WEBHOOK V2: many destinations per account ID =====
router.get('/webhook-accounts', (_req, res) => {
  return res.json({ success: true, data: listWebhookAccounts(), eventTypes: getWebhookEventTypes() });
});

router.post('/webhook-accounts', (req, res) => {
  const { ownId, label = '' } = req.body || {};
  if (!isValidWebhookAccountId(ownId)) {
    return res.status(400).json({ success: false, error: 'ID tài khoản không hợp lệ' });
  }
  const created = createWebhookAccount(String(ownId).trim(), label);
  if (!created) {
    return res.status(409).json({ success: false, error: 'ID tài khoản đã tồn tại hoặc không thể lưu cấu hình' });
  }
  return res.status(201).json({ success: true, data: created });
});

router.get('/webhook-accounts/:ownId', (req, res) => {
  const account = getWebhookAccount(req.params.ownId);
  if (!account) return res.status(404).json({ success: false, error: 'Không tìm thấy ID tài khoản' });
  return res.json({ success: true, data: account });
});

router.put('/webhook-accounts/:ownId', (req, res) => {
  const nextOwnId = req.body?.ownId ?? req.params.ownId;
  if (!isValidWebhookAccountId(nextOwnId)) {
    return res.status(400).json({ success: false, error: 'ID tài khoản mới không hợp lệ' });
  }
  const updated = updateWebhookAccount(req.params.ownId, {
    ownId: String(nextOwnId).trim(),
    label: req.body?.label ?? '',
  });
  if (!updated) {
    return res.status(409).json({ success: false, error: 'Không tìm thấy ID tài khoản hoặc ID mới đã tồn tại' });
  }
  return res.json({ success: true, data: updated });
});

router.delete('/webhook-accounts/:ownId', (req, res) => {
  const existing = getWebhookAccount(req.params.ownId);
  if (!existing) return res.status(404).json({ success: false, error: 'Không tìm thấy ID tài khoản' });
  if (!removeWebhookConfig(req.params.ownId)) {
    return res.status(500).json({ success: false, error: 'Không thể xóa cấu hình ID tài khoản' });
  }
  return res.json({ success: true });
});

router.post('/webhook-accounts/:ownId/webhooks', (req, res) => {
  const account = getWebhookAccount(req.params.ownId);
  if (!account) return res.status(404).json({ success: false, error: 'Không tìm thấy ID tài khoản' });
  const events = normalizeWebhookEvents(req.body?.events);
  if (!isValidWebhookUrl(req.body?.url)) {
    return res.status(400).json({ success: false, error: 'Webhook URL phải dùng http/https' });
  }
  if (!events.length) {
    return res.status(400).json({ success: false, error: 'Phải chọn ít nhất một loại sự kiện' });
  }
  const created = createAccountWebhook(req.params.ownId, {
    name: req.body?.name || 'Webhook',
    url: String(req.body.url).trim(),
    events,
    enabled: req.body?.enabled !== false,
  });
  if (!created) {
    return res.status(400).json({ success: false, error: 'Không thể thêm webhook; tối đa 50 webhook cho mỗi ID tài khoản' });
  }
  return res.status(201).json({ success: true, data: created });
});

router.put('/webhook-accounts/:ownId/webhooks/:webhookId', (req, res) => {
  const existing = getAccountWebhook(req.params.ownId, req.params.webhookId);
  if (!existing) return res.status(404).json({ success: false, error: 'Không tìm thấy webhook' });
  const events = Object.prototype.hasOwnProperty.call(req.body || {}, 'events')
    ? normalizeWebhookEvents(req.body.events)
    : existing.events;
  const url = Object.prototype.hasOwnProperty.call(req.body || {}, 'url')
    ? req.body.url
    : existing.url;
  if (!isValidWebhookUrl(url)) {
    return res.status(400).json({ success: false, error: 'Webhook URL phải dùng http/https' });
  }
  if (!events.length) {
    return res.status(400).json({ success: false, error: 'Phải chọn ít nhất một loại sự kiện' });
  }
  const updated = updateAccountWebhook(req.params.ownId, req.params.webhookId, {
    name: Object.prototype.hasOwnProperty.call(req.body || {}, 'name') ? req.body.name : existing.name,
    url: String(url).trim(),
    events,
    enabled: Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled') ? req.body.enabled !== false : existing.enabled,
  });
  if (!updated) return res.status(500).json({ success: false, error: 'Không thể cập nhật webhook' });
  return res.json({ success: true, data: updated });
});

router.delete('/webhook-accounts/:ownId/webhooks/:webhookId', (req, res) => {
  if (!getAccountWebhook(req.params.ownId, req.params.webhookId)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy webhook' });
  }
  if (!removeAccountWebhook(req.params.ownId, req.params.webhookId)) {
    return res.status(500).json({ success: false, error: 'Không thể xóa webhook' });
  }
  return res.json({ success: true });
});

router.post('/webhook-accounts/:ownId/webhooks/:webhookId/test', async (req, res) => {
  const webhook = getAccountWebhook(req.params.ownId, req.params.webhookId);
  if (!webhook) return res.status(404).json({ success: false, error: 'Không tìm thấy webhook' });
  if (!webhook.enabled) return res.status(400).json({ success: false, error: 'Webhook đang tắt' });
  const delivered = await triggerN8nWebhook({
    event: 'zalo_server_webhook_test',
    _accountId: req.params.ownId,
    webhookId: webhook.id,
    webhookName: webhook.name,
    timestamp: new Date().toISOString(),
  }, webhook.url);
  if (!delivered) return res.status(502).json({ success: false, error: 'Webhook không phản hồi thành công' });
  return res.json({ success: true });
});

// Proxy APIs used by the modern UI. Keep the old /proxies UI route separate.
router.get('/proxies', (_req, res) => {
  return res.json({ success: true, data: proxyService.getPROXIES() });
});

router.post('/proxies', (req, res) => {
  const proxyUrl = String(req.body?.proxyUrl || '').trim();
  if (!proxyUrl) return res.status(400).json({ success: false, error: 'proxyUrl không hợp lệ' });
  try {
    const proxy = proxyService.addProxy(proxyUrl);
    return res.status(201).json({ success: true, data: { url: proxy.url, accounts: [...proxy.accountIds], usedCount: proxy.accountIds.size } });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/proxies', (req, res) => {
  const proxyUrl = String(req.body?.proxyUrl || '').trim();
  if (!proxyUrl) return res.status(400).json({ success: false, error: 'proxyUrl không hợp lệ' });
  try {
    proxyService.removeProxy(proxyUrl);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({ success: false, error: error.message });
  }
});

// API để lấy thông tin chi tiết một tài khoản
router.get('/accounts/:ownId', getAccountDetails);

// ===== N8N-FRIENDLY WRAPPER APIs =====
// API tìm user với account selection (thay vì ownId)
router.post('/findUserByAccount', findUserByAccount);
router.post('/findUserByUsernameByAccount', findUserByUsernameByAccount);
router.post('/getAvatarUrlProfileByAccount', getAvatarUrlProfileByAccount);
router.post('/getCloseFriendsByAccount', getCloseFriendsByAccount);
router.post('/getFullAvatarByAccount', getFullAvatarByAccount);
router.post('/getMultiUsersByPhonesByAccount', getMultiUsersByPhonesByAccount);

// API gửi tin nhắn với account selection
router.post('/sendMessageByAccount', sendMessageByAccount);

// API gửi hình ảnh với account selection
router.post('/sendImageByAccount', sendImageByAccount);

// API lấy thông tin user với account selection
router.post('/getUserInfoByAccount', getUserInfoByAccount);

// API gửi lời mời kết bạn với account selection
router.post('/sendFriendRequestByAccount', sendFriendRequestByAccount);

// API tạo nhóm với account selection
router.post('/createGroupByAccount', createGroupByAccount);

// API lấy thông tin nhóm với account selection
router.post('/getGroupInfoByAccount', getGroupInfoByAccount);

// API thêm thành viên vào nhóm với account selection
router.post('/addUserToGroupByAccount', addUserToGroupByAccount);

// API xóa thành viên khỏi nhóm với account selection
router.post('/removeUserFromGroupByAccount', removeUserFromGroupByAccount);

// API gửi hình ảnh đến user với account selection
router.post('/sendImageToUserByAccount', sendImageToUserByAccount);

// API gửi nhiều hình ảnh đến user với account selection
router.post('/sendImagesToUserByAccount', sendImagesToUserByAccount);

// API gửi hình ảnh đến nhóm với account selection
router.post('/sendImageToGroupByAccount', sendImageToGroupByAccount);

// API gửi nhiều hình ảnh đến nhóm với account selection
router.post('/sendImagesToGroupByAccount', sendImagesToGroupByAccount);

// API gửi file với account selection
router.post('/sendFileByAccount', sendFileByAccount);

// ===== NEW FRIEND MANAGEMENT APIs =====
router.post('/acceptFriendRequestByAccount', acceptFriendRequestByAccount);
router.post('/blockUserByAccount', blockUserByAccount);
router.post('/unblockUserByAccount', unblockUserByAccount);
router.post('/blockViewFeedByAccount', blockViewFeedByAccount);
router.post('/changeFriendAliasByAccount', changeFriendAliasByAccount);
router.post('/removeFriendAliasByAccount', removeFriendAliasByAccount);
router.post('/getAllFriendsByAccount', getAllFriendsByAccount);
router.post('/getAliasListByAccount', getAliasListByAccount);
router.post('/getFriendRecommendationsByAccount', getFriendRecommendationsByAccount);
router.post('/getReceivedFriendRequestsByAccount', getReceivedFriendRequestsByAccount);
router.post('/getSentFriendRequestByAccount', getSentFriendRequestByAccount);
router.post('/undoFriendRequestByAccount', undoFriendRequestByAccount);
router.post('/rejectFriendRequestByAccount', rejectFriendRequestByAccount);
router.post('/getFriendOnlinesByAccount', getFriendOnlinesByAccount);
router.post('/getFriendRequestStatusByAccount', getFriendRequestStatusByAccount);
router.post('/removeFriendByAccount', removeFriendByAccount);

// ===== NEW GROUP MANAGEMENT APIs =====
router.post('/addGroupDeputyByAccount', addGroupDeputyByAccount);
router.post('/removeGroupDeputyByAccount', removeGroupDeputyByAccount);
router.post('/changeGroupAvatarByAccount', changeGroupAvatarByAccount);
router.post('/changeGroupNameByAccount', changeGroupNameByAccount);
router.post('/changeGroupOwnerByAccount', changeGroupOwnerByAccount);
router.post('/disperseGroupByAccount', disperseGroupByAccount);
router.post('/enableGroupLinkByAccount', enableGroupLinkByAccount);
router.post('/disableGroupLinkByAccount', disableGroupLinkByAccount);
router.post('/getAllGroupsByAccount', getAllGroupsByAccount);
router.post('/getGroupChatHistoryByAccount', getGroupChatHistoryByAccount);
router.post('/getGroupLinkInfoByAccount', getGroupLinkInfoByAccount);
router.post('/getGroupMembersInfoByAccount', getGroupMembersInfoByAccount);
router.post('/inviteUserToGroupsByAccount', inviteUserToGroupsByAccount);
router.post('/joinGroupByAccount', joinGroupByAccount);
router.post('/leaveGroupByAccount', leaveGroupByAccount);
router.post('/updateGroupSettingsByAccount', updateGroupSettingsByAccount);
router.post('/upgradeGroupToCommunityByAccount', upgradeGroupToCommunityByAccount);
router.post('/getGroupLinkDetailByAccount', getGroupLinkDetailByAccount);
router.post('/getGroupInviteBoxListByAccount', getGroupInviteBoxListByAccount);
router.post('/getGroupInviteBoxInfoByAccount', getGroupInviteBoxInfoByAccount);
router.post('/joinGroupInviteBoxByAccount', joinGroupInviteBoxByAccount);
router.post('/deleteGroupInviteBoxByAccount', deleteGroupInviteBoxByAccount);
router.post('/getGroupBlockedMemberByAccount', getGroupBlockedMemberByAccount);
router.post('/addGroupBlockedMemberByAccount', addGroupBlockedMemberByAccount);
router.post('/removeGroupBlockedMemberByAccount', removeGroupBlockedMemberByAccount);
router.post('/getPendingGroupMembersByAccount', getPendingGroupMembersByAccount);
router.post('/reviewPendingMemberRequestByAccount', reviewPendingMemberRequestByAccount);
router.post('/getRelatedFriendGroupByAccount', getRelatedFriendGroupByAccount);

// ===== NEW MESSAGE INTERACTION APIs =====
router.post('/addReactionByAccount', addReactionByAccount);
router.post('/deleteMessageByAccount', deleteMessageByAccount);
router.post('/forwardMessageByAccount', forwardMessageByAccount);
router.post('/parseLinkByAccount', parseLinkByAccount);
router.post('/sendCardByAccount', sendCardByAccount);
router.post('/sendLinkByAccount', sendLinkByAccount);
router.post('/sendStickerByAccount', sendStickerByAccount);
router.post('/getStickersByAccount', getStickersByAccount);
router.post('/getStickersDetailByAccount', getStickersDetailByAccount);
router.post('/searchStickerByAccount', searchStickerByAccount);
router.post('/getStickerCategoryDetailByAccount', getStickerCategoryDetailByAccount);
router.post('/sendVideoByAccount', sendVideoByAccount);
router.post('/sendVoiceByAccount', sendVoiceByAccount);
router.post('/undoByAccount', undoByAccount);
router.post('/sendDeliveredEventByAccount', sendDeliveredEventByAccount);
router.post('/sendSeenEventByAccount', sendSeenEventByAccount);
router.post('/sendTypingEventByAccount', sendTypingEventByAccount);

// ===== NEW BOARD & NOTES APIs =====
router.post('/createNoteByAccount', createNoteByAccount);
router.post('/editNoteByAccount', editNoteByAccount);
router.post('/getFriendBoardListByAccount', getFriendBoardListByAccount);
router.post('/getListBoardByAccount', getListBoardByAccount);

// ===== NEW POLLS APIs =====
router.post('/createPollByAccount', createPollByAccount);
router.post('/getPollDetailByAccount', getPollDetailByAccount);
router.post('/lockPollByAccount', lockPollByAccount);
router.post('/addPollOptionsByAccount', addPollOptionsByAccount);
router.post('/sharePollByAccount', sharePollByAccount);
router.post('/votePollByAccount', votePollByAccount);

// ===== NEW REMINDERS APIs =====
router.post('/createReminderByAccount', createReminderByAccount);
router.post('/editReminderByAccount', editReminderByAccount);
router.post('/removeReminderByAccount', removeReminderByAccount);
router.post('/getReminderByAccount', getReminderByAccount);
router.post('/getListReminderByAccount', getListReminderByAccount);
router.post('/getReminderResponsesByAccount', getReminderResponsesByAccount);

// ===== NEW QUICK MESSAGES APIs =====
router.post('/addQuickMessageByAccount', addQuickMessageByAccount);
router.post('/getQuickMessageListByAccount', getQuickMessageListByAccount);
router.post('/removeQuickMessageByAccount', removeQuickMessageByAccount);
router.post('/updateQuickMessageByAccount', updateQuickMessageByAccount);

// ===== NEW LABELS APIs =====
router.post('/getLabelsByAccount', getLabelsByAccount);
router.post('/updateLabelsByAccount', updateLabelsByAccount);

// ===== NEW CONVERSATION MANAGEMENT APIs =====
router.post('/addUnreadMarkByAccount', addUnreadMarkByAccount);
router.post('/removeUnreadMarkByAccount', removeUnreadMarkByAccount);
router.post('/deleteChatByAccount', deleteChatByAccount);
router.post('/getArchivedChatListByAccount', getArchivedChatListByAccount);
router.post('/updateArchivedChatListByAccount', updateArchivedChatListByAccount);
router.post('/getAutoDeleteChatByAccount', getAutoDeleteChatByAccount);
router.post('/updateAutoDeleteChatByAccount', updateAutoDeleteChatByAccount);
router.post('/getHiddenConversationsByAccount', getHiddenConversationsByAccount);
router.post('/setHiddenConversationsByAccount', setHiddenConversationsByAccount);
router.post('/updateHiddenConversPinByAccount', updateHiddenConversPinByAccount);
router.post('/resetHiddenConversPinByAccount', resetHiddenConversPinByAccount);
router.post('/getMuteByAccount', getMuteByAccount);
router.post('/setMuteByAccount', setMuteByAccount);
router.post('/getPinConversationsByAccount', getPinConversationsByAccount);
router.post('/setPinnedConversationsByAccount', setPinnedConversationsByAccount);
router.post('/getUnreadMarkByAccount', getUnreadMarkByAccount);

// ===== NEW ACCOUNT PROFILE MANAGEMENT APIs =====
router.post('/changeAccountAvatarByAccount', changeAccountAvatarByAccount);
router.post('/deleteAvatarListByAccount', deleteAvatarListByAccount);
router.post('/getAvatarListByAccount', getAvatarListByAccount);
router.post('/reuseAvatarByAccount', reuseAvatarByAccount);
router.post('/updateProfileByAccount', updateProfileByAccount);
router.post('/updateProfileBioByAccount', updateProfileBioByAccount);
router.post('/updateLangByAccount', updateLangByAccount);
router.post('/updateSettingsByAccount', updateSettingsByAccount);
router.post('/getSettingsByAccount', getSettingsByAccount);
router.post('/updateActiveStatusByAccount', updateActiveStatusByAccount);
router.post('/getBizAccountByAccount', getBizAccountByAccount);

// ===== OTHER APIs =====
router.post('/lastOnlineByAccount', lastOnlineByAccount);
router.post('/sendReportByAccount', sendReportByAccount);

// API kiểm tra trạng thái session
router.get('/session-test', adminMiddleware, (req, res) => {
  if (process.env.ENABLE_DEBUG_ENDPOINTS !== 'true') {
    return res.status(404).json({ success: false, error: 'not_found' });
  }
  try {
    // Kiểm tra session object có tồn tại không
    const hasSession = !!req.session;

    // Lấy thông tin session hiện tại
    const sessionInfo = {
      exists: hasSession,
      id: req.sessionID || 'no-session-id',
      isAuthenticated: hasSession && req.session.authenticated === true,
      username: hasSession ? (req.session.username || 'none') : 'no-session',
      role: hasSession ? (req.session.role || 'none') : 'no-session',
      cookieSettings: hasSession ? {
        maxAge: req.session.cookie.maxAge,
        httpOnly: req.session.cookie.httpOnly,
        secure: req.session.cookie.secure,
        path: req.session.cookie.path
      } : 'no-cookie'
    };

    // Trả về thông tin
    return res.json({
      success: true,
      message: 'Session test',
      sessionInfo
    });
  } catch (error) {
    console.error('Session test error:', error);
    return res.json({
      success: false,
      message: 'Lỗi khi kiểm tra session',
      error: error.message || 'Unknown error'
    });
  }
});

// Thêm một API đăng nhập đơn giản mới để test - simplified
router.all('/test-login', (_req, res) =>
  res.status(410).json({ success: false, error: 'deprecated_endpoint', use: '/api/login' })
);

router.get('/debug-webhook-config', adminMiddleware, (req, res) => {
    if (process.env.ENABLE_DEBUG_ENDPOINTS !== 'true') {
        return res.status(404).json({ success: false, error: 'not_found' });
    }
    try {
        const webhookConfigs = getAllWebhookConfigs();
        const webhookConfigPath = getDataFilePath('webhook-config.json');
        const fileExists = fs.existsSync(webhookConfigPath);

        res.json({
            success: true,
            configExists: !!webhookConfigs,
            fileExists: fileExists,
            data: webhookConfigs,
            dirname: __dirname,
            configPath: webhookConfigPath
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// Endpoint debug để kiểm tra file users.json
router.get('/debug-users-file', adminMiddleware, (req, res) => {
    if (process.env.ENABLE_DEBUG_ENDPOINTS !== 'true') {
        return res.status(404).json({ success: false, error: 'not_found' });
    }
    try {
        const userFilePath = getUserFilePath();
        const fileExists = fs.existsSync(userFilePath);
        let fileContent = null;
        let users = [];

        if (fileExists) {
            fileContent = fs.readFileSync(userFilePath, 'utf8');
            try {
                users = JSON.parse(fileContent);
                // Che giấu thông tin nhạy cảm
                users = users.map(user => ({
                    username: user.username,
                    role: user.role,
                    saltLength: user.salt ? user.salt.length : 0,
                    hashLength: user.hash ? user.hash.length : 0,
                    saltPrefix: user.salt ? user.salt.substring(0, 5) + '...' : null,
                    hashPrefix: user.hash ? user.hash.substring(0, 5) + '...' : null
                }));
            } catch (parseError) {
                return res.status(500).json({
                    success: false,
                    error: 'Invalid JSON in users file',
                    parseError: parseError.message
                });
            }
        }

        res.json({
            success: true,
            fileExists: fileExists,
            filePath: userFilePath,
            fileSize: fileContent ? fileContent.length : 0,
            users: users
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// Recovery endpoint is disabled by default. If explicitly enabled, an already
// authenticated admin must provide the new password; there is no insecure
// hard-coded reset back to admin/admin.
router.post('/reset-admin-password', adminMiddleware, (req, res) => {
  if (process.env.ENABLE_ADMIN_PASSWORD_RESET !== 'true') {
    return res.status(404).json({ success: false, error: 'not_found' });
  }
  try {
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
    }
    if (!resetUserPassword('admin', newPassword)) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài khoản admin' });
    }
    return res.json({ success: true, message: 'Đã đặt mật khẩu admin mới.' });
  } catch (error) {
    console.error('[Auth] Lỗi reset mật khẩu admin:', error.message);
    return res.status(500).json({ success: false, error: 'Không thể reset mật khẩu admin' });
  }
});

export default router;
