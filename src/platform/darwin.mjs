import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsyncDefault = promisify(nodeExecFile);

const JXA_COPY_FILE_SCRIPT = [
  'ObjC.import("AppKit");',
  'ObjC.import("Foundation");',
  'ObjC.import("stdlib");',
  'const rawPath = $.getenv("AGY_CLIP_FILE");',
  'if (!rawPath) {',
  '  throw new Error("Missing AGY_CLIP_FILE environment variable");',
  '}',
  'const filePath = ObjC.unwrap(rawPath);',
  'const fileUrl = $.NSURL.fileURLWithPath(filePath);',
  'const pasteboard = $.NSPasteboard.generalPasteboard;',
  'pasteboard.clearContents;',
  'const written = pasteboard.writeObjects($.NSArray.arrayWithObject(fileUrl));',
  'if (!written) {',
  '  throw new Error("NSPasteboard.writeObjects failed");',
  '}',
].join('\n');

function invokeExecFile(execFileImpl, file, args, options = {}) {
  if (execFileImpl === nodeExecFile) {
    return execFileAsyncDefault(file, args, options);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const callback = (err, stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };

    try {
      const maybePromise = execFileImpl(file, args, options, callback);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          (value) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          },
        );
      } else if (maybePromise !== undefined && !settled) {
        settled = true;
        resolve(maybePromise);
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function spawnDetachedEditor(spawnImpl, command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (!child || typeof child.once !== 'function') {
      child?.unref?.();
      resolve();
      return;
    }

    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref?.();
      resolve();
    };

    const onError = (err) => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };

    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function writeToPbcopy(spawnImpl, text) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('/usr/bin/pbcopy', [], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stderrChunks = [];
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
    }

    let settled = false;
    const finish = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    if (typeof child.once === 'function') {
      child.once('error', finish);
      child.once('close', (code) => {
        if (code === 0) {
          finish();
        } else {
          const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
          finish(
            new Error(
              `pbcopy exited with code ${code}${stderrText ? `: ${stderrText}` : ''}`,
            ),
          );
        }
      });
    }

    const payload = Buffer.from(text, 'utf8');
    if (child.stdin && typeof child.stdin.end === 'function') {
      child.stdin.end(payload);
    } else if (typeof child.once !== 'function') {
      finish();
    }
  });
}

/**
 * macOS platform adapter using `/usr/bin/open`, JXA `NSPasteboard`, and `/usr/bin/pbcopy`.
 */
export class DarwinAdapter {
  constructor(options = {}) {
    this.execFileImpl = options.execFileImpl || nodeExecFile;
    this.spawnImpl = options.spawnImpl || nodeSpawn;
    this.baseEnv = options.env || process.env;
    this.mode = 'darwin_native';
    this.degradeReason = null;
  }

  async revealInFolder(targetPath) {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('revealInFolder requires a non-empty targetPath.');
    }
    await invokeExecFile(this.execFileImpl, '/usr/bin/open', ['-R', targetPath]);
    return { ok: true, method: 'darwin_open_reveal' };
  }

  async openDefault(targetPath) {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('openDefault requires a non-empty targetPath.');
    }
    await invokeExecFile(this.execFileImpl, '/usr/bin/open', [targetPath]);
    return { ok: true, method: 'darwin_open' };
  }

  async openDirectory(dirPath) {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      throw new Error('openDirectory requires a non-empty dirPath.');
    }
    await invokeExecFile(this.execFileImpl, '/usr/bin/open', [dirPath]);
    return { ok: true, method: 'darwin_open' };
  }

  async openInEditor({ filePath, editorCommand, editorArgs } = {}) {
    const command = editorCommand || '/usr/bin/open';
    const args = Array.isArray(editorArgs)
      ? editorArgs.map(String)
      : filePath
        ? ['-t', String(filePath)]
        : [];

    await spawnDetachedEditor(this.spawnImpl, command, args);
    return { ok: true, method: 'spawn_editor', editor: command };
  }

  async copyFileEntity(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('copyFileEntity requires a non-empty filePath.');
    }

    await invokeExecFile(
      this.execFileImpl,
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', JXA_COPY_FILE_SCRIPT],
      {
        env: {
          ...this.baseEnv,
          AGY_CLIP_FILE: filePath,
        },
      },
    );

    return { ok: true, format: 'NSPasteboard_NSURL' };
  }

  async copyText(text) {
    if (typeof text !== 'string') {
      throw new Error('copyText requires a string.');
    }

    await writeToPbcopy(this.spawnImpl, text);
    return { ok: true, format: 'pbcopy_utf8' };
  }
}

export function createDarwinAdapter(options = {}) {
  return new DarwinAdapter(options);
}
