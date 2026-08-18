import express from 'express';
import { zaloAccounts, loginZaloAccount } from '../api/zalo/zalo.js';
import { proxyService } from '../services/proxyService.js';
import { setDefaultWebhookUrls } from '../services/webhookService.js';

const router = express.Router();

// Route đăng nhập quản trị
router.get('/admin-login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  return res.render('admin-login');
});

// Thêm thông tin session vào trang chủ
router.get('/', (req, res) => {
    let authenticated = false;
    let username = '';
    let isAdmin = false;

    if (req.session && req.session.authenticated) {
      authenticated = true;
      username = req.session.username;
      isAdmin = req.session.role === 'admin';
    }

    res.render('index', {
      authenticated: authenticated,
      username: username,
      isAdmin: isAdmin
    });
});

// Hiển thị form đăng nhập
router.get('/zalo-login', (req, res) => {
    res.render('improved-login');
});

// Xử lý đăng nhập: sử dụng proxy do người dùng nhập nếu hợp lệ, nếu không sẽ sử dụng proxy mặc định
router.post('/zalo-login', async (req, res) => {
    try {
        const { proxy } = req.body;
        console.log('Đang tạo mã QR', proxy ? 'với proxy đã cấu hình' : 'không qua proxy');

        const qrCodeImage = await loginZaloAccount(proxy, null);
        console.log('Đã tạo mã QR thành công, độ dài:', qrCodeImage ? qrCodeImage.length : 0);

        res.json({ success: true, qrCodeImage });
    } catch (error) {
        console.error('Lỗi khi tạo mã QR:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Hiển thị form cập nhật webhook URL
router.get('/updateWebhookForm', (req, res) => {
    res.render('updateWebhookForm');
});

// Endpoint hiển thị tài liệu API
router.get('/list', (req, res) => {
    // Tự nhận protocol/host/port hiện tại, kể cả khi chạy sau reverse proxy.
    const forwardedProto = req.get('x-forwarded-proto');
    const forwardedHost = req.get('x-forwarded-host');
    const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    const host = forwardedHost ? forwardedHost.split(',')[0].trim() : req.get('host');
    const baseUrl = `${protocol}://${host}`;

    res.render('api-doc', { baseUrl });
});

// Trang quản lý tài khoản. Giữ JSON response khi client cũ yêu cầu application/json.
router.get('/accounts', (req, res) => {
    const accounts = zaloAccounts.map(account => ({
        ownId: account.ownId,
        proxy: account.proxy,
        phoneNumber: account.phoneNumber || 'N/A',
        isOnline: !!account.api,
    }));
    const acceptHeader = req.headers.accept || '';
    if (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) {
        return res.json({ success: true, accounts, data: accounts, total: accounts.length });
    }
    return res.render('accounts');
});

// Endpoint cập nhật 3 webhook URL
router.post('/updateWebhook', (req, res) => {
  const { messageWebhookUrl, groupEventWebhookUrl, reactionWebhookUrl } = req.body || {};
  const values = { messageWebhookUrl, groupEventWebhookUrl, reactionWebhookUrl };

  for (const [key, value] of Object.entries(values)) {
    try {
      const parsed = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      return res.status(400).json({ success: false, error: `${key} không hợp lệ` });
    }
  }

  if (!setDefaultWebhookUrls(values)) {
    return res.status(500).json({ success: false, error: 'Không thể lưu cấu hình webhook' });
  }
  return res.json({ success: true, message: 'Webhook URLs đã được cập nhật' });
});

// Trang quản lý proxy. API CRUD mới nằm tại /api/proxies.
router.get('/proxies', (req, res) => {
  const acceptHeader = req.headers.accept || '';
  if (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) {
    return res.json({ success: true, data: proxyService.getPROXIES() });
  }
  return res.render('proxies');
});

// Legacy root CRUD endpoints retained for backward compatibility.
router.post('/proxies', (req, res) => {
  const proxyUrl = String(req.body?.proxyUrl || '').trim();
  if (!proxyUrl) return res.status(400).json({ success: false, error: 'proxyUrl không hợp lệ' });
  try {
    const proxy = proxyService.addProxy(proxyUrl);
    return res.json({ success: true, data: { url: proxy.url, accounts: [...proxy.accountIds], usedCount: proxy.accountIds.size } });
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

router.get('/login', (_req, res) => res.redirect(302, './zalo-login'));
router.get('/webhooks', (_req, res) => res.redirect(302, './account-webhook-manager'));

// Route test session
router.get('/session-test', (req, res) => {
    if (process.env.ENABLE_DEBUG_ENDPOINTS !== 'true') return res.status(404).send('Not found');
    res.render('session-test');
});

// Route quản lý người dùng
router.get('/user-management', (req, res) => {
  // Kiểm tra xem người dùng đã đăng nhập và có quyền admin chưa
  if (!req.session || !req.session.authenticated || req.session.role !== 'admin') {
    return res.redirect('/admin-login');
  }

  res.render('user-management');
});

// Hiển thị trang quản lý webhook theo tài khoản
router.get('/account-webhook-manager', (req, res) => {
    res.render('account-webhook-manager');
});

// Hiển thị trang đổi mật khẩu
router.get('/change-password', (req, res) => {
    // Kiểm tra xem người dùng đã đăng nhập chưa
    if (!req.session || !req.session.authenticated) {
        return res.redirect('/admin-login');
    }

    res.render('change-password');
});

// Hiển thị trang reset mật khẩu admin
router.get('/reset-password', (req, res) => {
    if (process.env.ENABLE_ADMIN_PASSWORD_RESET !== 'true') return res.status(404).send('Not found');
    if (!req.session?.authenticated || req.session.role !== 'admin') return res.status(403).send('Chỉ admin mới có thể truy cập.');
    return res.render('reset-password');
});

// Route hiển thị tin nhắn và thread_id
router.get('/messages', (req, res) => {
  console.log("Messages tracking page requested");
  try {
    res.render('messages');
    console.log("Rendered messages tracking page");
  } catch (error) {
    console.error("Error rendering messages page:", error);
    res.status(500).send("Lỗi khi hiển thị trang theo dõi tin nhắn");
  }
});

export default router;