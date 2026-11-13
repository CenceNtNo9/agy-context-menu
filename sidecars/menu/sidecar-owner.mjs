import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function defaultIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isValidRecord(record) {
  return Boolean(
    record &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      Number.isFinite(record.startedAt) &&
      typeof record.token === 'string'
  );
}

function isNewerRecord(a, b) {
  return a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.token > b.token);
}

/**
 * Coordinates single active sidecar ownership in dataDir so newer Antigravity-spawned
 * instances cleanly supersede older or standalone instances without PID conflicts.
 */
export class SidecarOwner {
  constructor(
    dataDir,
    {
      pid = process.pid,
      startedAt = Math.floor(Date.now() - process.uptime() * 1000),
      token = randomUUID(),
      interval = 2000,
      isAlive = defaultIsAlive,
    } = {}
  ) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'active-sidecar.json');
    this.pid = pid;
    this.startedAt = startedAt;
    this.token = token;
    this.interval = interval;
    this.isAlive = isAlive;
    this.running = false;
    this.timer = null;
  }

  async read() {
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  async isOwner() {
    if (!this.running) return false;
    try {
      const record = await this.read();
      return record.pid === this.pid && record.token === this.token;
    } catch {
      return false;
    }
  }

  async claim() {
    mkdirSync(this.dataDir, { recursive: true });
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + 5000;

    for (;;) {
      try {
        writeFileSync(lockFile, JSON.stringify({ pid: this.pid, token: this.token }), {
          flag: 'wx',
          mode: 0o600,
        });
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          let lockRecord;
          try {
            lockRecord = JSON.parse(readFileSync(lockFile, 'utf8'));
          } catch {
            lockRecord = null;
          }
          const stale = lockRecord?.pid
            ? !this.isAlive(lockRecord.pid)
            : Date.now() - statSync(lockFile).mtimeMs > 10000;
          if (stale) {
            unlinkSync(lockFile);
            continue;
          }
        } catch (innerErr) {
          if (innerErr?.code === 'ENOENT') continue;
          throw innerErr;
        }
        if (Date.now() > deadline) {
          throw new Error('Sidecar ownership claim timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    const tempFile = `${this.file}.${this.token}.tmp`;
    try {
      const candidate = { pid: this.pid, startedAt: this.startedAt, token: this.token };
      try {
        const prior = JSON.parse(readFileSync(this.file, 'utf8'));
        if (isValidRecord(prior) && isNewerRecord(prior, candidate) && this.isAlive(prior.pid)) {
          return false;
        }
      } catch (err) {
        if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      }
      writeFileSync(tempFile, JSON.stringify(candidate) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(tempFile, this.file);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        if (JSON.parse(readFileSync(lockFile, 'utf8')).token === this.token) {
          unlinkSync(lockFile);
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }

    this.running = true;
    return this.isOwner();
  }

  watch(onLost) {
    let checking = false;
    this.timer = setInterval(async () => {
      if (checking || !this.running) return;
      checking = true;
      try {
        if (!(await this.isOwner())) {
          this.stop();
          await onLost();
        }
      } finally {
        checking = false;
      }
    }, this.interval);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
