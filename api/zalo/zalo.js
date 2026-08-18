// api/zalo/zalo.js
import { AvatarSize, DestType, Gender, GroupMessage, Zalo, ThreadType, UpdateSettingsType } from 'zca-js';
import { getAvailableProxyIndex, getProxyRef, markProxyAccount, addProxy, getPROXIES } from '../../services/proxyService.js';
import { setupEventListeners, configureReconnectDependencies } from '../../eventListeners.js';
import { HttpsProxyAgent } from "https-proxy-agent";
import { imageSizeFromFile } from "image-size/fromFile";
import nodefetch from "node-fetch";
import fs from 'fs';
import path from 'path';
import { saveImage, saveImages, removeImage, saveFileFromUrl, removeFile } from '../../utils/helpers.js';
import { writeJsonAtomicSync } from '../../utils/atomicFile.js';
import { getRequestedMessageTtl, messageTtlResult, normalizeAutoDeleteTtl, normalizeMessageTtl, normalizeThreadType, withMessageTtl } from '../../utils/autoDelete.js';
import { getCachedGroupHistory } from '../../utils/groupHistoryStore.js';

export const zaloAccounts = [];
// Inject reconnect dependencies instead of importing zalo.js back from eventListeners.js.
// This removes the circular ESM dependency between login and listener modules.
configureReconnectDependencies({
    accounts: zaloAccounts,
    login: (...args) => loginZaloAccount(...args),
});
let healthCheckRunning = false;

async function withTimeout(promise, timeoutMs, label = 'Operation timeout') {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Chức năng tự động kiểm tra trạng thái đăng nhập (10 phút/lần)
// v1.0.1: Health-check chỉ quan sát trạng thái. KHÔNG xóa cookie hoặc tài khoản
// khi gặp timeout/lỗi mạng tạm thời, để cơ chế reconnect có thể tự phục hồi.
async function checkLoginStatus() {
    if (healthCheckRunning) {
        console.log('[Docker] Bỏ qua health-check vì lần trước vẫn đang chạy.');
        return;
    }
    healthCheckRunning = true;
    console.log("[Docker] Đang kiểm tra trạng thái đăng nhập của tất cả tài khoản...");

    if (zaloAccounts.length === 0) {
        console.log("[Docker] Không có tài khoản nào để kiểm tra");
        healthCheckRunning = false;
        return;
    }

    const checkPromises = zaloAccounts.map(async (account) => {
        const accountLabel = account?.phoneNumber || account?.ownId || 'không xác định';

        if (!account || !account.api) {
            console.warn(`[Docker] Tài khoản ${accountLabel} hiện không có API. Giữ nguyên credential để có thể khôi phục.`);
            return { healthy: false, account };
        }

        try {
            const accountInfo = await withTimeout(
                account.api.fetchAccountInfo(),
                30_000,
                'Health-check timeout'
            );

            if (accountInfo?.profile) {
                console.log(`[Docker] Tài khoản ${accountLabel} vẫn đăng nhập thành công`);
                return { healthy: true, account };
            }

            console.warn(`[Docker] Tài khoản ${accountLabel} không trả về profile. Không xóa cookie; chờ listener/reconnect xử lý.`);
            return { healthy: false, account };
        } catch (error) {
            console.warn(`[Docker] Health-check lỗi cho tài khoản ${accountLabel}: ${error.message}. Không xóa cookie.`);
            return { healthy: false, account, transientError: true };
        }
    });

    try {
        const results = await Promise.all(checkPromises);
        const healthyCount = results.filter(result => result.healthy).length;
        const unhealthyCount = results.length - healthyCount;
        console.log(`[Docker] Hoàn thành kiểm tra: ${healthyCount} khỏe, ${unhealthyCount} cần theo dõi. Cookie được giữ nguyên.`);
    } catch (error) {
        console.error("[Docker] Lỗi khi xử lý kết quả kiểm tra:", error);
    } finally {
        healthCheckRunning = false;
    }
}

// Khởi động kiểm tra tự động sau khi server bắt đầu (đảm bảo đã đăng nhập đủ)
let checkLoginInterval;

// Đảm bảo chỉ có một interval chạy
export function startLoginCheck() {
    // Xóa interval cũ nếu có
    if (checkLoginInterval) {
        clearInterval(checkLoginInterval);
    }
    
    console.log("[Docker] Khởi động hệ thống kiểm tra trạng thái đăng nhập tự động (10 phút/lần)");
    
    // Thiết lập kiểm tra định kỳ mỗi 10 phút
    checkLoginInterval = setInterval(() => {
        try {
            void checkLoginStatus().catch((error) => {
                console.error('[Docker] Health-check async error:', error);
            });
        } catch (error) {
            console.error("[Docker] Lỗi khi chạy kiểm tra đăng nhập:", error);
        }
    }, 10 * 60 * 1000);
    
    // Thêm xử lý khi process kết thúc để dọn dẹp
    process.on('SIGTERM', () => {
        console.log("[Docker] Nhận tín hiệu kết thúc, dừng kiểm tra đăng nhập");
        if (checkLoginInterval) {
            clearInterval(checkLoginInterval);
        }
    });
}

// Alias export cho tương thích với app.js
export const startLoginStatusCheck = startLoginCheck;

// Chờ server khởi động hoàn tất trước khi bắt đầu kiểm tra
setTimeout(() => {
    try {
        // Kiểm tra ngay lần đầu
        checkLoginStatus();
        
        // Bắt đầu kiểm tra định kỳ
        startLoginCheck();
    } catch (error) {
        console.error("[Docker] Lỗi khi khởi động hệ thống kiểm tra:", error);
    }
}, 120 * 1000); // Đợi 2 phút sau khi khởi động để đảm bảo tất cả tài khoản đã được khôi phục và container ổn định

// API để lấy danh sách tài khoản đã đăng nhập
export async function getLoggedAccounts(req, res) {
    try {
        const accounts = zaloAccounts.map(acc => ({
            ownId: acc.ownId,
            phoneNumber: acc.phoneNumber,
            proxy: acc.proxy || 'Không có proxy',
            displayName: `${acc.phoneNumber} (${acc.ownId})`,
            isOnline: acc.api ? true : false
        }));

        res.json({
            success: true,
            data: accounts,
            total: accounts.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API để lấy thông tin chi tiết một tài khoản
export async function getAccountDetails(req, res) {
    try {
        const { ownId } = req.params;
        const account = zaloAccounts.find(acc => acc.ownId === ownId);

        if (!account) {
            return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
        }

        // Lấy thông tin profile từ API
        const accountInfo = await account.api.fetchAccountInfo();

        res.json({
            success: true,
            data: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber,
                proxy: account.proxy || 'Không có proxy',
                profile: accountInfo?.profile || {},
                isOnline: account.api ? true : false
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== N8N-FRIENDLY WRAPPER APIs =====
// Các API này sử dụng account selection thay vì ownId

// Middleware để xử lý account selection
function getAccountFromSelection(accountSelection) {
    if (accountSelection === undefined || accountSelection === null || accountSelection === '') {
        throw new Error('Vui lòng chọn tài khoản');
    }

    // Hỗ trợ cả ownId và phoneNumber. Luôn so sánh dưới dạng text vì ownId
    // có thể lớn hơn Number.MAX_SAFE_INTEGER và không được phép đi qua Number.
    const selection = String(accountSelection).trim();
    let account = zaloAccounts.find(acc => String(acc.ownId) === selection);
    if (!account) {
        account = zaloAccounts.find(acc => String(acc.phoneNumber) === selection);
    }

    if (!account) {
        throw new Error(`Không tìm thấy tài khoản: ${selection}`);
    }

    return account;
}

function normalizeAvatarSize(value, fallback = AvatarSize.Small) {
    if (value === undefined || value === null || value === '') return fallback;

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'small') return AvatarSize.Small;
        if (normalized === 'large') return AvatarSize.Large;
    }

    const numeric = Number(value);
    if (numeric === AvatarSize.Small || numeric == 120) return AvatarSize.Small;
    if (numeric === AvatarSize.Large || numeric == 240) return AvatarSize.Large;

    throw new Error('avatarSize không hợp lệ. Dùng small/120 hoặc large/240');
}

function normalizeCount(value, fallback, min = 1, max = 20000, fieldName = 'count') {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${fieldName} phải là số nguyên từ ${min} đến ${max}`);
    }
    return parsed;
}

function sendAccountResult(res, account, data, extra = {}) {
    return res.json({
        success: true,
        data,
        ...extra,
        usedAccount: {
            ownId: account.ownId,
            phoneNumber: account.phoneNumber
        }
    });
}

function normalizeStringOrArray(value, fieldName) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`${fieldName} là bắt buộc`);
    }
    if (Array.isArray(value)) {
        const normalized = value.map((item) => String(item).trim()).filter(Boolean);
        if (normalized.length === 0) throw new Error(`${fieldName} không được là mảng rỗng`);
        return normalized;
    }
    const normalized = String(value).trim();
    if (!normalized) throw new Error(`${fieldName} là bắt buộc`);
    return normalized;
}

function normalizeFiniteNumber(value, fieldName) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`${fieldName} là bắt buộc và phải là số`);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`${fieldName} phải là số hợp lệ`);
    return numeric;
}

function isValidIsoDate(value) {
    const text = String(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const UPDATE_SETTINGS_ALLOWED_VALUES = new Map([
    [UpdateSettingsType.ViewBirthday, new Set([0, 1, 2])],
    [UpdateSettingsType.ShowOnlineStatus, new Set([0, 1])],
    [UpdateSettingsType.DisplaySeenStatus, new Set([0, 1])],
    [UpdateSettingsType.ReceiveMessage, new Set([1, 2])],
    [UpdateSettingsType.AcceptCall, new Set([2, 3, 4])],
    [UpdateSettingsType.AddFriendViaPhone, new Set([0, 1])],
    [UpdateSettingsType.AddFriendViaQR, new Set([0, 1])],
    [UpdateSettingsType.AddFriendViaGroup, new Set([0, 1])],
    [UpdateSettingsType.AddFriendViaContact, new Set([0, 1])],
    [UpdateSettingsType.DisplayOnRecommendFriend, new Set([0, 1])],
    [UpdateSettingsType.ArchivedChat, new Set([0, 1])],
    [UpdateSettingsType.QuickMessage, new Set([0, 1])]
]);

// API tìm user với account selection
export async function findUserByAccount(req, res) {
    try {
        const { phone, avatarSize, accountSelection } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'Số điện thoại là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Large);
        const userData = await account.api.findUser(String(phone), size);
        return sendAccountResult(res, account, userData);
    } catch (error) {
        const status = /avatarSize/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function findUserByUsernameByAccount(req, res) {
    try {
        const { username, avatarSize, accountSelection } = req.body;
        if (!username) {
            return res.status(400).json({ error: 'username là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Large);
        const result = await account.api.findUserByUsername(String(username), size);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /avatarSize/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getAvatarUrlProfileByAccount(req, res) {
    try {
        const { friendIds, avatarSize, accountSelection } = req.body;
        if (!friendIds || (Array.isArray(friendIds) && friendIds.length === 0)) {
            return res.status(400).json({ error: 'friendIds là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Large);
        const result = await account.api.getAvatarUrlProfile(normalizeStringOrArray(friendIds, 'friendIds'), size);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /avatarSize|friendIds|bắt buộc|mảng rỗng/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getCloseFriendsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getCloseFriends();
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getFullAvatarByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getFullAvatar(String(friendId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getMultiUsersByPhonesByAccount(req, res) {
    try {
        const { phoneNumbers, avatarSize, accountSelection } = req.body;
        if (!phoneNumbers || (Array.isArray(phoneNumbers) && phoneNumbers.length === 0)) {
            return res.status(400).json({ error: 'phoneNumbers là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Large);
        const result = await account.api.getMultiUsersByPhones(phoneNumbers, size);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /avatarSize/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

// API gửi tin nhắn với account selection
export async function sendMessageByAccount(req, res) {
    try {
        const { message, threadId, type, accountSelection, quote } = req.body;

        if (!message || !threadId) {
            return res.status(400).json({ error: 'Tin nhắn và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const msgType = normalizeThreadType(type, ThreadType);
        const requestedTtl = getRequestedMessageTtl(req.body, message);

        // zca-js 2.1.2 accepts ttl directly on MessageContent. Keep message TTL
        // separate from conversation-wide Auto Delete (updateAutoDeleteChat).
        let messageContent = withMessageTtl(message, requestedTtl);
        if (quote) {
            if (typeof messageContent === 'string') {
                messageContent = {
                    msg: messageContent,
                    quote
                };
            } else if (typeof messageContent === 'object') {
                messageContent = {
                    ...messageContent,
                    quote
                };
            }
        }

        const result = await account.api.sendMessage(messageContent, String(threadId), msgType);

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(requestedTtl),
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImageByAccount(req, res) {
    let imagePath;
    try {
        const { imagePath: imageUrl, threadId, type, accountSelection, ttl, message } = req.body;

        if (!imageUrl || !threadId) {
            return res.status(400).json({ error: 'Đường dẫn hình ảnh và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);

        imagePath = await saveImage(imageUrl);
        if (!imagePath) {
            return res.status(500).json({ success: false, error: 'Không thể lưu hình ảnh' });
        }

        const result = await account.api.sendMessage(
            withMessageTtl({
                msg: message || '',
                attachments: [imagePath]
            }, normalizedMessageTtl),
            String(threadId),
            threadType
        );

        removeImage(imagePath);
        imagePath = null;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        if (imagePath) removeImage(imagePath);
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getUserInfoByAccount(req, res) {
    try {
        const { userId, avatarSize, accountSelection } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'UserId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Small);
        const info = await account.api.getUserInfo(userId, size);
        return sendAccountResult(res, account, info);
    } catch (error) {
        const status = /avatarSize/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

// API gửi lời mời kết bạn với account selection
export async function sendFriendRequestByAccount(req, res) {
    try {
        const { userId, message, accountSelection } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'UserId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const friendMessage = message || 'Xin chào, hãy kết bạn với tôi!';
        const result = await account.api.sendFriendRequest(friendMessage, userId);

        res.json({
            success: true,
            data: result,
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API tạo nhóm với account selection
export async function createGroupByAccount(req, res) {
    try {
        const { members, name, avatarPath, accountSelection } = req.body;

        if (!members || !Array.isArray(members) || members.length === 0) {
            return res.status(400).json({ error: 'Danh sách thành viên là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.createGroup({ members, name, avatarPath });

        res.json({
            success: true,
            data: result,
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API lấy thông tin nhóm với account selection
export async function getGroupInfoByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;

        if (!groupId || (Array.isArray(groupId) && groupId.length === 0)) {
            return res.status(400).json({ error: 'GroupId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupInfo(groupId);

        res.json({
            success: true,
            data: result,
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API thêm thành viên vào nhóm với account selection
export async function addUserToGroupByAccount(req, res) {
    try {
        const { groupId, memberId, accountSelection } = req.body;

        if (!groupId || !memberId || (Array.isArray(memberId) && memberId.length === 0)) {
            return res.status(400).json({ error: 'GroupId và memberId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.addUserToGroup(memberId, groupId);

        res.json({
            success: true,
            data: result,
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API xóa thành viên khỏi nhóm với account selection
export async function removeUserFromGroupByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;

        if (!groupId || !memberId || (Array.isArray(memberId) && memberId.length === 0)) {
            return res.status(400).json({ error: 'GroupId và memberId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.removeUserFromGroup(memberId, groupId);

        res.json({
            success: true,
            data: result,
            usedAccount: {
                ownId: account.ownId,
                phoneNumber: account.phoneNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// API gửi hình ảnh đến user với account selection
export async function sendImageToUserByAccount(req, res) {
    let imagePath;
    try {
        const { imagePath: imageUrl, threadId, accountSelection, ttl } = req.body;

        if (!imageUrl || !threadId) {
            return res.status(400).json({ error: 'Đường dẫn hình ảnh và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        imagePath = await saveImage(imageUrl);

        if (!imagePath) {
            return res.status(500).json({ success: false, error: 'Không thể lưu hình ảnh' });
        }

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: [imagePath] }, normalizedMessageTtl),
            String(threadId),
            ThreadType.User
        );

        removeImage(imagePath);
        imagePath = null;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        if (imagePath) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImagesToUserByAccount(req, res) {
    const imagePaths = [];
    try {
        const { imagePaths: imageUrls, threadId, accountSelection, ttl } = req.body;

        if (!imageUrls || !threadId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            return res.status(400).json({ error: 'Danh sách hình ảnh và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);

        const downloadedImages = await saveImages(imageUrls);
        if (downloadedImages.some((imagePath) => !imagePath)) {
            for (const savedPath of downloadedImages.filter(Boolean)) removeImage(savedPath);
            return res.status(500).json({ success: false, error: 'Không thể lưu một hoặc nhiều hình ảnh' });
        }
        imagePaths.push(...downloadedImages);

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: imagePaths }, normalizedMessageTtl),
            String(threadId),
            ThreadType.User
        );

        for (const imagePath of imagePaths) removeImage(imagePath);
        imagePaths.length = 0;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        for (const imagePath of imagePaths) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImageToGroupByAccount(req, res) {
    let imagePath;
    try {
        const { imagePath: imageUrl, threadId, accountSelection, ttl } = req.body;

        if (!imageUrl || !threadId) {
            return res.status(400).json({ error: 'Đường dẫn hình ảnh và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        imagePath = await saveImage(imageUrl);

        if (!imagePath) {
            return res.status(500).json({ success: false, error: 'Không thể lưu hình ảnh' });
        }

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: [imagePath] }, normalizedMessageTtl),
            String(threadId),
            ThreadType.Group
        );

        removeImage(imagePath);
        imagePath = null;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        if (imagePath) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImagesToGroupByAccount(req, res) {
    const imagePaths = [];
    try {
        const { imagePaths: imageUrls, threadId, accountSelection, ttl } = req.body;

        if (!imageUrls || !threadId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            return res.status(400).json({ error: 'Danh sách hình ảnh và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);

        const downloadedImages = await saveImages(imageUrls);
        if (downloadedImages.some((imagePath) => !imagePath)) {
            for (const savedPath of downloadedImages.filter(Boolean)) removeImage(savedPath);
            return res.status(500).json({ success: false, error: 'Không thể lưu một hoặc nhiều hình ảnh' });
        }
        imagePaths.push(...downloadedImages);

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: imagePaths }, normalizedMessageTtl),
            String(threadId),
            ThreadType.Group
        );

        for (const imagePath of imagePaths) removeImage(imagePath);
        imagePaths.length = 0;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        for (const imagePath of imagePaths) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendFileByAccount(req, res) {
    let filePath;
    try {
        const { fileUrl, threadId, type, accountSelection, message, ttl } = req.body;

        if (!fileUrl || !threadId) {
            return res.status(400).json({ error: 'URL của file và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        filePath = await saveFileFromUrl(fileUrl);

        if (!filePath) {
            return res.status(500).json({ success: false, error: 'Không thể tải và lưu file' });
        }

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: message || '', attachments: [filePath] }, normalizedMessageTtl),
            String(threadId),
            threadType
        );

        removeFile(filePath);
        filePath = null;

        res.json({
            success: true,
            data: result,
            messageTtl: messageTtlResult(normalizedMessageTtl),
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        if (filePath) removeFile(filePath);
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function acceptFriendRequestByAccount(req, res) {
    try {
        const { userId, accountSelection } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.acceptFriendRequest(userId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function blockUserByAccount(req, res) {
    try {
        const { userId, accountSelection } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.blockUser(userId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function unblockUserByAccount(req, res) {
    try {
        const { userId, accountSelection } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.unblockUser(userId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function blockViewFeedByAccount(req, res) {
    try {
        const { isBlockFeed, userId, accountSelection } = req.body;
        if (typeof isBlockFeed !== 'boolean' || !userId) {
            return res.status(400).json({ error: 'isBlockFeed (boolean) và userId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.blockViewFeed(isBlockFeed, userId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function changeFriendAliasByAccount(req, res) {
    try {
        const { alias, friendId, accountSelection } = req.body;
        if (!friendId) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.changeFriendAlias(alias, friendId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeFriendAliasByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.removeFriendAlias(friendId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getAllFriendsByAccount(req, res) {
    try {
        const { count, page, avatarSize, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const normalizedCount = normalizeCount(count, 20000, 1, 20000, 'count');
        const normalizedPage = normalizeCount(page, 1, 1, 1000000, 'page');
        const size = normalizeAvatarSize(avatarSize, AvatarSize.Small);
        const result = await account.api.getAllFriends(normalizedCount, normalizedPage, size);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /avatarSize|count|page/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getAliasListByAccount(req, res) {
    try {
        const { count, page, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getAliasList(count, page);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getFriendRecommendationsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        // API đã được đổi tên trong thư viện mới
        const result = await account.api.getFriendRecommendations();
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getReceivedFriendRequestsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getFriendRecommendations();

        const recommItems = Array.isArray(result?.recommItems) ? result.recommItems : [];
        const receivedItems = recommItems.filter((item) => {
            const recommType = item?.dataInfo?.recommType ?? item?.recommType;
            return Number(recommType) === 2;
        });

        res.json({
            success: true,
            data: {
                ...result,
                recommItems: receivedItems,
                total: receivedItems.length
            },
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function rejectFriendRequestByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) return res.status(400).json({ error: 'friendId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.rejectFriendRequest(String(friendId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getFriendOnlinesByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getFriendOnlines();
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getFriendRequestStatusByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) return res.status(400).json({ error: 'friendId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getFriendRequestStatus(String(friendId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

const GROUP_HISTORY_COMPAT_METHOD = '__zaloBotGetGroupChatHistoryRecentV2';
const groupHistoryOfficialUnavailable = new WeakSet();

function registerGroupHistoryCompatMethod(api) {
    if (typeof api?.[GROUP_HISTORY_COMPAT_METHOD] === 'function') return;
    if (typeof api?.custom !== 'function') {
        throw new Error('zca-js không hỗ trợ custom API cần thiết cho history compatibility');
    }

    // Compatibility fallback based on the upstream zca-js PR that replaces the
    // removed /api/group/history endpoint with group_cloud_message/getrecentv2.
    // Keep this local and secondary so a future official zca-js release remains
    // the source of truth without mutating files inside node_modules.
    api.custom(GROUP_HISTORY_COMPAT_METHOD, async ({ ctx, utils, props }) => {
        const requestedCount = normalizeCount(props?.count, 50, 1, 200, 'count');
        let cleanGroupId = String(props?.groupId || '').trim();
        if (!cleanGroupId) throw new Error('groupId là bắt buộc');
        if (cleanGroupId.startsWith('g')) cleanGroupId = cleanGroupId.slice(1);

        const serviceBase = ctx?.zpwServiceMap?.group_cloud_message?.[0];
        if (!serviceBase) {
            throw new Error('Zalo session không cung cấp group_cloud_message service');
        }

        const serviceURL = utils.makeURL(`${serviceBase}/api/cm/getrecentv2`);
        const rawMessages = [];
        const seenMessageIds = new Set();
        let cursor = 0;
        let lastPage = null;

        while (rawMessages.length < requestedCount) {
            const params = {
                groupId: cleanGroupId,
                globalMsgId: cursor,
                count: Math.min(50, requestedCount - rawMessages.length),
                msgIds: [],
                imei: ctx.imei,
                src: 3
            };
            const encryptedParams = utils.encodeAES(JSON.stringify(params));
            if (!encryptedParams) throw new Error('Không thể mã hóa tham số history');

            const response = await utils.request(
                utils.makeURL(serviceURL, { params: encryptedParams, nretry: 0 }),
                { method: 'GET' }
            );

            lastPage = await utils.resolve(response, (result) => {
                let data = result?.data;
                if (typeof data === 'string') data = JSON.parse(data);
                return data || {};
            });

            const pageMessages = Array.isArray(lastPage?.groupMsgs) ? lastPage.groupMsgs : [];
            for (const message of pageMessages) {
                if (rawMessages.length >= requestedCount) break;
                const messageId = message?.msgId ?? message?.msgID;
                const dedupeKey = messageId === undefined || messageId === null ? null : String(messageId);
                if (dedupeKey && seenMessageIds.has(dedupeKey)) continue;
                if (dedupeKey) seenMessageIds.add(dedupeKey);
                rawMessages.push(message);
            }

            const nextCursor = Number(lastPage?.lastMsgId);
            if (!lastPage?.hasMore || !Number.isFinite(nextCursor) || nextCursor === 0 || nextCursor === cursor) break;
            cursor = nextCursor;
        }

        const groupMsgs = rawMessages.map((message) => new GroupMessage(ctx.uid, message));
        return {
            ...(lastPage || {}),
            groupMsgs
        };
    });
}

async function getGroupChatHistoryCompat(api, groupId, count) {
    registerGroupHistoryCompatMethod(api);
    return api[GROUP_HISTORY_COMPAT_METHOD]({ groupId, count });
}

export async function getGroupChatHistoryByAccount(req, res) {
    try {
        const { groupId, count = 50, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ success: false, error: 'groupId là bắt buộc' });
        }

        const parsedCount = normalizeCount(count, 50, 1, 200, 'count');
        const account = getAccountFromSelection(accountSelection);

        let upstreamError = null;
        if (!groupHistoryOfficialUnavailable.has(account.api)) {
            try {
                const result = await account.api.getGroupChatHistory(String(groupId), parsedCount);
                return sendAccountResult(res, account, result, { source: 'zca-js-2.1.2' });
            } catch (error) {
                upstreamError = error;
                if (/404|not found/i.test(String(error?.message || ''))) {
                    groupHistoryOfficialUnavailable.add(account.api);
                }
                console.warn(`[History] zca-js getGroupChatHistory lỗi cho group ${groupId}: ${error.message}. Thử getrecentv2 compatibility.`);
            }
        }

        try {
            const result = await getGroupChatHistoryCompat(account.api, String(groupId), parsedCount);
            return sendAccountResult(res, account, result, {
                source: 'zca-js-getrecentv2-compat',
                ...(upstreamError ? { warning: `API history trong zca-js 2.1.2 không dùng được (${upstreamError.message}); đã dùng endpoint getrecentv2 tương thích.` } : {})
            });
        } catch (compatError) {
            console.warn(`[History] getrecentv2 compatibility lỗi cho group ${groupId}: ${compatError.message}. Fallback local cache.`);
            const cached = getCachedGroupHistory(account.ownId, groupId, parsedCount);
            return sendAccountResult(res, account, cached, {
                source: 'local-cache',
                warning: `Không lấy được history trực tiếp từ Zalo (${compatError.message}). Đang trả dữ liệu cache listener local.`
            });
        }
    } catch (error) {
        const status = /count/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getSentFriendRequestByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getSentFriendRequest();
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function undoFriendRequestByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.undoFriendRequest(friendId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeFriendByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.removeFriend(friendId);
        res.json({
            success: true,
            data: result,
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW GROUP MANAGEMENT APIs =====

export async function addGroupDeputyByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) {
            return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.addGroupDeputy(memberId, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeGroupDeputyByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) {
            return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.removeGroupDeputy(memberId, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function changeGroupAvatarByAccount(req, res) {
    try {
        const { avatarSource, groupId, accountSelection } = req.body;
        if (!avatarSource || !groupId) {
            return res.status(400).json({ error: 'avatarSource và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.changeGroupAvatar(avatarSource, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function changeGroupNameByAccount(req, res) {
    try {
        const { name, groupId, accountSelection } = req.body;
        if (!name || !groupId) {
            return res.status(400).json({ error: 'name và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.changeGroupName(name, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function changeGroupOwnerByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) {
            return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.changeGroupOwner(memberId, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function disperseGroupByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.disperseGroup(groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function enableGroupLinkByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.enableGroupLink(groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function disableGroupLinkByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.disableGroupLink(groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getAllGroupsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getAllGroups();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupLinkInfoByAccount(req, res) {
    try {
        const { link, accountSelection } = req.body;
        if (!link) {
            return res.status(400).json({ error: 'link là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupLinkInfo(link);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupMembersInfoByAccount(req, res) {
    try {
        const { memberId, accountSelection } = req.body;
        if (!memberId) {
            return res.status(400).json({ error: 'memberId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupMembersInfo(memberId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function inviteUserToGroupsByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) {
            return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.inviteUserToGroups(memberId, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function joinGroupByAccount(req, res) {
    try {
        const { link, accountSelection } = req.body;
        if (!link) {
            return res.status(400).json({ error: 'link là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.joinGroupLink(String(link));
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function leaveGroupByAccount(req, res) {
    try {
        const { groupId, silent, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        // API leaveGroup đã thay đổi: chỉ chấp nhận một chuỗi duy nhất làm tham số đầu tiên
        // Cũ: leaveGroup(groupId, silent)
        // Mới: leaveGroup(groupId)
        const result = await account.api.leaveGroup(groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateGroupSettingsByAccount(req, res) {
    try {
        const { options, groupId, accountSelection } = req.body;
        if (!options || !groupId) {
            return res.status(400).json({ error: 'options và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateGroupSettings(options, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupLinkDetailByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupLinkDetail(String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupInviteBoxListByAccount(req, res) {
    try {
        const { options, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupInviteBoxList(options);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupInviteBoxInfoByAccount(req, res) {
    try {
        const { groupId, mpage, mcount, accountSelection } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const payload = { groupId: String(groupId) };
        if (mpage !== undefined) payload.mpage = normalizeCount(mpage, 1, 1, 1000000, 'mpage');
        if (mcount !== undefined) payload.mcount = normalizeCount(mcount, 10, 1, 200, 'mcount');
        const result = await account.api.getGroupInviteBoxInfo(payload);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /mpage|mcount/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function joinGroupInviteBoxByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.joinGroupInviteBox(String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function deleteGroupInviteBoxByAccount(req, res) {
    try {
        const { groupId, blockFutureInvite = false, accountSelection } = req.body;
        if (!groupId || (Array.isArray(groupId) && groupId.length === 0)) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        if (typeof blockFutureInvite !== 'boolean') {
            return res.status(400).json({ error: 'blockFutureInvite phải là boolean' });
        }
        const account = getAccountFromSelection(accountSelection);
        const ids = Array.isArray(groupId) ? groupId.map(String) : String(groupId);
        const result = await account.api.deleteGroupInviteBox(ids, blockFutureInvite);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupBlockedMemberByAccount(req, res) {
    try {
        const { groupId, page = 1, count = 50, accountSelection } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId là bắt buộc' });
        const payload = {
            page: normalizeCount(page, 1, 1, 1000000, 'page'),
            count: normalizeCount(count, 50, 1, 200, 'count')
        };
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getGroupBlockedMember(payload, String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /page|count/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function addGroupBlockedMemberByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const ids = normalizeStringOrArray(memberId, 'memberId');
        const result = await account.api.addGroupBlockedMember(ids, String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /memberId|bắt buộc|mảng rỗng/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function removeGroupBlockedMemberByAccount(req, res) {
    try {
        const { memberId, groupId, accountSelection } = req.body;
        if (!memberId || !groupId) return res.status(400).json({ error: 'memberId và groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const ids = normalizeStringOrArray(memberId, 'memberId');
        const result = await account.api.removeGroupBlockedMember(ids, String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /memberId|bắt buộc|mảng rỗng/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getPendingGroupMembersByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getPendingGroupMembers(String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function reviewPendingMemberRequestByAccount(req, res) {
    try {
        const { members, isApprove, groupId, accountSelection } = req.body;
        if (!members || !groupId) return res.status(400).json({ error: 'members và groupId là bắt buộc' });
        if (typeof isApprove !== 'boolean') return res.status(400).json({ error: 'isApprove phải là boolean' });
        const account = getAccountFromSelection(accountSelection);
        const normalizedMembers = normalizeStringOrArray(members, 'members');
        const result = await account.api.reviewPendingMemberRequest({ members: normalizedMembers, isApprove }, String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /members|bắt buộc|mảng rỗng|isApprove/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getRelatedFriendGroupByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId || (Array.isArray(friendId) && friendId.length === 0)) {
            return res.status(400).json({ error: 'friendId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const ids = normalizeStringOrArray(friendId, 'friendId');
        const result = await account.api.getRelatedFriendGroup(ids);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW MESSAGE INTERACTION APIs =====

export async function addReactionByAccount(req, res) {
    try {
        const { icon, dest, accountSelection } = req.body;
        if (!icon || !dest) {
            return res.status(400).json({ error: 'icon và dest là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.addReaction(icon, dest);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function deleteMessageByAccount(req, res) {
    try {
        const { dest, onlyMe, accountSelection } = req.body;
        if (!dest) {
            return res.status(400).json({ error: 'dest là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.deleteMessage(dest, onlyMe);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function forwardMessageByAccount(req, res) {
    try {
        const { params, type, threadIds, accountSelection } = req.body;
        if (!params) {
            return res.status(400).json({ error: 'params là bắt buộc' });
        }
        if (!threadIds) {
            return res.status(400).json({ error: 'threadIds là bắt buộc trong phiên bản mới' });
        }
        const account = getAccountFromSelection(accountSelection);
        // API đã thay đổi: forwardMessage(payload, threadIds, type)
        const threadType = normalizeThreadType(type, ThreadType);
        const ids = Array.isArray(threadIds) ? threadIds.map(String) : [String(threadIds)];
        const result = await account.api.forwardMessage(params, ids, threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function parseLinkByAccount(req, res) {
    try {
        const { link, accountSelection } = req.body;
        if (!link) {
            return res.status(400).json({ error: 'link là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.parseLink(link);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendCardByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendCard(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendLinkByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendLink(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendStickerByAccount(req, res) {
    try {
        const { sticker, threadId, type, accountSelection } = req.body;
        if (!sticker || !threadId) {
            return res.status(400).json({ error: 'sticker và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendSticker(sticker, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getStickersByAccount(req, res) {
    try {
        const { query, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getStickers(query);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getStickersDetailByAccount(req, res) {
    try {
        const { stickerAlbum, accountSelection } = req.body;
        if (!stickerAlbum) {
            return res.status(400).json({ error: 'stickerAlbum là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getStickersDetail(stickerAlbum);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendVideoByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedOptions = { ...options };
        if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'ttl')) {
            normalizedOptions.ttl = normalizeMessageTtl(normalizedOptions.ttl) ?? 0;
        }
        const result = await account.api.sendVideo(normalizedOptions, String(threadId), threadType);
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedOptions.ttl), usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendVoiceByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedOptions = { ...options };
        if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'ttl')) {
            normalizedOptions.ttl = normalizeMessageTtl(normalizedOptions.ttl) ?? 0;
        }
        const result = await account.api.sendVoice(normalizedOptions, String(threadId), threadType);
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedOptions.ttl), usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function undoByAccount(req, res) {
    try {
        const { payload, threadId, type, accountSelection } = req.body;
        if (!payload || !threadId) {
            return res.status(400).json({ error: 'payload và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.undo(payload, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendDeliveredEventByAccount(req, res) {
    try {
        const { isSeen, messages, type, accountSelection } = req.body;
        if (typeof isSeen !== 'boolean' || !messages) {
            return res.status(400).json({ error: 'isSeen và messages là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendDeliveredEvent(isSeen, messages, threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendSeenEventByAccount(req, res) {
    try {
        const { messages, type, accountSelection } = req.body;
        if (!messages) {
            return res.status(400).json({ error: 'messages là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendSeenEvent(messages, threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendTypingEventByAccount(req, res) {
    try {
        const { threadId, type, destType = DestType.User, accountSelection } = req.body;
        if (!threadId) {
            return res.status(400).json({ error: 'threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedDestType = Number(destType);
        if (threadType === ThreadType.User && ![DestType.User, DestType.Page].includes(normalizedDestType)) {
            return res.status(400).json({ error: 'destType cho user thread phải là 3 (User) hoặc 5 (Page)' });
        }
        const result = await account.api.sendTypingEvent(String(threadId), threadType, normalizedDestType);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /type không hợp lệ|destType/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

// ===== NEW BOARD & NOTES APIs =====

export async function createNoteByAccount(req, res) {
    try {
        const { options, groupId, accountSelection } = req.body;
        if (!options || !groupId) {
            return res.status(400).json({ error: 'options và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        // API đã đổi tên: createNoteGroup -> createNote
        const result = await account.api.createNote(options, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function editNoteByAccount(req, res) {
    try {
        const { options, groupId, accountSelection } = req.body;
        if (!options || !groupId) {
            return res.status(400).json({ error: 'options và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        // API đã đổi tên: editNoteGroup -> editNote
        const result = await account.api.editNote(options, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getFriendBoardListByAccount(req, res) {
    try {
        const { conversationId, accountSelection } = req.body;
        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getFriendBoardList(conversationId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getListBoardByAccount(req, res) {
    try {
        const { options, groupId, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getListBoard(options, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW POLLS APIs =====

export async function createPollByAccount(req, res) {
    try {
        const { options, groupId, accountSelection } = req.body;
        if (!options || !groupId) {
            return res.status(400).json({ error: 'options và groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.createPoll(options, groupId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getPollDetailByAccount(req, res) {
    try {
        const { pollId, accountSelection } = req.body;
        const numericPollId = normalizeFiniteNumber(pollId, 'pollId');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getPollDetail(numericPollId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /pollId|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        return res.status(status).json({ success: false, error: error.message });
    }
}

export async function lockPollByAccount(req, res) {
    try {
        const { pollId, accountSelection } = req.body;
        const numericPollId = normalizeFiniteNumber(pollId, 'pollId');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.lockPoll(numericPollId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /pollId|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        return res.status(status).json({ success: false, error: error.message });
    }
}

export async function addPollOptionsByAccount(req, res) {
    try {
        const { payload, accountSelection } = req.body;
        if (!payload || payload.pollId === undefined || !Array.isArray(payload.options)) {
            return res.status(400).json({ error: 'payload.pollId và payload.options là bắt buộc' });
        }
        if (payload.options.length === 0 || payload.options.some((option) => !option || typeof option.content !== 'string' || typeof option.voted !== 'boolean')) {
            return res.status(400).json({ error: 'payload.options phải chứa các phần tử { content: string, voted: boolean }' });
        }
        const normalizedPayload = {
            ...payload,
            pollId: normalizeFiniteNumber(payload.pollId, 'payload.pollId'),
            votedOptionIds: Array.isArray(payload.votedOptionIds) ? payload.votedOptionIds.map((id) => normalizeFiniteNumber(id, 'payload.votedOptionIds')) : []
        };
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.addPollOptions(normalizedPayload);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /payload|pollId|options|votedOptionIds|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sharePollByAccount(req, res) {
    try {
        const { pollId, accountSelection } = req.body;
        const numericPollId = normalizeFiniteNumber(pollId, 'pollId');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.sharePoll(numericPollId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /pollId|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function votePollByAccount(req, res) {
    try {
        const { pollId, optionId, accountSelection } = req.body;
        const numericPollId = normalizeFiniteNumber(pollId, 'pollId');
        if (optionId === undefined || optionId === null) return res.status(400).json({ error: 'optionId là bắt buộc; dùng [] để bỏ phiếu' });
        const normalizedOptionId = Array.isArray(optionId)
            ? optionId.map((id) => normalizeFiniteNumber(id, 'optionId'))
            : normalizeFiniteNumber(optionId, 'optionId');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.votePoll(numericPollId, normalizedOptionId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /pollId|optionId|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

// ===== NEW REMINDERS APIs =====

export async function createReminderByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.createReminder(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function editReminderByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.editReminder(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeReminderByAccount(req, res) {
    try {
        const { reminderId, threadId, type, accountSelection } = req.body;
        if (!reminderId || !threadId) {
            return res.status(400).json({ error: 'reminderId và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.removeReminder(reminderId, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getReminderByAccount(req, res) {
    try {
        const { reminderId, accountSelection } = req.body;
        if (!reminderId) {
            return res.status(400).json({ error: 'reminderId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getReminder(reminderId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getListReminderByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!threadId) {
            return res.status(400).json({ error: 'threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.getListReminder(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getReminderResponsesByAccount(req, res) {
    try {
        const { reminderId, accountSelection } = req.body;
        if (!reminderId) {
            return res.status(400).json({ error: 'reminderId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getReminderResponses(reminderId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}


// ===== ZCA-JS 2.1.x APIs =====

export async function searchStickerByAccount(req, res) {
    try {
        const { keyword, limit = 50, accountSelection } = req.body;
        if (!keyword) {
            return res.status(400).json({ error: 'keyword là bắt buộc' });
        }
        const normalizedLimit = normalizeCount(limit, 50, 1, 200, 'limit');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.searchSticker(String(keyword), normalizedLimit);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /limit/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getStickerCategoryDetailByAccount(req, res) {
    try {
        const { cateId, accountSelection } = req.body;
        const numericCateId = Number(cateId);
        if (!Number.isInteger(numericCateId) || numericCateId < 0) {
            return res.status(400).json({ error: 'cateId phải là số nguyên không âm' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getStickerCategoryDetail(numericCateId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateArchivedChatListByAccount(req, res) {
    try {
        const { isArchived, conversations, accountSelection } = req.body;
        if (typeof isArchived !== 'boolean') {
            return res.status(400).json({ error: 'isArchived phải là boolean' });
        }
        if (!conversations || (Array.isArray(conversations) && conversations.length === 0)) {
            return res.status(400).json({ error: 'conversations là bắt buộc' });
        }
        const normalized = (Array.isArray(conversations) ? conversations : [conversations]).map((item) => {
            if (!item || item.id === undefined || item.type === undefined) {
                throw new Error('Mỗi conversation phải có id và type');
            }
            return {
                ...item,
                id: String(item.id),
                type: normalizeThreadType(item.type, ThreadType)
            };
        });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateArchivedChatList(isArchived, normalized);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /conversation|type không hợp lệ|isArchived/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function upgradeGroupToCommunityByAccount(req, res) {
    try {
        const { groupId, accountSelection } = req.body;
        if (!groupId) {
            return res.status(400).json({ error: 'groupId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.upgradeGroupToCommunity(String(groupId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW QUICK MESSAGES APIs =====

export async function addQuickMessageByAccount(req, res) {
    try {
        const { addPayload, accountSelection } = req.body;
        if (!addPayload) {
            return res.status(400).json({ error: 'addPayload là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.addQuickMessage(addPayload);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getQuickMessageListByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        // API đã đổi tên: getQuickMessage -> getQuickMessageList
        const result = await account.api.getQuickMessageList();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeQuickMessageByAccount(req, res) {
    try {
        const { itemIds, accountSelection } = req.body;
        if (itemIds === undefined || itemIds === null || itemIds === '') {
            return res.status(400).json({ error: 'itemIds là bắt buộc' });
        }
        const normalizedItemIds = Array.isArray(itemIds)
            ? itemIds.map((id) => normalizeFiniteNumber(id, 'itemIds'))
            : normalizeFiniteNumber(itemIds, 'itemIds');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.removeQuickMessage(normalizedItemIds);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /itemIds|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        return res.status(status).json({ success: false, error: error.message });
    }
}

export async function updateQuickMessageByAccount(req, res) {
    try {
        const { updatePayload, itemId, accountSelection } = req.body;
        if (!updatePayload) {
            return res.status(400).json({ error: 'updatePayload là bắt buộc' });
        }
        const numericItemId = normalizeFiniteNumber(itemId, 'itemId');
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateQuickMessage(updatePayload, numericItemId);
        return sendAccountResult(res, account, result);
    } catch (error) {
        const status = /itemId|updatePayload|bắt buộc|phải là số/i.test(error.message) ? 400 : 500;
        return res.status(status).json({ success: false, error: error.message });
    }
}

// ===== NEW LABELS APIs =====

export async function getLabelsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getLabels();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateLabelsByAccount(req, res) {
    try {
        const { label, accountSelection } = req.body;
        if (!label) {
            return res.status(400).json({ error: 'label là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateLabels(label);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW CONVERSATION MANAGEMENT APIs =====

export async function addUnreadMarkByAccount(req, res) {
    try {
        const { threadId, type, accountSelection } = req.body;
        if (!threadId) {
            return res.status(400).json({ error: 'threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.addUnreadMark(String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeUnreadMarkByAccount(req, res) {
    try {
        const { threadId, type, accountSelection } = req.body;
        if (!threadId) {
            return res.status(400).json({ error: 'threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.removeUnreadMark(String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function deleteChatByAccount(req, res) {
    try {
        const { lastMessage, threadId, type, accountSelection } = req.body;
        if (!lastMessage || !threadId) {
            return res.status(400).json({ error: 'lastMessage và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.deleteChat(lastMessage, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getArchivedChatListByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getArchivedChatList();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getAutoDeleteChatByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getAutoDeleteChat();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateAutoDeleteChatByAccount(req, res) {
    try {
        const { ttl, threadId, type, accountSelection } = req.body;
        if (ttl === undefined || ttl === null || ttl === '' || !threadId) {
            return res.status(400).json({ error: 'ttl và threadId là bắt buộc' });
        }

        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedTtl = normalizeAutoDeleteTtl(ttl);
        const result = await account.api.updateAutoDeleteChat(normalizedTtl, String(threadId), threadType);

        res.json({
            success: true,
            data: result,
            autoDelete: {
                enabled: normalizedTtl !== 0,
                ttl: normalizedTtl,
                scope: 'conversation'
            },
            usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber }
        });
    } catch (error) {
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function getHiddenConversationsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getHiddenConversations();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function setHiddenConversationsByAccount(req, res) {
    try {
        const { hidden, threadId, type, accountSelection } = req.body;
        if (typeof hidden !== 'boolean' || !threadId) {
            return res.status(400).json({ error: 'hidden và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.setHiddenConversations(hidden, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateHiddenConversPinByAccount(req, res) {
    try {
        const { pin, accountSelection } = req.body;
        if (!pin) {
            return res.status(400).json({ error: 'pin là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateHiddenConversPin(pin);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function resetHiddenConversPinByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.resetHiddenConversPin();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getMuteByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getMute();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function setMuteByAccount(req, res) {
    try {
        const { params, threadID, type, accountSelection } = req.body;
        if (!params || !threadID) {
            return res.status(400).json({ error: 'params và threadID là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.setMute(params, String(threadID), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getPinConversationsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getPinConversations();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function setPinnedConversationsByAccount(req, res) {
    try {
        const { pinned, threadId, type, accountSelection } = req.body;
        if (typeof pinned !== 'boolean' || !threadId) {
            return res.status(400).json({ error: 'pinned và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.setPinnedConversations(pinned, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getUnreadMarkByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getUnreadMark();
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== NEW ACCOUNT PROFILE MANAGEMENT APIs =====

export async function changeAccountAvatarByAccount(req, res) {
    try {
        const { avatarSource, accountSelection } = req.body;
        if (!avatarSource) {
            return res.status(400).json({ error: 'avatarSource là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.changeAccountAvatar(avatarSource);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function deleteAvatarListByAccount(req, res) {
    try {
        const { photoId, accountSelection } = req.body;
        if (!photoId) {
            return res.status(400).json({ error: 'photoId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.deleteAvatar(photoId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getAvatarListByAccount(req, res) {
    try {
        const { count, page, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getAvatarList(count, page);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function reuseAvatarByAccount(req, res) {
    try {
        const { photoId, accountSelection } = req.body;
        if (!photoId) {
            return res.status(400).json({ error: 'photoId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.reuseAvatar(photoId);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateProfileByAccount(req, res) {
    try {
        const { name, dob, gender, biz, accountSelection } = req.body;
        if (name === undefined || dob === undefined || gender === undefined) {
            return res.status(400).json({ error: 'name, dob, và gender là bắt buộc' });
        }
        if (!isValidIsoDate(dob)) {
            return res.status(400).json({ error: 'dob phải là ngày hợp lệ theo định dạng YYYY-MM-DD' });
        }
        const numericGender = Number(gender);
        if (![Gender.Male, Gender.Female].includes(numericGender)) {
            return res.status(400).json({ error: 'gender phải là 0 (Male) hoặc 1 (Female)' });
        }

        const payload = {
            profile: {
                name: String(name),
                dob: String(dob),
                gender: numericGender
            }
        };
        if (biz && typeof biz === 'object' && !Array.isArray(biz)) {
            payload.biz = biz;
        }

        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateProfile(payload);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateProfileBioByAccount(req, res) {
    try {
        const { status, accountSelection } = req.body;
        if (status === undefined || status === null) {
            return res.status(400).json({ error: 'status là bắt buộc (có thể là chuỗi rỗng để xóa bio)' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateProfileBio(String(status));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateLangByAccount(req, res) {
    try {
        const { language, accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateLang(language);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateSettingsByAccount(req, res) {
    try {
        const { type, status, accountSelection } = req.body;
        if (!type || status === undefined) {
            return res.status(400).json({ error: 'type và status là bắt buộc' });
        }
        const normalizedType = String(type);
        const allowedValues = UPDATE_SETTINGS_ALLOWED_VALUES.get(normalizedType);
        if (!allowedValues) {
            return res.status(400).json({ error: `type không hợp lệ. Giá trị hỗ trợ: ${[...UPDATE_SETTINGS_ALLOWED_VALUES.keys()].join(', ')}` });
        }
        const normalizedStatus = Number(status);
        if (!Number.isInteger(normalizedStatus) || !allowedValues.has(normalizedStatus)) {
            return res.status(400).json({ error: `status không hợp lệ cho ${normalizedType}. Giá trị hỗ trợ: ${[...allowedValues].join(', ')}` });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateSettings(normalizedType, normalizedStatus);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ===== OTHER APIs =====

export async function getSettingsByAccount(req, res) {
    try {
        const { accountSelection } = req.body;
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getSettings();
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function updateActiveStatusByAccount(req, res) {
    try {
        const { active, accountSelection } = req.body;
        if (typeof active !== 'boolean') return res.status(400).json({ error: 'active phải là boolean' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.updateActiveStatus(active);
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getBizAccountByAccount(req, res) {
    try {
        const { friendId, accountSelection } = req.body;
        if (!friendId) return res.status(400).json({ error: 'friendId là bắt buộc' });
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.getBizAccount(String(friendId));
        return sendAccountResult(res, account, result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function lastOnlineByAccount(req, res) {
    try {
        const { uid, accountSelection } = req.body;
        if (!uid) {
            return res.status(400).json({ error: 'uid là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const result = await account.api.lastOnline(uid);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendReportByAccount(req, res) {
    try {
        const { options, threadId, type, accountSelection } = req.body;
        if (!options || !threadId) {
            return res.status(400).json({ error: 'options và threadId là bắt buộc' });
        }
        const account = getAccountFromSelection(accountSelection);
        const threadType = normalizeThreadType(type, ThreadType);
        const result = await account.api.sendReport(options, String(threadId), threadType);
        res.json({ success: true, data: result, usedAccount: { ownId: account.ownId, phoneNumber: account.phoneNumber } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}


export async function findUser(req, res) {
    try {
        const { phone, ownId } = req.body;
        if (!phone || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
       
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        const userData = await account.api.findUser(phone);
        res.json({ success: true, data: userData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getUserInfo(req, res) {
    try {
        const { userId, ownId } = req.body;
        if (!userId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        const info = await account.api.getUserInfo(userId);
        res.json({ success: true, data: info });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendFriendRequest(req, res) {
    try {
        const { userId, ownId } = req.body;
        if (!userId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        const result = await account.api.sendFriendRequest('Xin chào, hãy kết bạn với tôi!', userId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function sendMessage(req, res) {
    try {
        const { message, threadId, type, ownId, quote } = req.body;
        if (!message || !threadId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const msgType = normalizeThreadType(type, ThreadType);
        const requestedTtl = getRequestedMessageTtl(req.body, message);
        let messageContent = withMessageTtl(message, requestedTtl);
        if (quote) {
            if (typeof messageContent === 'string') {
                messageContent = { msg: messageContent, quote };
            } else if (typeof messageContent === 'object') {
                messageContent = { ...messageContent, quote };
            }
        }

        const result = await account.api.sendMessage(messageContent, String(threadId), msgType);
        res.json({ success: true, data: result, messageTtl: messageTtlResult(requestedTtl) });
    } catch (error) {
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function createGroup(req, res) {
    try {
        const { members, name, avatarPath, ownId } = req.body;
        // Kiểm tra dữ liệu hợp lệ
        if (!members || !Array.isArray(members) || members.length === 0 || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        // Gọi API createGroup từ zaloAccounts
        const result = await account.api.createGroup({ members, name, avatarPath });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function getGroupInfo(req, res) {
    try {
        const { groupId, ownId } = req.body;
        // Kiểm tra dữ liệu: groupId phải tồn tại và nếu là mảng thì không rỗng
        if (!groupId || (Array.isArray(groupId) && groupId.length === 0)) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        // Gọi API getGroupInfo từ zaloAccounts
        const result = await account.api.getGroupInfo(groupId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function addUserToGroup(req, res) {
    try {
        const { groupId, memberId, ownId } = req.body;
        // Kiểm tra dữ liệu hợp lệ: groupId và memberId không được bỏ trống
        if (!groupId || !memberId || (Array.isArray(memberId) && memberId.length === 0)) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        // Gọi API addUserToGroup từ zaloAccounts
        const result = await account.api.addUserToGroup(memberId, groupId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export async function removeUserFromGroup(req, res) {
    try {
        const { memberId, groupId, ownId } = req.body;
        // Kiểm tra dữ liệu: groupId và memberId phải được cung cấp, nếu memberId là mảng thì không được rỗng
        if (!groupId || !memberId || (Array.isArray(memberId) && memberId.length === 0)) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }
        // Gọi API removeUserFromGroup từ zaloAccounts
        const result = await account.api.removeUserFromGroup(memberId, groupId);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// Hàm gửi một hình ảnh đến người dùng
export async function sendImageToUser(req, res) {
    let imagePath;
    try {
        const { imagePath: imageUrl, threadId, ownId, ttl } = req.body;
        if (!imageUrl || !threadId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ: imagePath và threadId là bắt buộc' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        imagePath = await saveImage(imageUrl);
        if (!imagePath) return res.status(500).json({ success: false, error: 'Failed to save image' });

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: [imagePath] }, normalizedMessageTtl),
            String(threadId),
            ThreadType.User
        );

        removeImage(imagePath);
        imagePath = null;
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedMessageTtl) });
    } catch (error) {
        if (imagePath) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImagesToUser(req, res) {
    const imagePaths = [];
    try {
        const { imagePaths: imageUrls, threadId, ownId, ttl } = req.body;
        if (!imageUrls || !threadId || !ownId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ: imagePaths phải là mảng không rỗng và threadId là bắt buộc' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        const downloadedImages = await saveImages(imageUrls);
        if (downloadedImages.some((imagePath) => !imagePath)) {
            for (const savedPath of downloadedImages.filter(Boolean)) removeImage(savedPath);
            return res.status(500).json({ success: false, error: 'Failed to save one or more images' });
        }
        imagePaths.push(...downloadedImages);

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: imagePaths }, normalizedMessageTtl),
            String(threadId),
            ThreadType.User
        );

        for (const imagePath of imagePaths) removeImage(imagePath);
        imagePaths.length = 0;
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedMessageTtl) });
    } catch (error) {
        for (const imagePath of imagePaths) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImageToGroup(req, res) {
    let imagePath;
    try {
        const { imagePath: imageUrl, threadId, ownId, ttl } = req.body;
        if (!imageUrl || !threadId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ: imagePath và threadId là bắt buộc' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        imagePath = await saveImage(imageUrl);
        if (!imagePath) return res.status(500).json({ success: false, error: 'Failed to save image' });

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: [imagePath] }, normalizedMessageTtl),
            String(threadId),
            ThreadType.Group
        );

        removeImage(imagePath);
        imagePath = null;
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedMessageTtl) });
    } catch (error) {
        if (imagePath) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendImagesToGroup(req, res) {
    const imagePaths = [];
    try {
        const { imagePaths: imageUrls, threadId, ownId, ttl } = req.body;
        if (!imageUrls || !threadId || !ownId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ: imagePaths phải là mảng không rỗng và threadId là bắt buộc' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        const downloadedImages = await saveImages(imageUrls);
        if (downloadedImages.some((imagePath) => !imagePath)) {
            for (const savedPath of downloadedImages.filter(Boolean)) removeImage(savedPath);
            return res.status(500).json({ success: false, error: 'Failed to save one or more images' });
        }
        imagePaths.push(...downloadedImages);

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: '', attachments: imagePaths }, normalizedMessageTtl),
            String(threadId),
            ThreadType.Group
        );

        for (const imagePath of imagePaths) removeImage(imagePath);
        imagePaths.length = 0;
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedMessageTtl) });
    } catch (error) {
        for (const imagePath of imagePaths) removeImage(imagePath);
        const status = /ttl/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

export async function sendFile(req, res) {
    let filePath;
    try {
        const { fileUrl, threadId, ownId, type, message, ttl } = req.body;
        if (!fileUrl || !threadId || !ownId) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ: fileUrl, threadId và ownId là bắt buộc' });
        }

        const account = zaloAccounts.find(acc => acc.ownId === ownId);
        if (!account) {
            return res.status(400).json({ error: 'Không tìm thấy tài khoản Zalo với OwnId này' });
        }

        const threadType = normalizeThreadType(type, ThreadType);
        const normalizedMessageTtl = normalizeMessageTtl(ttl);
        filePath = await saveFileFromUrl(fileUrl);
        if (!filePath) {
            return res.status(500).json({ success: false, error: 'Không thể tải và lưu file' });
        }

        const result = await account.api.sendMessage(
            withMessageTtl({ msg: message || '', attachments: [filePath] }, normalizedMessageTtl),
            String(threadId),
            threadType
        );

        removeFile(filePath);
        filePath = null;
        res.json({ success: true, data: result, messageTtl: messageTtlResult(normalizedMessageTtl) });
    } catch (error) {
        if (filePath) removeFile(filePath);
        const status = /ttl|type không hợp lệ/i.test(error.message) ? 400 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
}

function describeProxy(proxy) {
    if (!proxy) return 'không proxy';
    try {
        const parsed = new URL(proxy);
        return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
        return 'proxy đã cấu hình';
    }
}

// zca-js 2.1.2 correctly consumes Headers.getSetCookie(), while node-fetch 3
// still exposes individual Set-Cookie headers through raw(). When a proxy is
// configured we use node-fetch + HttpsProxyAgent, so bridge raw() to the native
// getSetCookie() shape expected by zca-js. Direct connections keep Node fetch.
async function proxyFetchWithSetCookie(...args) {
    const response = await nodefetch(...args);
    const headers = response?.headers;

    if (headers && typeof headers.getSetCookie !== 'function' && typeof headers.raw === 'function') {
        const getSetCookie = () => headers.raw()?.['set-cookie'] || [];
        try {
            Object.defineProperty(headers, 'getSetCookie', {
                value: getSetCookie,
                configurable: true
            });
        } catch {
            headers.getSetCookie = getSetCookie;
        }
    }

    return response;
}

export async function loginZaloAccount(customProxy, cred, options = {}) {
    const {
        allowQrFallback = true,
        autoSelectProxy = true
    } = options;

    // Credential v1.0.1 có thêm trường `proxy` để nhớ đúng đường ra mạng.
    // Không truyền trường nội bộ này vào zca-js.
    const loginCredential = cred
        ? Object.fromEntries(Object.entries(cred).filter(([key]) => key !== 'proxy'))
        : null;

    let loginResolve;
    return new Promise(async (resolve, reject) => {
        console.log('Bắt đầu quá trình đăng nhập Zalo...');
        console.log('Custom proxy:', describeProxy(customProxy));
        console.log('Đang nhập với cookie:', loginCredential ? 'có' : 'không');
        console.log('Cho phép fallback QR:', allowQrFallback ? 'có' : 'không');
        console.log('Tự động chọn proxy:', autoSelectProxy ? 'có' : 'không');

        loginResolve = resolve;
        let agent;
        let proxyUsed = null;
        let useCustomProxy = false;

        // Proxy list is owned by proxyService so counters/assignments remain
        // consistent in memory and on disk. The old login flow re-read/wrote
        // proxies.json directly and could leave proxyService stale.
        if (customProxy && customProxy.trim() !== "") {
            try {
                const parsedProxy = new URL(customProxy);
                if (!["http:", "https:"].includes(parsedProxy.protocol)) {
                    throw new Error("Chỉ hỗ trợ proxy http/https");
                }
                useCustomProxy = true;
                addProxy(customProxy);
                console.log('Sử dụng proxy tùy chỉnh:', describeProxy(customProxy));
            } catch (err) {
                throw new Error(`Proxy không hợp lệ: ${err.message}`);
            }
        }

        if (useCustomProxy) {
            agent = new HttpsProxyAgent(customProxy);
        } else if (autoSelectProxy) {
            if (getPROXIES().length > 0) {
                const proxyIndex = getAvailableProxyIndex();
                if (proxyIndex === -1) {
                    console.log('Tất cả proxy đều đã đủ tài khoản. Sẽ đăng nhập không qua proxy.');
                    agent = null;
                } else {
                    proxyUsed = getProxyRef(proxyIndex);
                    console.log('Sử dụng proxy tự động:', describeProxy(proxyUsed.url));
                    agent = new HttpsProxyAgent(proxyUsed.url);
                }
            } else {
                console.log('Không có proxy nào có sẵn, sẽ đăng nhập không qua proxy');
                agent = null;
            }
        } else {
            console.log('Giữ kết nối không proxy theo credential đã lưu');
            agent = null;
        }
        let zalo;
        // zca-js v2 requires an imageMetadataGetter when sending image files.
        // Use image-size v2 async file API so large/multi-image sends do not block
        // the Node.js event loop with synchronous file reads.
        const getImageMetadata = async (filePath) => {
            try {
                if (typeof filePath !== 'string' || filePath.startsWith('http://') || filePath.startsWith('https://')) {
                    return { width: 1280, height: 720, size: 300000 };
                }

                const stats = await fs.promises.stat(filePath);
                const dimensions = await imageSizeFromFile(filePath);
                if (!dimensions?.width || !dimensions?.height) {
                    throw new Error('Không đọc được kích thước ảnh');
                }
                return {
                    width: dimensions.width,
                    height: dimensions.height,
                    size: stats.size,
                };
            } catch (error) {
                console.warn(`[Image] Không thể đọc metadata ${filePath}: ${error.message}. Dùng metadata fallback.`);
                let size = 300000;
                try {
                    if (typeof filePath === 'string') size = (await fs.promises.stat(filePath)).size;
                } catch {}
                return { width: 1280, height: 720, size };
            }
        };
        
        if (useCustomProxy || agent) {
            console.log('Khởi tạo Zalo SDK với proxy agent');
            zalo = new Zalo({
                selfListen: true,
                agent: agent,
                // node-fetch is required for HttpsProxyAgent, but it does not expose
                // Headers.getSetCookie(). Add it from headers.raw() so QR cookies
                // such as zpsid/zpw_sek are not corrupted after confirmation.
                // @ts-ignore
                polyfill: proxyFetchWithSetCookie,
                imageMetadataGetter: getImageMetadata
            });
        } else {
            console.log('Khởi tạo Zalo SDK không có proxy');
            zalo = new Zalo({
                selfListen: true,
                imageMetadataGetter: getImageMetadata
            });
        }

        let qrCodeDelivered = false;
        const handleQrLoginEvent = (qrData) => {
            const image = qrData?.data?.image;
            if (image) {
                // loginQR uses the same callback for QR generation and later status
                // events. Only the QRCodeGenerated event contains data.image.
                if (!qrCodeDelivered) {
                    qrCodeDelivered = true;
                    const qrCodeImage = `data:image/png;base64,${image}`;
                    console.log('Đã tạo mã QR, độ dài:', qrCodeImage.length);
                    resolve(qrCodeImage);
                }
                return;
            }

            // A callback without image is a normal login state transition
            // (scan/confirm/login info), not a QR generation failure.
            if (process.env.DEBUG_LOGIN === 'true') {
                const eventType = qrData?.type ?? qrData?.event ?? qrData?.data?.type ?? 'status';
                console.log('[LoginQR] Trạng thái SDK:', eventType);
            }
        };

        let api;
        try {
            if (loginCredential) {
                console.log('Đang thử đăng nhập bằng cookie...');
                try {
                    api = await zalo.login(loginCredential);
                    console.log('Đăng nhập bằng cookie thành công');
                } catch (error) {
                    console.error("Lỗi khi đăng nhập bằng cookie:", error?.message || error);

                    // Auto-reconnect/restore không được tự sinh QR. Giữ cookie để retry.
                    if (!allowQrFallback) {
                        throw error;
                    }

                    console.log('Cookie không sử dụng được, chuyển sang đăng nhập bằng mã QR...');
                    api = await zalo.loginQR(null, handleQrLoginEvent);
                }
            } else {
                console.log('Đang tạo mã QR để đăng nhập...');
                api = await zalo.loginQR(null, handleQrLoginEvent);
            }

            console.log('Thiết lập event listeners');
            // QR flow đã resolve sớm bằng ảnh QR. Credential/reconnect chỉ resolve
            // sau khi account info + credential mới đã được lưu hoàn tất.
            setupEventListeners(api, loginCredential ? null : loginResolve);
            api.listener.start();

            console.log('Đang lấy thông tin tài khoản...');
            const accountInfo = await api.fetchAccountInfo();
            if (!accountInfo?.profile) {
                console.error('Không tìm thấy thông tin profile trong phản hồi');
                throw new Error("Không tìm thấy thông tin profile");
            }
            const { profile } = accountInfo;
            const phoneNumber = profile.phoneNumber;
            const ownId = profile.userId;
            const displayName = profile.displayName;
            console.log(`Thông tin tài khoản: ID=${ownId}, Tên=${displayName}, SĐT=${phoneNumber}`);
            const effectiveProxy = useCustomProxy ? customProxy : (proxyUsed?.url || null);
            markProxyAccount(effectiveProxy, ownId);

            const existingAccountIndex = zaloAccounts.findIndex(acc => acc.ownId === api.getOwnId());
            if (existingAccountIndex !== -1) {
                // Thay thế tài khoản cũ bằng tài khoản mới
                zaloAccounts[existingAccountIndex] = { api: api, ownId: api.getOwnId(), proxy: useCustomProxy ? customProxy : (proxyUsed && proxyUsed.url), phoneNumber: phoneNumber };
                console.log('Đã cập nhật tài khoản hiện có trong danh sách zaloAccounts');
            } else {
                // Thêm tài khoản mới nếu không tìm thấy tài khoản cũ
                zaloAccounts.push({ api: api, ownId: api.getOwnId(), proxy: useCustomProxy ? customProxy : (proxyUsed && proxyUsed.url), phoneNumber: phoneNumber });
                console.log('Đã thêm tài khoản mới vào danh sách zaloAccounts');
            }

            console.log('Đang lưu cookie...');
            const context = await api.getContext();
            const {imei, cookie, userAgent} = context;
            const data = {
                imei: imei,
                cookie: cookie,
                userAgent: userAgent,
                // Lưu proxy cùng credential để restart/reconnect giữ nguyên IP/proxy.
                // null nghĩa là account này được đăng nhập không qua proxy.
                proxy: effectiveProxy,
            }
            
            // Import hàm getCookiesDir
            const { getCookiesDir } = await import('../../utils/helpers.js');
            const cookiesDir = getCookiesDir();
            console.log(`Lưu cookie vào thư mục: ${cookiesDir}`);
            
            if (!fs.existsSync(cookiesDir)) {
                fs.mkdirSync(cookiesDir, { recursive: true });
                console.log(`Đã tạo thư mục cookies tại ${cookiesDir}`);
            }
            
            const credFilePath = path.join(cookiesDir, `cred_${ownId}.json`);
            writeJsonAtomicSync(credFilePath, data, 4);
            try { fs.chmodSync(credFilePath, 0o600); } catch {}
            console.log(`Đã lưu credential mới vào ${credFilePath}`);

            console.log(`Đã đăng nhập vào tài khoản ${ownId} (${displayName}) với số điện thoại ${phoneNumber} qua ${describeProxy(effectiveProxy)}`);
            if (loginCredential) {
                resolve(true);
            }
        } catch (error) {
            console.error('Lỗi trong quá trình đăng nhập Zalo:', error?.message || error);
            reject(error);
        }
    });
}