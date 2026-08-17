# Changelog

## v1.0.3

- Sửa cơ chế gửi tin nhắn có `ttl`: không còn phụ thuộc vào per-message TTL đã bị Zalo vô hiệu hóa.
- Khi request có `ttl`, server dùng `updateAutoDeleteChat()` để bật/tắt Auto Delete cho cuộc trò chuyện trước khi gửi.
- Hỗ trợ TTL: `0`/`off`, `86400000`/`1d`, `604800000`/`7d`, `1209600000`/`14d`.
- Sửa `type` cho Auto Delete và sendMessage: hỗ trợ đúng cả `user`/`group` lẫn `0`/`1`.
- Cho phép `ttl=0` để tắt Auto Delete.
- Hỗ trợ TTL cho text, ảnh, nhiều ảnh và file ở cả API legacy lẫn `*ByAccount`.
- Nếu `message` object cũ có trường `ttl`, server tự chuyển sang conversation Auto Delete và bỏ `ttl` khỏi `sendMessage()` để tránh hành vi giả thành công.

## v1.0.2

- API Docs tự nhận protocol, host và port từ request hiện tại.
- Hỗ trợ `X-Forwarded-Proto` và `X-Forwarded-Host` khi chạy sau reverse proxy.
- Loại bỏ toàn bộ hard-code `http://localhost:3000` trong `views/api-doc.ejs`.
- Hiển thị Base URL hiện tại trực tiếp trên trang tài liệu API.

## v1.0.1

- Không xóa cookie/credential khi health-check timeout hoặc lỗi mạng tạm thời.
- Tự động reconnect khi Zalo listener bị đóng.
- Retry reconnect theo backoff: 5s, 15s, 30s, 60s, 120s, rồi 300s/lần.
- Auto-reconnect và startup restore không tự fallback sang QR.
- Lưu proxy cùng credential và tái sử dụng đúng proxy (hoặc giữ không-proxy) khi reconnect/restart.
- Credential cũ chưa có trường `proxy` vẫn tương thích; sau lần login thành công sẽ được nâng cấp tự động.
