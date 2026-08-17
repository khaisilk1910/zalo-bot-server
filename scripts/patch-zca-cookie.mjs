import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packagePath = path.join(root, 'node_modules', 'zca-js', 'package.json');
const utilsPath = path.join(root, 'node_modules', 'zca-js', 'dist', 'utils.js');

function parseVersion(value) {
  return String(value || '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
    .slice(0, 3);
}

function versionAtLeast(value, minimum) {
  const left = parseVersion(value);
  const right = parseVersion(minimum);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return true;
    if ((left[i] || 0) < (right[i] || 0)) return false;
  }
  return true;
}

if (!fs.existsSync(packagePath) || !fs.existsSync(utilsPath)) {
  throw new Error('[zca-cookie-patch] Không tìm thấy zca-js đã cài đặt.');
}

const packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = packageInfo.version || 'unknown';

// Upstream fixed this in zca-js 2.1.2 (PR #297). Keep the patch only for
// older pinned versions so a future dependency upgrade does not get modified.
if (versionAtLeast(version, '2.1.2')) {
  console.log(`[zca-cookie-patch] zca-js ${version} đã có bản sửa getSetCookie upstream; bỏ qua.`);
  process.exit(0);
}

let source = fs.readFileSync(utilsPath, 'utf8');

if (source.includes('typeof response.headers.getSetCookie === "function"') ||
    source.includes("typeof response.headers.getSetCookie === 'function'")) {
  console.log(`[zca-cookie-patch] zca-js ${version} đã được vá; bỏ qua.`);
  process.exit(0);
}

const oldPattern = /(const setCookieRaw = response\.headers\.get\(["']set-cookie["']\);\s*if \(setCookieRaw && !raw\) \{\s*)const splitCookies = setCookieRaw\.split\(["'], ["']\);\s*for \(const cookie of splitCookies\) \{/m;

if (!oldPattern.test(source)) {
  throw new Error(`[zca-cookie-patch] Không tìm thấy đoạn parse Set-Cookie mong đợi trong zca-js ${version}; dừng để tránh build một image chưa được vá.`);
}

source = source.replace(
  oldPattern,
  `$1// Backport upstream zca-js PR #297 / v2.1.2.\n        // Splitting on ", " corrupts Expires=Wed, ... and can drop zpsid/zpw_sek.\n        let cookieStrings;\n        if (typeof response.headers.getSetCookie === "function") {\n            cookieStrings = response.headers.getSetCookie();\n        } else {\n            cookieStrings = setCookieRaw.split(", ");\n        }\n        for (const cookie of cookieStrings) {`
);

fs.writeFileSync(utilsPath, source, 'utf8');
console.log(`[zca-cookie-patch] Đã backport bản sửa Set-Cookie cho zca-js ${version}.`);
