import { getWebhookUrl, triggerN8nWebhook, getCookiesDir } from './utils/helpers.js';
import { broadcastToWebsocket } from './services/webhookService.js';
import fs from 'fs';
import path from 'path';
import { loginZaloAccount, zaloAccounts } from './api/zalo/zalo.js';
import { broadcastMessage } from './server.js';

// Theo dõi thời điểm reconnect gần nhất (giữ export để tương thích code cũ nếu có).
export const reloginAttempts = new Map();

// Backoff: 5s -> 15s -> 30s -> 60s -> 120s -> 300s; sau đó tiếp tục 300s/lần.
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];
const reconnectStates = new Map();

function clearReconnectState(ownId) {
    const state = reconnectStates.get(ownId);
    if (state?.timer) {
        clearTimeout(state.timer);
    }
    reconnectStates.delete(ownId);
    reloginAttempts.delete(ownId);
}

function scheduleRelogin(api, immediate = false) {
    const ownId = api?.getOwnId?.();
    if (!ownId) {
        console.error('[Reconnect] Không thể xác định ownId, không thể đăng nhập lại');
        return;
    }

    // Nếu account đã được thay bằng API mới thì bỏ qua event closed cũ.
    const currentAccount = zaloAccounts.find(acc => acc.ownId === ownId);
    if (currentAccount?.api && currentAccount.api !== api) {
        console.log(`[Reconnect] Bỏ qua listener cũ của ${ownId}; account đã có API mới.`);
        return;
    }

    let state = reconnectStates.get(ownId);
    if (!state) {
        state = { attempt: 0, timer: null, running: false, sourceApi: api };
        reconnectStates.set(ownId, state);
    }

    if (state.running || state.timer) {
        console.log(`[Reconnect] ${ownId} đã có một tiến trình reconnect đang chờ/chạy.`);
        return;
    }

    const delay = immediate
        ? 0
        : RECONNECT_DELAYS[Math.min(state.attempt, RECONNECT_DELAYS.length - 1)];

    console.log(`[Reconnect] Sẽ thử đăng nhập lại ${ownId} sau ${Math.round(delay / 1000)} giây (lần ${state.attempt + 1}).`);
    state.timer = setTimeout(() => attemptRelogin(ownId), delay);
    reconnectStates.set(ownId, state);
}

async function attemptRelogin(ownId) {
    const state = reconnectStates.get(ownId);
    if (!state || state.running) return;

    state.timer = null;
    state.running = true;
    reloginAttempts.set(ownId, Date.now());

    try {
        const accountInfo = zaloAccounts.find(acc => acc.ownId === ownId);

        // Nếu một API mới đã thay thế API gây disconnect thì reconnect đã thành công ở nơi khác.
        if (accountInfo?.api && state.sourceApi && accountInfo.api !== state.sourceApi) {
            console.log(`[Reconnect] ${ownId} đã có API mới, hủy retry cũ.`);
            clearReconnectState(ownId);
            return;
        }

        const cookiesDir = getCookiesDir();
        const cookieFile = path.join(cookiesDir, `cred_${ownId}.json`);

        if (!fs.existsSync(cookieFile)) {
            console.error(`[Reconnect] Không tìm thấy credential ${cookieFile}. Không thể tự reconnect nếu không có cookie.`);
            clearReconnectState(ownId);
            return;
        }

        const savedCredential = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        const credentialHasProxy = Object.prototype.hasOwnProperty.call(savedCredential, 'proxy');
        const accountHasProxy = !!accountInfo && Object.prototype.hasOwnProperty.call(accountInfo, 'proxy');

        // Ưu tiên proxy đã lưu cùng credential. Với credential legacy, dùng proxy của account hiện tại.
        const savedProxy = credentialHasProxy
            ? (savedCredential.proxy || null)
            : (accountInfo?.proxy || null);

        // Khi đã biết account trước đó dùng proxy gì (kể cả null = không proxy),
        // không tự chọn proxy khác. Credential legacy không có thông tin mới cho phép auto-select.
        const autoSelectProxy = !(credentialHasProxy || accountHasProxy);

        console.log(`[Reconnect] Đang đăng nhập lại ${ownId} với ${savedProxy || 'không proxy'}...`);

        await loginZaloAccount(savedProxy, savedCredential, {
            allowQrFallback: false,
            autoSelectProxy
        });

        console.log(`[Reconnect] Đăng nhập lại thành công tài khoản ${ownId}.`);
        clearReconnectState(ownId);
    } catch (error) {
        console.error(`[Reconnect] Lần ${state.attempt + 1} thất bại cho ${ownId}:`, error?.message || error);
        state.running = false;
        state.attempt += 1;
        reconnectStates.set(ownId, state);

        // Không xóa cookie, không sinh QR. Tiếp tục retry theo backoff.
        scheduleRelogin(state.sourceApi);
    }
}

export function setupEventListeners(api, loginResolve) {
    const ownId = api.getOwnId();

    api.listener.on('message', (msg) => {
        const messageWebhookUrl = getWebhookUrl('messageWebhookUrl', ownId);
        const msgWithOwnId = { ...msg, _accountId: ownId };

        if (messageWebhookUrl) {
            triggerN8nWebhook(msgWithOwnId, messageWebhookUrl);
        }

        broadcastToWebsocket(msgWithOwnId);
    });

    api.listener.on('group_event', (data) => {
        const groupEventWebhookUrl = getWebhookUrl('groupEventWebhookUrl', ownId);
        const dataWithOwnId = { ...data, _accountId: ownId };

        if (groupEventWebhookUrl) {
            triggerN8nWebhook(dataWithOwnId, groupEventWebhookUrl);
        }

        broadcastToWebsocket(dataWithOwnId);
    });

    api.listener.on('reaction', (reaction) => {
        const reactionWebhookUrl = getWebhookUrl('reactionWebhookUrl', ownId);
        console.log('Nhận reaction:', reaction);
        if (reactionWebhookUrl) {
            const reactionWithOwnId = { ...reaction, _accountId: ownId };
            triggerN8nWebhook(reactionWithOwnId, reactionWebhookUrl);
        }
    });

    api.listener.onConnected(() => {
        console.log(`Connected account ${ownId}`);
        clearReconnectState(ownId);

        if (typeof loginResolve === 'function') {
            loginResolve('login_success');
        }

        try {
            broadcastMessage('login_success');
        } catch (err) {
            console.error('Lỗi khi gửi thông báo WebSocket:', err);
        }
    });

    api.listener.onClosed(() => {
        console.log(`Closed - API listener đã ngắt kết nối cho tài khoản ${ownId}`);
        scheduleRelogin(api);
    });

    api.listener.onError((error) => {
        console.error(`Error on account ${ownId}:`, error);
    });
}
