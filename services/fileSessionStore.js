import session from 'express-session';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function sessionFilename(sid) {
  return `${crypto.createHash('sha256').update(String(sid)).digest('hex')}.json`;
}

function isExpired(sess) {
  const expires = sess?.cookie?.expires;
  return expires ? new Date(expires).getTime() <= Date.now() : false;
}

export class FileSessionStore extends session.Store {
  constructor({ dir, cleanupIntervalMs = 60 * 60 * 1000 }) {
    super();
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupIntervalMs);
    this._cleanupTimer.unref?.();
    queueMicrotask(() => this.cleanupExpired());
  }

  cleanupExpired() {
    fs.readdir(this.dir, { withFileTypes: true }, (readError, entries) => {
      if (readError) return;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(this.dir, entry.name);
        fs.readFile(file, 'utf8', (fileError, data) => {
          if (fileError) return;
          try {
            const sess = JSON.parse(data);
            if (isExpired(sess)) fs.unlink(file, () => {});
          } catch {
            fs.unlink(file, () => {});
          }
        });
      }
    });
  }

  close() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }

  _file(sid) {
    return path.join(this.dir, sessionFilename(sid));
  }

  get(sid, callback) {
    fs.readFile(this._file(sid), 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') return callback(null, null);
        return callback(err);
      }

      try {
        const sess = JSON.parse(data);
        if (isExpired(sess)) {
          return this.destroy(sid, () => callback(null, null));
        }
        callback(null, sess);
      } catch (parseError) {
        this.destroy(sid, () => callback(parseError));
      }
    });
  }

  set(sid, sess, callback = () => {}) {
    const file = this._file(sid);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFile(temp, JSON.stringify(sess), { encoding: 'utf8', mode: 0o600 }, (err) => {
      if (err) return callback(err);
      fs.rename(temp, file, (renameErr) => {
        if (renameErr) {
          fs.unlink(temp, () => callback(renameErr));
          return;
        }
        callback(null);
      });
    });
  }

  destroy(sid, callback = () => {}) {
    fs.unlink(this._file(sid), (err) => {
      if (err && err.code !== 'ENOENT') return callback(err);
      callback(null);
    });
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }
}
