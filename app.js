// app.js
import express from 'express';
import session from 'express-session';
import { authMiddleware, isPublicRoute } from './services/authService.js';
import { loadWebhookConfig } from './services/webhookService.js';
import routes from './routes/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { loadHomeAssistantOptions } from './config/addon.js';
import { zaloAccounts, loginZaloAccount } from './api/zalo/zalo.js';
import { FileSessionStore } from './services/fileSessionStore.js';
import { writeFileAtomicSync } from './utils/atomicFile.js';

// Dành cho ES Module: xác định __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Home Assistant options if available
const dataDirectory = loadHomeAssistantOptions();
console.log(`Using data directory: ${dataDirectory}`);

// Kiểm tra và đảm bảo thư mục dữ liệu tồn tại và có quyền ghi
if (!fs.existsSync(dataDirectory)) {
  console.log(`Thư mục dữ liệu ${dataDirectory} không tồn tại, đang tạo mới...`);
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    console.log(`Đã tạo thư mục dữ liệu ${dataDirectory}`);
  } catch (error) {
    console.error(`Lỗi khi tạo thư mục dữ liệu: ${error.message}`);
  }
}

// Thử ghi file test để kiểm tra quyền
try {
  const testFile = path.join(dataDirectory, '.test_write.txt');
  fs.writeFileSync(testFile, 'test write permission', 'utf8');
  console.log(`Đã ghi thành công file test tại ${testFile}`);
  fs.unlinkSync(testFile);
} catch (error) {
  console.error(`Không thể ghi vào thư mục dữ liệu: ${error.message}`);
}

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, 'config', '.env') });

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Cấu hình EJS
app.set('view engine', 'ejs');
const viewsPath = path.join(__dirname, 'views');
if (process.env.DEBUG_STARTUP === 'true') console.log('Views path:', viewsPath);
app.set('views', viewsPath);

// Kiểm tra thư mục views
if (fs.existsSync(viewsPath)) {
  if (process.env.DEBUG_STARTUP === 'true') {
    const files = fs.readdirSync(viewsPath);
    console.log('Views directory exists. Files:', files);
  }
} else {
  console.error('Views directory does not exist at', viewsPath);
  // Nếu không tồn tại, thử tạo thư mục
  try {
    fs.mkdirSync(viewsPath, { recursive: true });
    console.log('Created views directory at', viewsPath);
  } catch (error) {
    console.error('Failed to create views directory:', error);
  }
}

// Tải cấu hình webhook từ file
loadWebhookConfig();
console.log("Đã tải cấu hình webhook");

// Thiết lập middleware
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '2mb' }));

// Thiết lập middleware phục vụ file tĩnh
// Sử dụng thư mục /config/www/zalo_bot cho file tĩnh (đồng bộ với custom component)
const publicDir = process.env.PUBLIC_DIR || '/config/www/zalo_bot';
// Đảm bảo thư mục tồn tại
if (!fs.existsSync(publicDir)) {
  console.log(`Thư mục public ${publicDir} không tồn tại, đang tạo mới...`);
  try {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log(`Đã tạo thư mục public ${publicDir}`);
  } catch (error) {
    console.error(`Lỗi khi tạo thư mục public: ${error.message}`);
  }
}
app.use(express.static(publicDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
// Tương thích ngược với đường dẫn cũ
app.use(express.static(path.join(__dirname, 'public')));
// Đảm bảo có thể truy cập qua /zalo_bot/* để tương thích với code hiện tại
app.use('/zalo_bot', express.static(publicDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
if (process.env.DEBUG_STARTUP === 'true') {
  console.log('Static files path:', publicDir, 'và', path.join(__dirname, 'public'));
  console.log('Đường dẫn URL cho files:', '/* và /zalo_bot/*');
}

// Session secret: ưu tiên biến môi trường; nếu không có thì tạo một secret bền vững
// trong DATA_DIRECTORY để restart container không làm mất toàn bộ session.
function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }

  const secretPath = path.join(dataDirectory, 'session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }

    const generated = crypto.randomBytes(48).toString('hex');
    writeFileAtomicSync(secretPath, generated);
    try { fs.chmodSync(secretPath, 0o600); } catch {}
    console.log(`[Session] Đã tạo session secret bền vững tại ${secretPath}`);
    return generated;
  } catch (error) {
    console.warn(`[Session] Không thể lưu session secret: ${error.message}. Dùng secret tạm thời.`);
    return crypto.randomBytes(48).toString('hex');
  }
}

const sessionSecret = getSessionSecret();
const sessionStore = new FileSessionStore({ dir: path.join(dataDirectory, 'sessions') });

if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

export const sessionMiddleware = session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'zalo-server.sid',
  cookie: {
    secure: process.env.SESSION_COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
    sameSite: 'lax'
  },
  rolling: true
});
app.use(sessionMiddleware);

// Shared view locals for the modern UI. Keeping this middleware lightweight
// avoids repeating session/navigation plumbing in every route.
app.use((req, res, next) => {
  res.locals.authenticated = req.session?.authenticated === true;
  res.locals.username = req.session?.username || '';
  res.locals.isAdmin = req.session?.role === 'admin';
  res.locals.currentPath = req.path || '/';
  next();
});

// Request log chỉ bật khi cần debug để tránh I/O log trên mọi API call.
if (process.env.DEBUG_HTTP === 'true') {
  app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.path}`);
    next();
  });
}

// Middleware xác thực cho tất cả các route trừ những route công khai
app.use((req, res, next) => {
  if (isPublicRoute(req.path)) return next();
  return authMiddleware(req, res, next);
});

// Thiết lập route
app.use('/', routes);

// Login từ cookie đã lưu
import { getCookiesDir } from './utils/helpers.js';

const cookiesDir = getCookiesDir();
console.log(`Thư mục cookies được cấu hình: ${cookiesDir}`);

async function restoreSavedAccounts() {
  let cookieFiles = [];
  try {
    cookieFiles = fs.readdirSync(cookiesDir)
      .filter((file) => file.startsWith('cred_') && file.endsWith('.json'));
  } catch (error) {
    console.error(`[Restore] Không thể đọc ${cookiesDir}:`, error.message);
    return;
  }

  if (cookieFiles.length === 0) return;
  console.log(`[Restore] Tìm thấy ${cookieFiles.length} credential, bắt đầu khôi phục.`);

  const concurrency = Math.min(3, cookieFiles.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= cookieFiles.length) return;
      const file = cookieFiles[current];
      const ownId = file.slice(5, -5);
      try {
        const cookiePath = path.join(cookiesDir, file);
        const credential = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        const hasSavedProxy = Object.prototype.hasOwnProperty.call(credential, 'proxy');
        const savedProxy = hasSavedProxy ? (credential.proxy || null) : null;
        await loginZaloAccount(savedProxy, credential, {
          allowQrFallback: false,
          autoSelectProxy: !hasSavedProxy,
        });
        console.log(`[Restore] Đã khôi phục tài khoản ${ownId}.`);
      } catch (error) {
        console.error(`[Restore] Không thể khôi phục ${ownId}; credential vẫn được giữ:`, error.message || error);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[Restore] Hoàn tất. Có ${zaloAccounts.length} tài khoản trong bộ nhớ.`);
}

if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
void restoreSavedAccounts().catch((error) => console.error('[Restore] Lỗi ngoài dự kiến:', error));

if (process.env.DEBUG_STARTUP === 'true') {
  console.log('DATA_DIRECTORY from process.env:', process.env.DATA_DIRECTORY);
}

export default app;