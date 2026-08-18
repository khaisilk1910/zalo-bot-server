# Changelog

## v1.1.0

- Nâng dependency ổn định từ `zca-js 2.0.4` lên **`zca-js 2.1.2`** và pin chính xác version để tránh thay đổi ngoài ý muốn.
- Loại bỏ postinstall patch chỉnh trực tiếp `node_modules`; luồng QR direct dùng native fetch Node 22, còn proxy bridge `node-fetch` `headers.raw()` sang `getSetCookie()` đúng contract mà zca-js 2.1.2 dùng.
- Đồng bộ chữ ký API v2: `updateProfile({ profile, biz })`, `ThreadType` 0/1 và `joinGroupLink()` thay cho method `joinGroup()` không tồn tại.
- Thêm AvatarSize cho `findUser`, `getUserInfo`, `getAllFriends`; thêm `findUserByUsername`, `getAvatarUrlProfile`, `getFullAvatar`, `getCloseFriends`, `getMultiUsersByPhones`.
- Thêm friend APIs: `rejectFriendRequest`, `getFriendOnlines`, `getFriendRequestStatus`.
- Thêm group APIs: invite-box, blocked/pending member, review pending request, group link detail, related friend group và upgrade community.
- Thêm poll APIs `addPollOptions`, `sharePoll`, `votePoll`; thêm sticker search/category detail; archive conversation; profile bio; settings/active status và biz account.
- `getGroupChatHistoryByAccount` dùng 3 tầng: API chính thức 2.1.2 -> compatibility `getrecentv2` theo upstream PR #370 -> persistent listener cache. Compatibility code không sửa `node_modules`.
- Giữ thứ tự gửi nhiều ảnh bằng file tạm UUID riêng; tận dụng thêm bản sửa attachment-order của zca-js 2.1.x.
- Siết validation `count/page`, Gender, ngày sinh, poll, `UpdateSettingsType`/status và typing `destType` để lỗi input trả về sớm thay vì nổ trong SDK.
- Khi `getGroupChatHistory()` của 2.1.2 trả 404, ghi nhớ trên API session hiện tại để các lần history sau bỏ qua request endpoint cũ và đi thẳng compatibility fallback; session mới sẽ thử lại API chính thức.
- Rà soát toàn bộ `account.api.*`: mọi method server đang gọi đều tồn tại trong API class của tag zca-js v2.1.2.

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

## 1.0.4
- Add `getReceivedFriendRequestsByAccount` by filtering Zalo friend recommendations to received friend requests (`recommType = 2`).
- Restore `getGroupChatHistoryByAccount` with a persistent local group-message history cache because Zalo removed the upstream `/api/group/history` endpoint.
- Store group history under `DATA_DIRECTORY/history/groups`, surviving Docker restarts through the existing `/app/data` volume.
- Enable `selfListen` only to capture self-sent group messages into history while preserving previous webhook/WebSocket behavior for external consumers.
- Pin `zca-js` to `2.0.4` to avoid unexpected behavior changes from the previous `latest` dependency specifier.

## v1.0.5
- Sửa lỗi gửi nhiều ảnh bị lặp ảnh cuối: mỗi ảnh tải về file tạm UUID riêng, giữ thứ tự attachment và dọn file sau khi gửi.
- Giới hạn concurrency tải ảnh và thêm timeout/kích thước tối đa cho file/ảnh từ URL.

## v1.0.6
- Loại bỏ Axios; dùng chung `node-fetch` cho webhook và tải ảnh để giảm dependency/security surface.
- Tách WebSocket hub và reconnect dependency để loại circular imports; thêm heartbeat, giới hạn payload/buffer và graceful shutdown.
- Sửa race condition trong persistent group-history cache; batch write, dedupe và compact cache có giới hạn.
- Sửa theo dõi proxy/account assignment sau reconnect và không log credential proxy.
- Thêm `/api/health` nhẹ; phục hồi account đồng thời có giới hạn khi startup.
- Bổ sung đầy đủ 4 API quản lý webhook theo account mà UI/HACS sử dụng; ghi config atomic.
- Session Express dùng persistent file store, `resave=false`, `saveUninitialized=false`; secret được tạo/lưu bền vững nếu không cấu hình qua env.
- Vô hiệu hóa mặc định các debug/reset-admin endpoint; chỉ bật bằng biến môi trường riêng.
- Password mới dùng PBKDF2-SHA512 220k iterations; tự nâng hash legacy khi login.
- I/O webhook/download có timeout và giới hạn kích thước; image metadata chuyển sang async API.
- Shared transient image/file responses dùng `Cache-Control: no-store` để tránh ảnh cũ bị cache sau các lần gửi liên tiếp.
- Pin `zca-js=2.0.4` và `ws=8.21.1`; loại Axios cùng các dependency không dùng `sharp`, `qrcode`, `cookie-parser`.
- Docker image nhẹ hơn: bỏ compiler toolchain, thêm `.dockerignore` và container healthcheck.
- Chuyển Docker runtime từ Node.js 20 sang Node.js 22 LTS để tiếp tục nhận bản vá bảo mật và hỗ trợ runtime dài hạn.
- Sửa `npm start` trỏ đúng `server.js`, giảm log startup nhạy cảm; chỉ dump chi tiết khi `DEBUG_STARTUP=true`.
