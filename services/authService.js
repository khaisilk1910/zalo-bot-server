import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataDirectory } from '../config/addon.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';

const PBKDF2_ITERATIONS = 220_000;
const LEGACY_PBKDF2_ITERATIONS = 1_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function getCookiesDir() {
  return path.join(getDataDirectory(), 'cookies');
}

export function getUserFilePath() {
  return path.join(getCookiesDir(), 'users.json');
}

function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  return crypto.pbkdf2Sync(
    String(password),
    salt,
    iterations,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  ).toString('hex');
}

function createUser(username, password, role = 'user') {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    username,
    salt,
    hash: hashPassword(password, salt),
    iterations: PBKDF2_ITERATIONS,
    digest: PBKDF2_DIGEST,
    role,
  };
}

function safeCompareHex(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function ensureUserFile() {
  const cookiesDir = getCookiesDir();
  fs.mkdirSync(cookiesDir, { recursive: true });
  const userFilePath = getUserFilePath();

  if (!fs.existsSync(userFilePath)) {
    writeJsonAtomicSync(userFilePath, [createUser('admin', 'admin', 'admin')]);
    console.warn(
      `[Auth] Đã tạo tài khoản mặc định admin/admin tại ${userFilePath}. ` +
      'Hãy đổi mật khẩu ngay sau lần đăng nhập đầu tiên.'
    );
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(userFilePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('users.json phải là một mảng');
  } catch (error) {
    const backupPath = `${userFilePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(userFilePath, backupPath);
      console.error(`[Auth] users.json lỗi; đã sao lưu thành ${backupPath}: ${error.message}`);
    } catch (renameError) {
      console.error(`[Auth] Không thể sao lưu users.json lỗi: ${renameError.message}`);
    }
    writeJsonAtomicSync(userFilePath, [createUser('admin', 'admin', 'admin')]);
    console.warn('[Auth] Đã tạo lại tài khoản mặc định admin/admin. Hãy đổi mật khẩu ngay.');
  }
}

function getUsers() {
  ensureUserFile();
  try {
    const users = JSON.parse(fs.readFileSync(getUserFilePath(), 'utf8'));
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error('[Auth] Không thể đọc users.json:', error.message);
    return [];
  }
}

function saveUsers(users) {
  writeJsonAtomicSync(getUserFilePath(), users);
}

function verifyPassword(user, password) {
  if (!user?.salt || !user?.hash) return false;
  const iterations = Number(user.iterations) || LEGACY_PBKDF2_ITERATIONS;
  const digest = user.digest || PBKDF2_DIGEST;

  let generated;
  try {
    generated = crypto.pbkdf2Sync(
      String(password),
      user.salt,
      iterations,
      PBKDF2_KEYLEN,
      digest,
    ).toString('hex');
  } catch (error) {
    console.error(`[Auth] Không thể kiểm tra mật khẩu cho ${user.username}: ${error.message}`);
    return false;
  }
  return safeCompareHex(user.hash, generated);
}

function upgradePasswordHashIfNeeded(users, userIndex, password) {
  const user = users[userIndex];
  const iterations = Number(user?.iterations) || LEGACY_PBKDF2_ITERATIONS;
  const digest = user?.digest || PBKDF2_DIGEST;
  if (iterations >= PBKDF2_ITERATIONS && digest === PBKDF2_DIGEST) return;

  const upgraded = createUser(user.username, password, user.role || 'user');
  users[userIndex] = { ...user, ...upgraded };
  try {
    saveUsers(users);
    console.log(`[Auth] Đã nâng cấp password hash cho ${user.username}.`);
  } catch (error) {
    console.warn(`[Auth] Không thể nâng cấp password hash cho ${user.username}: ${error.message}`);
  }
}

export const addUser = (username, password, role = 'user') => {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername || String(password).length < 8) return false;

  const users = getUsers();
  if (users.some((user) => user.username === cleanUsername)) return false;

  users.push(createUser(cleanUsername, password, role === 'admin' ? 'admin' : 'user'));
  saveUsers(users);
  return true;
};

export const validateUser = (username, password) => {
  const users = getUsers();
  const userIndex = users.findIndex((user) => user.username === username);
  if (userIndex === -1) return null;

  const user = users[userIndex];
  if (!verifyPassword(user, password)) return null;

  upgradePasswordHashIfNeeded(users, userIndex, password);
  return { username: user.username, role: user.role || 'user' };
};

export const changePassword = (username, oldPassword, newPassword) => {
  if (String(newPassword || '').length < 8) return false;
  const users = getUsers();
  const userIndex = users.findIndex((user) => user.username === username);
  if (userIndex === -1 || !verifyPassword(users[userIndex], oldPassword)) return false;

  users[userIndex] = {
    ...users[userIndex],
    ...createUser(username, newPassword, users[userIndex].role || 'user'),
  };
  saveUsers(users);
  return true;
};

export const resetUserPassword = (username, newPassword) => {
  if (String(newPassword || '').length < 8) return false;
  const users = getUsers();
  const userIndex = users.findIndex((user) => user.username === username);
  if (userIndex === -1) return false;

  users[userIndex] = {
    ...users[userIndex],
    ...createUser(username, newPassword, users[userIndex].role || 'user'),
  };
  saveUsers(users);
  return true;
};

export const authMiddleware = (req, res, next) => {
  if (req.session?.authenticated) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'authentication_required' });
  }
  return res.redirect('/admin-login');
};

export const adminMiddleware = (req, res, next) => {
  if (req.session?.authenticated && req.session.role === 'admin') return next();

  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ success: false, error: 'admin_required' });
  }
  return res.status(403).send('Không có quyền truy cập. Chỉ admin mới có thể thực hiện chức năng này.');
};

export const getAllUsers = () => getUsers().map((user) => ({
  username: user.username,
  role: user.role || 'user',
}));

// Chỉ các endpoint cần thiết để thiết lập/xác thực mới public.
// Các API gửi tin, webhook, debug và reset mật khẩu đều yêu cầu session.
export const publicRoutes = [
  '/',
  '/admin-login',
  '/api/login',
  '/api/logout',
  '/api/check-auth',
  '/api/health',
  '/favicon.ico',
  '/ws',
];

export const isPublicRoute = (requestPath) => publicRoutes.includes(requestPath);
