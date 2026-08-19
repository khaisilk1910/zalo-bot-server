import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getWebhookUrl as getConfigWebhookUrl, getWebhookTargets as getConfigWebhookTargets } from '../services/webhookService.js';
import { getDataDirectory, getDataFilePath } from '../config/addon.js';

const DEFAULT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_FILE_MAX_BYTES = 150 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

function positiveIntEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sizeLimitTransform(maxBytes) {
    let bytes = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                callback(new Error(`Tệp vượt quá giới hạn ${maxBytes} bytes`));
                return;
            }
            callback(null, chunk);
        }
    });
}

function safeFilename(filename, fallback = 'file.bin') {
    const base = path.basename(String(filename || fallback)).replace(/[\x00-\x1f\x7f]/g, '_');
    return base && base !== '.' && base !== '..' ? base : fallback;
}

export function getCookiesDir() {
    const cookiesDir = path.join(getDataDirectory(), 'cookies');
    fs.mkdirSync(cookiesDir, { recursive: true });
    return cookiesDir;
}

export function getProxiesFilePath() {
    return getDataFilePath('proxies.json');
}

export function getWebhookUrl(key, ownId) {
    return getConfigWebhookUrl(key, ownId);
}

export function getWebhookTargets(eventType, ownId) {
    return getConfigWebhookTargets(eventType, ownId);
}

export async function triggerN8nWebhook(msg, webhookUrl) {
    if (!webhookUrl) return false;

    try {
        const payload = JSON.stringify(msg);
        const maxBodyBytes = 2 * 1024 * 1024;
        if (Buffer.byteLength(payload) > maxBodyBytes) {
            throw new Error(`Webhook payload vượt quá giới hạn ${maxBodyBytes} bytes`);
        }

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            redirect: 'follow',
            signal: AbortSignal.timeout(positiveIntEnv('WEBHOOK_TIMEOUT_MS', 10_000)),
        });
        if (!response.ok) {
            throw new Error(`Webhook trả về HTTP ${response.status} ${response.statusText}`);
        }
        // Release the response body/socket promptly; webhook responses are not consumed.
        response.body?.resume?.();
        return true;
    } catch (error) {
        console.error('[Webhook] Không thể gửi webhook:', error.message || error);
        return false;
    }
}

export async function saveFileFromUrl(url) {
    let tempFilePath = null;
    try {
        const response = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch file: HTTP ${response.status} ${response.statusText}`);
        }

        const maxBytes = positiveIntEnv('FILE_DOWNLOAD_MAX_BYTES', DEFAULT_FILE_MAX_BYTES);
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            throw new Error(`Tệp vượt quá giới hạn ${maxBytes} bytes`);
        }

        const contentDisposition = response.headers.get('content-disposition');
        let filename;
        if (contentDisposition) {
            const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
            const plainMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
            const raw = utf8Match?.[1] ? decodeURIComponent(utf8Match[1]) : plainMatch?.[1];
            if (raw) filename = raw;
        }
        if (!filename) {
            try {
                filename = path.basename(new URL(url).pathname);
            } catch {
                filename = 'download.bin';
            }
        }
        filename = safeFilename(filename, 'download.bin');

        const tempDir = path.join(os.tmpdir(), 'zalo-bot-files');
        await fs.promises.mkdir(tempDir, { recursive: true });
        tempFilePath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}-${filename}`);

        if (!response.body) throw new Error('Response body is empty');

        await pipeline(
            response.body,
            sizeLimitTransform(maxBytes),
            fs.createWriteStream(tempFilePath, { mode: 0o600 })
        );
        return tempFilePath;
    } catch (error) {
        if (tempFilePath) await fs.promises.rm(tempFilePath, { force: true }).catch(() => {});
        console.error('[Download] Lỗi tải file:', error.message || error);
        return null;
    }
}

function getImageExtension(url, contentType) {
    const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
    const mimeExtensions = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/heic': '.heic',
        'image/heif': '.heif'
    };
    if (mimeExtensions[mime]) return mimeExtensions[mime];

    try {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
    } catch {
        // Use default below.
    }
    return '.jpg';
}

export async function saveImage(url) {
    let imgPath = null;
    try {
        const maxBytes = positiveIntEnv('IMAGE_DOWNLOAD_MAX_BYTES', DEFAULT_IMAGE_MAX_BYTES);
        const response = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: HTTP ${response.status} ${response.statusText}`);
        }

        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.body?.destroy?.();
            throw new Error(`Ảnh vượt quá giới hạn ${maxBytes} bytes`);
        }

        const tempDir = path.join(os.tmpdir(), 'zalo-bot-images');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const extension = getImageExtension(url, response.headers.get('content-type'));
        imgPath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}${extension}`);

        if (!response.body) throw new Error('Response body is empty');
        await pipeline(
            response.body,
            sizeLimitTransform(maxBytes),
            fs.createWriteStream(imgPath, { mode: 0o600 })
        );
        return imgPath;
    } catch (error) {
        if (imgPath) await fs.promises.rm(imgPath, { force: true }).catch(() => {});
        console.error('[Download] Lỗi tải ảnh:', error.message || error);
        return null;
    }
}

/** Download multiple images concurrently while limiting pressure on CPU/network. */
export async function saveImages(urls, concurrency = 4) {
    const list = Array.isArray(urls) ? urls : [];
    const results = new Array(list.length);
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, list.length));
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= list.length) return;
            results[index] = await saveImage(list[index]);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}


/**
 * Extract a JPEG thumbnail from a local video without blocking Node's event loop.
 * Returns the generated image path, or null when ffmpeg is unavailable / extraction fails.
 */
export async function createVideoThumbnail(videoPath) {
    let thumbnailPath = null;
    try {
        if (!videoPath) return null;

        const tempDir = path.join(os.tmpdir(), 'zalo-bot-images');
        await fs.promises.mkdir(tempDir, { recursive: true });
        thumbnailPath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}-video-thumb.jpg`);

        const timeoutMs = positiveIntEnv('VIDEO_THUMBNAIL_TIMEOUT_MS', 30_000);
        const baseArgs = [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', videoPath,
            '-frames:v', '1',
            '-vf', "scale=w='min(1280,iw)':h=-2",
            '-q:v', '3',
            thumbnailPath,
        ];

        // Prefer a frame shortly after the beginning to avoid black first frames.
        // If a very short/corrupt clip cannot seek there, retry from frame zero.
        try {
            await execFileAsync('ffmpeg', ['-ss', '0.5', ...baseArgs], {
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
        } catch (firstError) {
            await fs.promises.rm(thumbnailPath, { force: true }).catch(() => {});
            await execFileAsync('ffmpeg', baseArgs, {
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
        }

        const stat = await fs.promises.stat(thumbnailPath);
        if (!stat.isFile() || stat.size <= 0) {
            throw new Error('ffmpeg không tạo được thumbnail hợp lệ');
        }
        return thumbnailPath;
    } catch (error) {
        if (thumbnailPath) await fs.promises.rm(thumbnailPath, { force: true }).catch(() => {});
        console.warn('[Video] Không thể tự tạo thumbnail từ video:', error?.message || error);
        return null;
    }
}

export function removeImage(imgPath) {
    if (!imgPath) return;
    fs.promises.rm(imgPath, { force: true }).catch((error) => {
        console.error(`[Cleanup] Không thể xóa ảnh ${imgPath}:`, error.message || error);
    });
}

export function removeFile(filePath) {
    if (!filePath) return;
    fs.promises.rm(filePath, { force: true }).catch((error) => {
        console.error(`[Cleanup] Không thể xóa file ${filePath}:`, error.message || error);
    });
}
