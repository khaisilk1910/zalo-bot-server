# Zalo Bot Server

Zalo Bot Server là server Node.js trung gian cho phép đăng nhập và điều khiển tài khoản Zalo thông qua `zca-js`, cung cấp Web UI, REST API, WebSocket, webhook và backend cho integration **Zalo Bot for Home Assistant**.

> Phiên bản tài liệu này dành cho **Zalo Bot Server v1.1.0** (`zca-js` 2.1.2).
>
> Nguồn đối chiếu `zca-js`: repository upstream `RFS-ADRENO/zca-js`, release/tag chính thức của dự án và package `zca-js` trên npm. Lưu ý chính upstream xác nhận đây là API Zalo cá nhân **không chính thức của Zalo**, hoạt động bằng cách mô phỏng Zalo Web.

## Tính năng chính

- Đăng nhập nhiều tài khoản Zalo bằng QR và lưu credential bền vững.
- Tự reconnect khi listener bị ngắt với retry/backoff, không xóa cookie chỉ vì timeout mạng.
- Giữ IMEI, User-Agent và proxy của từng tài khoản khi reconnect.
- Gửi tin nhắn, ảnh, nhiều ảnh, file, voice, video, sticker, card và link.
- Thu hồi/xóa/chuyển tiếp tin nhắn, reaction và typing event.
- Quản lý bạn bè, lời mời kết bạn, alias, block/unblock và trạng thái online.
- Quản lý nhóm, thành viên, phó nhóm, chủ nhóm, link nhóm, avatar/tên nhóm, note, poll và reminder.
- Quản lý Auto Delete của cuộc trò chuyện với các mức Zalo hỗ trợ: `off`, `1d`, `7d`, `14d`.
- Lấy lịch sử nhóm qua API Zalo khi khả dụng, có compatibility fallback `getrecentv2` và cache listener local bền vững.
- Quản lý quick message, label, unread, mute, pin, archive và hidden conversation.
- Webhook riêng cho message, group event và reaction; hỗ trợ cấu hình mặc định hoặc theo từng tài khoản.
- Quản lý proxy và gán proxy ổn định cho tài khoản.
- Web UI quản trị, API docs và WebSocket realtime.
- Session quản trị và dữ liệu runtime được lưu trong data volume để tồn tại qua restart/recreate container.
- Health endpoint và Docker healthcheck.

## Yêu cầu

- Docker được khuyến nghị cho môi trường production.
- Nếu chạy trực tiếp: Node.js 22 LTS.
- Có kết nối mạng tới Zalo.
- Với Home Assistant integration: Home Assistant phải truy cập được URL của Zalo Server.

## Chạy bằng Docker Compose / Stack

Ví dụ:

```yaml
services:
  zalobot:
    image: ghcr.io/khaisilk1910/zalo-bot-server:latest
    container_name: zalo-server
    restart: unless-stopped
    network_mode: host

    environment:
      - TZ=Asia/Ho_Chi_Minh
      - PORT=3000

    volumes:
      - /opt/home-assistant/config/zalo-server:/app/data
      - /opt/home-assistant/config/www/zalo-server:/config/www/zalo_bot
```

Có thể đổi port bằng biến môi trường, ví dụ:

```yaml
- PORT=3100
```

Vì Stack trên dùng `network_mode: host`, không cần khai báo `ports:`.

## Truy cập

Nếu chạy port `3000`:

```text
http://IP_SERVER:3000
```

Nếu đổi thành `3100`:

```text
http://IP_SERVER:3100
```

Các đường dẫn chính:

- `/` — trang quản trị.
- `/admin-login` — đăng nhập quản trị.
- `/zalo-login` — đăng nhập tài khoản Zalo bằng QR.
- `/accounts` — danh sách tài khoản Zalo đang quản lý.
- `/messages` — giao diện message.
- `/proxies` — quản lý proxy.
- `/account-webhook-manager` — webhook theo tài khoản.
- `/user-management` — quản lý user server.
- `/list` — tài liệu API.
- `/ws` — WebSocket realtime, yêu cầu session đã xác thực.
- `/api/health` — health check nhẹ, không yêu cầu đăng nhập.

## Đăng nhập quản trị lần đầu

Nếu chưa có dữ liệu user, server sẽ tạo tài khoản mặc định:

```text
Username: admin
Password: admin
```

**Hãy đổi mật khẩu ngay sau lần đăng nhập đầu tiên.** Mật khẩu mới phải có ít nhất 8 ký tự.

Server lưu user tại data directory và sử dụng PBKDF2-SHA512 cho password hash mới. Password hash cũ sẽ được nâng cấp khi người dùng đăng nhập thành công.

## Biến môi trường

Các biến thông dụng:

| Biến | Mặc định | Mô tả |
|---|---:|---|
| `PORT` | `3000` | Port HTTP/WebSocket của server. |
| `TZ` | hệ thống | Múi giờ, khuyến nghị `Asia/Ho_Chi_Minh`. |
| `DATA_DIRECTORY` | tùy môi trường | Thư mục dữ liệu runtime; Docker entrypoint dùng `/app/data`. |
| `PUBLIC_DIR` | `/config/www/zalo_bot` | Thư mục file public dùng khi gửi media local. |
| `SESSION_SECRET` | tự tạo | Secret session. Nếu bỏ trống, server tự tạo và lưu bền vững trong data directory. |
| `SESSION_COOKIE_SECURE` | `false` | Đặt `true` khi dùng HTTPS đúng cách. |
| `TRUST_PROXY` | `false` | Bật khi server đứng sau reverse proxy đáng tin cậy. |
| `MESSAGE_WEBHOOK_URL` | rỗng | Webhook message mặc định. |
| `GROUP_EVENT_WEBHOOK_URL` | rỗng | Webhook group event mặc định. |
| `REACTION_WEBHOOK_URL` | rỗng | Webhook reaction mặc định. |
| `DEBUG_HTTP` | `false` | Log HTTP chi tiết khi debug. |
| `DEBUG_STARTUP` | `false` | Log startup chi tiết khi debug. |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Bật endpoint debug quản trị. Không nên bật thường xuyên. |
| `ENABLE_ADMIN_PASSWORD_RESET` | `false` | Bật endpoint reset password quản trị có kiểm soát. |

File mẫu nằm tại:

```text
config/.env.example
```

## Dữ liệu bền vững

Với Docker stack ở trên, `/app/data` được lưu trên host tại:

```text
/opt/home-assistant/config/zalo-server
```

Các dữ liệu quan trọng gồm:

```text
/app/data/
├── cookies/                 # credential Zalo + users.json
├── history/groups/          # cache lịch sử nhóm
├── sessions/                # session quản trị
├── proxies.json             # danh sách proxy
├── webhook-config.json      # webhook mặc định/theo account
└── session-secret           # secret session nếu tự sinh
```

Không đưa các file runtime này lên GitHub public.

## Đăng nhập Zalo và reconnect

Sau khi quét QR, credential được lưu dưới data directory. Khi listener bị đóng:

1. Server giữ nguyên cookie/credential.
2. Chờ theo backoff: khoảng `5s → 15s → 30s → 60s → 120s → 300s`.
3. Thử login lại bằng cookie, IMEI, User-Agent và proxy đã lưu.
4. Reconnect tự động **không bật QR fallback**.
5. Chỉ khi session Zalo thực sự bị vô hiệu hóa mới cần quét QR lại.

Để giảm nguy cơ session bị đá, tránh mở cùng account trên Zalo Web trong khi bot listener đang chạy nếu không cần thiết.

## Gửi nhiều ảnh

Từ v1.0.5+, mỗi ảnh được tải vào một file tạm riêng bằng UUID. Điều này tránh lỗi trước đây khiến ảnh cuối cùng trong danh sách bị gửi lặp lại nhiều lần.

Server giữ đúng thứ tự attachment và dọn file tạm sau khi hoàn tất request.

## Auto Delete / TTL

Zalo hiện không thực thi ổn định TTL riêng trên từng `sendMessage()`. Vì vậy server ánh xạ tùy chọn TTL sang **Auto Delete của cả cuộc trò chuyện**.

Các giá trị được hỗ trợ:

```text
off / 0
1d  / 86400000
7d  / 604800000
14d / 1209600000
```

Nếu request không có `ttl`, server không thay đổi cài đặt Auto Delete hiện tại của cuộc trò chuyện.

## Lịch sử nhóm

Endpoint:

```text
POST /api/getGroupChatHistoryByAccount
```

Server dùng ba tầng để giảm lỗi khi Zalo thay đổi endpoint:

1. Gọi `getGroupChatHistory()` của `zca-js` 2.1.2.
2. Nếu endpoint cũ của Zalo không còn hoạt động, dùng compatibility fallback `group_cloud_message/api/cm/getrecentv2` theo hướng sửa đang được thảo luận upstream, có phân trang và deduplicate `msgId`.
3. Nếu cả hai request online đều lỗi, trả cache listener local từ:

```text
/app/data/history/groups/<account_id>/<group_id>.jsonl
```

Response có trường `source` để biết dữ liệu đến từ `zca-js-2.1.2`, `zca-js-getrecentv2-compat` hay `local-cache`.

Lưu ý:

- Cache local chỉ có dữ liệu từ thời điểm server bắt đầu ghi history.
- Compatibility fallback được giữ riêng trong server, không sửa file trong `node_modules`; khi zca-js phát hành fix chính thức thì API chính thức vẫn được ưu tiên.
- Cache được giữ qua restart/recreate container nếu `/app/data` được persist.
- Server tự deduplicate và giới hạn/compact history để tránh file tăng không giới hạn.

## Webhook

Server hỗ trợ ba loại webhook:

- Message.
- Group event.
- Reaction.

Có thể cấu hình URL mặc định bằng environment hoặc cấu hình riêng theo từng account trong Web UI/API.

Các API quản lý webhook theo account:

```text
GET    /api/account-webhooks
GET    /api/account-webhook/:ownId
POST   /api/account-webhook
DELETE /api/account-webhook/:ownId
```

Webhook request có timeout để tránh request treo làm ảnh hưởng listener.

## Proxy

Có thể quản lý proxy từ Web UI hoặc API. Proxy được lưu trong:

```text
/app/data/proxies.json
```

Khi account đã đăng nhập bằng một proxy, server cố gắng giữ cùng proxy cho các lần restart/reconnect sau thay vì tự đổi IP không cần thiết.

## API

REST API được mount dưới:

```text
/api
```

`/api/health` và `/api/login` là các endpoint phục vụ health/auth; các API thao tác còn lại sử dụng session đã xác thực.

### Các nhóm API chính

Các endpoint mới/được đồng bộ với `zca-js` 2.1.2 gồm: tìm user theo username, avatar/full avatar, tìm nhiều số điện thoại, close friends, friend online/request status/reject request, history nhóm, invite-box/pending/blocked member, link detail, poll vote/share/add options, search sticker/category detail, archive conversation, profile bio, account settings/active status và upgrade group to community.

- **Account:** danh sách account, chi tiết account, avatar, profile, bio, settings, active status, last online.
- **Message/media:** text, image, multiple images, file, voice, video, sticker, card, link, typing, reaction, undo/delete/forward.
- **Friends/users:** tìm user, thông tin user, lời mời kết bạn, friends, alias, block/unblock.
- **Groups:** tạo nhóm, thành viên, deputy/owner, link nhóm, avatar/name, leave/join/disperse.
- **Conversation:** unread, mute, pin, archive, hidden conversation, Auto Delete.
- **Notes/polls/reminders:** note nhóm, board, poll, reminder.
- **Quick Message/Labels:** tạo, sửa, xóa, đọc quick message và labels.
- **Webhook/Proxy:** cấu hình webhook và proxy.

Ví dụ đăng nhập API:

```bash
curl -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' \
  http://127.0.0.1:3000/api/login
```

Sau đó gọi API cần session:

```bash
curl -b cookies.txt http://127.0.0.1:3000/api/accounts
```

Health check:

```bash
curl http://127.0.0.1:3000/api/health
```

## Home Assistant

Repo Home Assistant/HACS tương ứng:

```text
https://github.com/khaisilk1910/zalo-bot-hacs
```

Khuyến nghị sử dụng HACS integration cùng thế hệ release tương thích với server v1.1.x.

Đối với media local, Home Assistant integration ghi file tạm/public ở:

```text
/config/www/zalo-server
```

và Zalo Server đọc cùng dữ liệu host thông qua đường dẫn container:

```text
/config/www/zalo_bot
```

## Healthcheck

Docker image có healthcheck mặc định tới:

```text
/api/health
```

Có thể kiểm tra trạng thái container bằng:

```bash
docker inspect --format='{{.State.Health.Status}}' zalo-server
```

## Build từ source

```bash
npm ci
npm start
```

`npm start` chạy:

```text
node server.js
```

## Cấu trúc source

```text
.
├── api/zalo/               # wrapper/API Zalo
├── config/                 # cấu hình runtime
├── routes/                 # HTTP UI + REST API
├── services/               # auth, session, proxy, webhook, websocket
├── utils/                  # helpers, history, atomic write, auto-delete
├── views/                  # EJS Web UI
├── app.js                  # Express app
├── server.js               # HTTP/WebSocket server
├── eventListeners.js       # listener/reconnect/event dispatch
├── Dockerfile
├── entrypoint.sh
├── package.json
└── CHANGELOG.md
```

## Update release

Sau khi cập nhật source:

```bash
git pull --rebase origin main
git add .
git commit -m "Update Zalo Bot Server"
git push origin main
```

Tạo release mới, ví dụ:

```bash
git tag -a v1.0.7 -m "Zalo Bot Server v1.0.7"
git push origin v1.0.7
```

Nếu GitHub Actions được cấu hình publish GHCR theo tag, image mới sẽ có dạng:

```text
ghcr.io/khaisilk1910/zalo-bot-server:v1.0.7
```

## Bảo mật

- Đổi `admin/admin` ngay sau lần đăng nhập đầu tiên.
- Không commit `/app/data`, cookies, `users.json`, webhook URL hoặc session data lên Git.
- Không bật `ENABLE_DEBUG_ENDPOINTS` hoặc `ENABLE_ADMIN_PASSWORD_RESET` khi không cần.
- Nếu expose ra Internet, đặt server sau HTTPS reverse proxy, giới hạn firewall/IP và cấu hình `TRUST_PROXY`/secure cookie phù hợp.
- Đây là dự án sử dụng API Zalo không chính thức; hành vi có thể thay đổi khi Zalo cập nhật hệ thống.

## License / trách nhiệm sử dụng

Dự án không phải sản phẩm chính thức của Zalo. Người dùng chịu trách nhiệm sử dụng tài khoản, API, proxy và dữ liệu theo các điều khoản áp dụng.
