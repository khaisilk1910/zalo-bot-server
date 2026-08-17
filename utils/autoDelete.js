// Compatibility helpers for Zalo auto-delete.
// zca-js still exposes per-message `ttl`, but Zalo no longer reliably
// executes that field. The supported mechanism is conversation auto-delete.

export const AUTO_DELETE_TTLS = Object.freeze({
    OFF: 0,
    ONE_DAY: 86_400_000,
    SEVEN_DAYS: 604_800_000,
    FOURTEEN_DAYS: 1_209_600_000
});

const TTL_ALIASES = new Map([
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

const SUPPORTED_TTL_VALUES = new Set(Object.values(AUTO_DELETE_TTLS));

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

    const alias = TTL_ALIASES.get(String(rawTtl).trim().toLowerCase());
    const ttl = alias !== undefined ? alias : Number(rawTtl);

    if (!Number.isFinite(ttl) || !Number.isInteger(ttl) || !SUPPORTED_TTL_VALUES.has(ttl)) {
        throw new Error(
            'ttl không được Zalo Auto Delete hỗ trợ. Dùng 0/off, 86400000/1d, 604800000/7d hoặc 1209600000/14d.'
        );
    }

    return ttl;
}

export function getRequestedAutoDeleteTtl(body = {}, message) {
    if (Object.prototype.hasOwnProperty.call(body, 'ttl')) {
        return body.ttl;
    }

    if (message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'ttl')) {
        return message.ttl;
    }

    return undefined;
}

export function stripLegacyMessageTtl(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return message;
    }

    if (!Object.prototype.hasOwnProperty.call(message, 'ttl')) {
        return { ...message };
    }

    const { ttl: _legacyTtl, ...messageWithoutTtl } = message;
    return messageWithoutTtl;
}

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
