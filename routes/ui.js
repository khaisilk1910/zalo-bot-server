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

// Lấy danh sách tài khoản đã đăng nhập
router.get('/accounts', (req, res) => {
    if (zaloAccounts.length === 0) {
        return res.json({ success: true, message: 'Chưa có tài khoản nào đăng nhập' });
    }

    const accounts = zaloAccounts.map(account => ({
        ownId: account.ownId,
        proxy: account.proxy,
        phoneNumber: account.phoneNumber || 'N/A',
    }));

    // Tạo bảng HTML cho các yêu cầu từ trình duyệt
    let html = '<table border="1">';
    html += '<thead><tr>';
    const headers = ['Own ID', 'Phone Number', 'Proxy'];
    headers.forEach(header => {
        html += `<th>${header}</th>`;
    });
    html += '</tr></thead><tbody>';
    accounts.forEach((account) => {
        html += '<tr>';
        html += `<td>${account.ownId}</td>`;
        html += `<td>${account.phoneNumber || 'N/A'}</td>`;
        html += `<td>${account.proxy || 'Không có'}</td>`;
        html += '</tr>';
    });
    html += '</tbody></table>';

    // Kiểm tra Accept header để quyết định định dạng trả về
    const acceptHeader = req.headers.accept || '';

    if (acceptHeader.includes('application/json')) {
        // Trả về JSON cho API calls
        return res.json({
            success: true,
            accounts: accounts,
            html: html
        });
    } else {
        // Trả về HTML cho truy cập trực tiếp từ trình duyệt
        res.send(html);
    }
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

// API quản lý proxy
// Lấy danh sách proxy hiện có
router.get('/proxies', (req, res) => {
  res.json({ success: true, data: proxyService.getPROXIES() });
});

// Thêm một proxy mới
router.post('/proxies', (req, res) => {
  const { proxyUrl } = req.body;
  if (!proxyUrl) {
      return res.status(400).json({ success: false, error: 'proxyUrl không hợp lệ' });
  }
  try {
      const newProxy = proxyService.addProxy(proxyUrl);
      res.json({ success: true, data: newProxy });
  } catch (error) {
      res.status(400).json({ success: false, error: error.message });
  }
});

// Xóa một proxy
router.delete('/proxies', (req, res) => {
  const { proxyUrl } = req.body;
  if (!proxyUrl) {
      return res.status(400).json({ success: false, error: 'proxyUrl không hợp lệ' });
  }
  try {
      proxyService.removeProxy(proxyUrl);
      res.json({ success: true, message: 'Xóa proxy thành công' });
  } catch (error) {
      res.status(500).json({ success: false, error: error.message });
  }
});

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
    res.render('reset-password');
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