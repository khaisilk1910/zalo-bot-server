import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileAtomicSync(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, content, { encoding, mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export function writeJsonAtomicSync(filePath, value, spaces = 2) {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, spaces)}\n`);
}
