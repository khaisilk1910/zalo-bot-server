// TTL helpers for zca-js 2.1.2.
//
// IMPORTANT: zca-js exposes two different concepts:
// 1) per-message `ttl` on sendMessage/sendVideo/sendVoice, which accepts a
//    millisecond duration and belongs to the individual outgoing message;
// 2) conversation Auto Delete (`updateAutoDeleteChat`), whose public ChatTTL
//    enum only exposes OFF, 1 day, 7 days and 14 days.
// Keep these paths separate. Converting every message ttl into
// updateAutoDeleteChat changes conversation settings and rejects 1h..24h TTLs.

export const AUTO_DELETE_TTLS = Object.freeze({
    OFF: 0,
    ONE_DAY: 86_400_000,
    SEVEN_DAYS: 604_800_000,
    FOURTEEN_DAYS: 1_209_600_000
});

const CHAT_TTL_ALIASES = new Map([
    ['0', AUTO_DELETE_TTLS.OFF],
    ['off', AUTO_DELETE_TTLS.OFF],
    ['none', AUTO_DELETE_TTLS.OFF],
    ['disable', AUTO_DELETE_TTLS.OFF],
    ['disabled', AUTO_DELETE_TTLS.OFF],
    ['1d', AUTO_DELETE_TTLS.ONE_DAY],
    ['1day', AUTO_DELETE_TTLS.ONE_DAY],
    ['day', AUTO_DELETE_TTLS.ONE_DAY],
    ['86400000', AUTO_DELETE_TTLS.ONE_DAY],
    ['7d', AUTO_DELETE_TTLS.SEVEN_DAYS],
    ['7days', AUTO_DELETE_TTLS.SEVEN_DAYS],
    ['604800000', AUTO_DELETE_TTLS.SEVEN_DAYS],
    ['14d', AUTO_DELETE_TTLS.FOURTEEN_DAYS],
    ['14days', AUTO_DELETE_TTLS.FOURTEEN_DAYS],
    ['1209600000', AUTO_DELETE_TTLS.FOURTEEN_DAYS]
]);

const MESSAGE_TTL_ALIASES = new Map(CHAT_TTL_ALIASES);
for (let hour = 1; hour <= 24; hour += 1) {
    MESSAGE_TTL_ALIASES.set(`${hour}h`, hour * 60 * 60 * 1000);
}

const SUPPORTED_CHAT_TTL_VALUES = new Set(Object.values(AUTO_DELETE_TTLS));

export function normalizeThreadType(type, ThreadType) {
    if (type === undefined || type === null || type === '') {
        return ThreadType.User;
    }

    if (type === ThreadType.User || type === 0) return ThreadType.User;
    if (type === ThreadType.Group || type === 1) return ThreadType.Group;

    const normalized = String(type).trim().toLowerCase();
    if (normalized === 'user' || normalized === '0') return ThreadType.User;
    if (normalized === 'group' || normalized === '1') return ThreadType.Group;

    throw new Error('type không hợp lệ. Dùng "user"/0 hoặc "group"/1.');
}

export function normalizeAutoDeleteTtl(rawTtl) {
    if (rawTtl === undefined || rawTtl === null || rawTtl === '') {
        return null;
    }

    const alias = CHAT_TTL_ALIASES.get(String(rawTtl).trim().toLowerCase());
    const ttl = alias !== undefined ? alias : Number(rawTtl);

    if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || !SUPPORTED_CHAT_TTL_VALUES.has(ttl)) {
        throw new Error(
            'ttl Auto Delete cuộc trò chuyện không được hỗ trợ. Dùng 0/off, 86400000/1d, 604800000/7d hoặc 1209600000/14d.'
        );
    }

    return ttl;
}

export function normalizeMessageTtl(rawTtl) {
    if (rawTtl === undefined || rawTtl === null || rawTtl === '') {
        return null;
    }

    const alias = MESSAGE_TTL_ALIASES.get(String(rawTtl).trim().toLowerCase());
    const ttl = alias !== undefined ? alias : Number(rawTtl);

    if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 0) {
        throw new Error(
            'ttl tin nhắn không hợp lệ. Dùng off/0, 1h..24h, 1d, 7d, 14d hoặc số milliseconds >= 0.'
        );
    }

    return ttl;
}

export function getRequestedMessageTtl(body = {}, message) {
    if (Object.prototype.hasOwnProperty.call(body, 'ttl')) {
        return body.ttl;
    }

    if (message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'ttl')) {
        return message.ttl;
    }

    return undefined;
}

export function withMessageTtl(message, rawTtl) {
    const ttl = normalizeMessageTtl(rawTtl);
    if (ttl === null) {
        if (message && typeof message === 'object' && !Array.isArray(message)) {
            return { ...message };
        }
        return message;
    }

    if (typeof message === 'string') {
        return { msg: message, ttl };
    }

    if (message && typeof message === 'object' && !Array.isArray(message)) {
        return { ...message, ttl };
    }

    return message;
}

export function messageTtlResult(rawTtl) {
    const ttl = normalizeMessageTtl(rawTtl);
    if (ttl === null) return null;
    return {
        enabled: ttl !== 0,
        ttl,
        scope: 'message'
    };
}

// Kept for the dedicated updateAutoDeleteChat endpoints only.
export async function applyAutoDeleteIfRequested(api, rawTtl, threadId, threadType) {
    const ttl = normalizeAutoDeleteTtl(rawTtl);
    if (ttl === null) return null;

    await api.updateAutoDeleteChat(ttl, String(threadId), threadType);

    return {
        enabled: ttl !== AUTO_DELETE_TTLS.OFF,
        ttl,
        scope: 'conversation'
    };
}
