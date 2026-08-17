import fs from 'fs';
import { getProxiesFilePath } from '../utils/helpers.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';

const MAX_ACCOUNTS_PER_PROXY = Number.parseInt(process.env.MAX_ACCOUNTS_PER_PROXY || '3', 10) || 3;

class ProxyService {
    constructor() {
        this.RAW_PROXIES = [];
        this.PROXIES = [];
        this.reload();
    }

    get filePath() {
        return getProxiesFilePath();
    }

    reload() {
        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(data);
            this.RAW_PROXIES = Array.isArray(parsed) ? [...new Set(parsed.filter(Boolean))] : [];
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('[Proxy] Không thể đọc proxies.json:', err.message);
            }
            this.RAW_PROXIES = [];
            try { writeJsonAtomicSync(this.filePath, []); } catch {}
        }

        const previousAssignments = new Map(
            this.PROXIES.map((proxy) => [proxy.url, proxy.accountIds || new Set()])
        );
        this.PROXIES = this.RAW_PROXIES.map((url) => ({
            url,
            accountIds: previousAssignments.get(url) || new Set(),
        }));
    }

    persist() {
        writeJsonAtomicSync(this.filePath, this.RAW_PROXIES);
    }

    getAvailableProxyIndex() {
        for (let i = 0; i < this.PROXIES.length; i += 1) {
            if (this.PROXIES[i].accountIds.size < MAX_ACCOUNTS_PER_PROXY) return i;
        }
        return -1;
    }

    addProxy(proxyUrl) {
        const cleanUrl = String(proxyUrl || '').trim();
        let parsed;
        try {
            parsed = new URL(cleanUrl);
        } catch {
            throw new Error('Proxy URL không hợp lệ');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Chỉ hỗ trợ proxy http/https');
        }
        if (this.RAW_PROXIES.includes(cleanUrl)) {
            return this.PROXIES.find((proxy) => proxy.url === cleanUrl);
        }
        const newProxy = { url: cleanUrl, accountIds: new Set() };
        this.PROXIES.push(newProxy);
        this.RAW_PROXIES.push(cleanUrl);
        this.persist();
        return newProxy;
    }

    removeProxy(proxyUrl) {
        const index = this.PROXIES.findIndex((proxy) => proxy.url === proxyUrl);
        if (index === -1) throw new Error('Không tìm thấy proxy');
        this.PROXIES.splice(index, 1);
        this.RAW_PROXIES = this.RAW_PROXIES.filter((url) => url !== proxyUrl);
        this.persist();
        return true;
    }

    markAccount(proxyUrl, ownId) {
        if (!ownId) return;
        // Một account chỉ thuộc một proxy tại một thời điểm. Nếu proxyUrl=null,
        // đây cũng là thao tác chuyển account về kết nối trực tiếp.
        for (const proxy of this.PROXIES) proxy.accountIds.delete(String(ownId));
        if (!proxyUrl) return;
        const proxy = this.PROXIES.find((item) => item.url === proxyUrl);
        proxy?.accountIds.add(String(ownId));
    }

    unmarkAccount(ownId) {
        for (const proxy of this.PROXIES) proxy.accountIds.delete(String(ownId));
    }

    getPROXIES() {
        return this.PROXIES.map((proxy) => ({
            url: proxy.url,
            usedCount: proxy.accountIds.size,
            accounts: [...proxy.accountIds],
        }));
    }

    getProxyRef(index) {
        return this.PROXIES[index] || null;
    }
}

const proxyService = new ProxyService();

export { proxyService };
export const getPROXIES = () => proxyService.getPROXIES();
export const getAvailableProxyIndex = () => proxyService.getAvailableProxyIndex();
export const getProxyRef = (index) => proxyService.getProxyRef(index);
export const markProxyAccount = (proxyUrl, ownId) => proxyService.markAccount(proxyUrl, ownId);
export const unmarkProxyAccount = (ownId) => proxyService.unmarkAccount(ownId);
export const addProxy = (proxyUrl) => proxyService.addProxy(proxyUrl);
export const removeProxy = (proxyUrl) => proxyService.removeProxy(proxyUrl);
