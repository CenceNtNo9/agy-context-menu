import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_TARGET_DIR = join(homedir(), '.gemini', 'config', 'plugins', 'agy-context-menu');

// Sync `plugin.json` LAST so Antigravity's live plugin directory watcher only activates
// after `src/`, `node_modules/`, and `sidecars/menu/` are completely on disk.
const ROOT_FILES_BEFORE_DIRS = [
  'README.md',
  'LICENSE',
  'config.default.jsonc',
  'package.json',
  'package-lock.json',
];
const MANIFEST_FILE = 'plugin.json';

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Parse CLI arguments for the safe plugin installer.
 * @param {string[]} argv
 * @returns {{ targetDir: string, checkOnly: boolean, help: boolean }}
 */
export function parseInstallArgs(argv = process.argv.slice(2)) {
  let targetDir = DEFAULT_TARGET_DIR;
  let checkOnly = false;
  let codeOnly = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check-only') {
      checkOnly = true;
    } else if (arg === '--code-only') {
      codeOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('参数 --target 缺少目标目录路径');
      }
      targetDir = resolve(next);
      i++;
    } else if (arg.startsWith('--target=')) {
      const val = arg.slice('--target='.length).trim();
      if (!val) {
        throw new Error('参数 --target= 不能为空');
      }
      targetDir = resolve(val);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return { targetDir, checkOnly, codeOnly, help };
}

/**
 * Recursively collect all `.node` native addon files under a directory.
 * @param {string} dirPath
 * @returns {string[]}
 */
export function findNativeBinaries(dirPath) {
  if (!dirPath || !existsSync(dirPath)) {
    return [];
  }
  const results = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.node')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Probe whether any `.node` binary under `<targetDir>/node_modules` is locked by a running process.
 * Uses `openSync(binPath, 'r+')` + `closeSync` because on Windows a loaded DLL can be renamed
 * (`renameSync` succeeds) while opening for write reliably fails with `EBUSY`.
 *
 * @param {string} targetDir
 * @param {object} [deps]
 * @returns {{ ok: boolean, checked: string[], lockedPath?: string, errorCode?: string, message?: string }}
 */
export function checkNativeBinaryLocks(targetDir, { openFn = openSync, closeFn = closeSync } = {}) {
  const nodeModulesDir = join(targetDir, 'node_modules');
  const binaries = findNativeBinaries(nodeModulesDir);
  const checked = [];

  for (const binPath of binaries) {
    let fd = null;
    try {
      fd = openFn(binPath, 'r+');
      checked.push(binPath);
    } catch (err) {
      const code = err?.code || 'LOCKED';
      if (RETRYABLE_CODES.has(code)) {
        return {
          ok: false,
          checked,
          lockedPath: binPath,
          errorCode: code,
          message: [
            `检测到原生二进制文件被正在运行的进程占用 (${code}): ${binPath}`,
            '请先在 Antigravity Customizations 页面关闭「Context Menu Plus」插件开关以释放 Sidecar 进程与 DLL 文件锁，等待 1~2 秒后再重新运行本部署脚本。',
            '为防止半途写坏运行目录，本次部署已安全中止，未改动目标目录任何文件。',
          ].join('\n'),
        };
      }
      throw err;
    } finally {
      if (fd !== null && fd !== undefined) {
        try {
          closeFn(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }

  return { ok: true, checked };
}

/**
 * Run a synchronous filesystem operation with exponential backoff retries for transient AV locks.
 */
async function runWithBackoff(fn, { maxRetries = 3, baseDelayMs = 150 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (!RETRYABLE_CODES.has(err?.code) || attempt >= maxRetries) {
        throw err;
      }
      attempt++;
      await delay(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function verifyNativeBinariesMatch(sourceRoot, targetDir) {
  const srcNodeModules = join(sourceRoot, 'node_modules');
  const dstNodeModules = join(targetDir, 'node_modules');
  const srcBinaries = findNativeBinaries(srcNodeModules);
  for (const srcBin of srcBinaries) {
    const rel = relative(srcNodeModules, srcBin);
    const dstBin = join(dstNodeModules, rel);
    if (!existsSync(dstBin)) {
      return { ok: false, reason: `目标目录缺少原生依赖: ${dstBin}` };
    }
    if (sha256File(srcBin) !== sha256File(dstBin)) {
      return { ok: false, reason: `原生依赖版本已变更: ${dstBin}` };
    }
  }
  return { ok: true, verified: srcBinaries.length };
}

function stagePluginAssets({ sourceRoot, stagingDir, existsFn, includeNodeModules = true }) {
  const stagedEntries = [];
  mkdirSync(stagingDir, { recursive: true });

  for (const file of ROOT_FILES_BEFORE_DIRS) {
    const src = join(sourceRoot, file);
    if (existsFn(src)) {
      cpSync(src, join(stagingDir, file), { force: true });
      stagedEntries.push({ relPath: file, label: file });
    }
  }

  for (const dirName of ['assets', 'src']) {
    const srcDir = join(sourceRoot, dirName);
    if (existsFn(srcDir)) {
      cpSync(srcDir, join(stagingDir, dirName), { recursive: true, force: true });
      stagedEntries.push({ relPath: dirName, label: `${dirName}/` });
    }
  }

  const nodeModulesSrc = join(sourceRoot, 'node_modules');
  if (includeNodeModules && existsFn(nodeModulesSrc)) {
    cpSync(nodeModulesSrc, join(stagingDir, 'node_modules'), { recursive: true, force: true });
    stagedEntries.push({ relPath: 'node_modules', label: 'node_modules/' });
  }

  const sidecarSrc = join(sourceRoot, 'sidecars', 'menu');
  if (existsFn(sidecarSrc)) {
    const sidecarStage = join(stagingDir, 'sidecars', 'menu');
    mkdirSync(sidecarStage, { recursive: true });
    cpSync(sidecarSrc, sidecarStage, {
      recursive: true,
      force: true,
      filter: (srcPath) => {
        const normalized = srcPath.replace(/\\/g, '/');
        return !normalized.endsWith('/tests') && !normalized.includes('/tests/');
      },
    });
    const legacyPkg = join(sidecarStage, 'package.json');
    if (existsFn(legacyPkg)) {
      rmSync(legacyPkg, { force: true });
    }
    stagedEntries.push({ relPath: join('sidecars', 'menu'), label: 'sidecars/menu/' });
  }

  const manifestSrc = join(sourceRoot, MANIFEST_FILE);
  if (existsFn(manifestSrc)) {
    cpSync(manifestSrc, join(stagingDir, MANIFEST_FILE), { force: true });
    stagedEntries.push({ relPath: MANIFEST_FILE, label: MANIFEST_FILE });
  }

  return stagedEntries;
}

/**
 * Safely deploy Context Menu Plus v2.0 to `<targetDir>`.
 * 1. Performs `openSync('r+')` lock pre-check on all `.node` files before touching destination
 *    (unless `codeOnly: true` and all `.node` binaries in `<targetDir>` already match SHA-256).
 * 2. Stages all assets into an isolated `os.tmpdir()` `.staging-*` directory (outside `~/.gemini/config/plugins/`
 *    so Antigravity's directory watcher never scans half-built staging folders).
 * 3. Places `plugin.json` LAST and swaps into `<targetDir>` with `.bak-*` rollback on any failure.
 *
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, checkOnly: boolean, codeOnly?: boolean, targetDir: string, checkedBinaries: string[], syncedItems: string[] }>}
 */
export async function installPlugin({
  sourceRoot = ROOT,
  targetDir = DEFAULT_TARGET_DIR,
  checkOnly = false,
  codeOnly = false,
  openFn = openSync,
  closeFn = closeSync,
  renameFn = renameSync,
  existsFn = existsSync,
  maxRetries = 3,
  baseDelayMs = 150,
} = {}) {
  const resolvedTarget = resolve(targetDir);

  if (codeOnly) {
    const parity = verifyNativeBinariesMatch(sourceRoot, resolvedTarget);
    if (!parity.ok) {
      const err = new Error(
        `${parity.reason}\n请先在 Customizations 关闭 Context Menu Plus 后运行不带 --code-only 的完整安装脚本。`,
      );
      err.code = 'NATIVE_BINARY_CHANGED';
      throw err;
    }

    const stamp = `${Date.now()}-${process.pid}`;
    const targetBase = basename(resolvedTarget) || 'agy-context-menu';
    const stagingDir = join(tmpdir(), `${targetBase}.staging-${stamp}`);
    const backupDir = join(tmpdir(), `${targetBase}.bak-${stamp}`);
    const copied = [];

    try {
      const stagedEntries = await runWithBackoff(
        () => stagePluginAssets({ sourceRoot, stagingDir, existsFn, includeNodeModules: false }),
        { maxRetries, baseDelayMs },
      );
      mkdirSync(resolvedTarget, { recursive: true });

      try {
        for (const entry of stagedEntries) {
          const stagedItem = join(stagingDir, entry.relPath);
          const destItem = join(resolvedTarget, entry.relPath);
          const bakItem = join(backupDir, entry.relPath);
          const hadExisting = existsFn(destItem);
          const rec = { destItem, bakItem, hadExisting, wroteNew: false };
          copied.push(rec);

          if (hadExisting) {
            mkdirSync(dirname(bakItem), { recursive: true });
            cpSync(destItem, bakItem, { recursive: true, force: true });
          }
          mkdirSync(dirname(destItem), { recursive: true });
          await runWithBackoff(
            () => cpSync(stagedItem, destItem, { recursive: true, force: true }),
            { maxRetries, baseDelayMs },
          );
          rec.wroteNew = true;
        }
      } catch (copyErr) {
        for (let i = copied.length - 1; i >= 0; i--) {
          const rec = copied[i];
          try {
            if (rec.hadExisting && existsFn(rec.bakItem)) {
              cpSync(rec.bakItem, rec.destItem, { recursive: true, force: true });
            } else if (!rec.hadExisting && rec.wroteNew && existsFn(rec.destItem)) {
              rmSync(rec.destItem, { recursive: true, force: true });
            }
          } catch {
            // best-effort rollback
          }
        }
        throw copyErr;
      }

      return {
        ok: true,
        checkOnly: false,
        codeOnly: true,
        targetDir: resolvedTarget,
        checkedBinaries: [],
        syncedItems: stagedEntries.map((e) => e.label),
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  }

  const lockStatus = checkNativeBinaryLocks(resolvedTarget, { openFn, closeFn });
  if (!lockStatus.ok) {
    const err = new Error(lockStatus.message);
    err.code = 'NATIVE_BINARY_LOCKED';
    err.lockedPath = lockStatus.lockedPath;
    err.errorCode = lockStatus.errorCode;
    throw err;
  }

  if (checkOnly) {
    return {
      ok: true,
      checkOnly: true,
      targetDir: resolvedTarget,
      checkedBinaries: lockStatus.checked,
      syncedItems: [],
    };
  }

  const stamp = `${Date.now()}-${process.pid}`;
  const targetBase = basename(resolvedTarget) || 'agy-context-menu';
  const stagingDir = join(tmpdir(), `${targetBase}.staging-${stamp}`);
  const backupDir = join(tmpdir(), `${targetBase}.bak-${stamp}`);
  const swapped = [];
  const isDefaultRename = renameFn === renameSync;

  try {
    mkdirSync(dirname(resolvedTarget), { recursive: true });
    const stagedEntries = await runWithBackoff(
      () => stagePluginAssets({ sourceRoot, stagingDir, existsFn }),
      { maxRetries, baseDelayMs },
    );

    mkdirSync(resolvedTarget, { recursive: true });

    try {
      for (const entry of stagedEntries) {
        const stagedItem = join(stagingDir, entry.relPath);
        const destItem = join(resolvedTarget, entry.relPath);
        const bakItem = join(backupDir, entry.relPath);
        const hadExisting = existsFn(destItem);
        const swapRecord = { destItem, bakItem, hadExisting, placedNew: false };
        swapped.push(swapRecord);

        if (hadExisting) {
          mkdirSync(dirname(bakItem), { recursive: true });
          try {
            await runWithBackoff(() => renameFn(destItem, bakItem), { maxRetries, baseDelayMs });
          } catch (moveOutErr) {
            if (isDefaultRename && moveOutErr?.code === 'EXDEV') {
              cpSync(destItem, bakItem, { recursive: true, force: true });
              rmSync(destItem, { recursive: true, force: true });
            } else {
              throw moveOutErr;
            }
          }
        }

        mkdirSync(dirname(destItem), { recursive: true });
        try {
          await runWithBackoff(() => renameFn(stagedItem, destItem), { maxRetries, baseDelayMs });
        } catch (placeErr) {
          if (
            isDefaultRename &&
            (placeErr?.code === 'EXDEV' || placeErr?.code === 'EPERM' || placeErr?.code === 'EACCES')
          ) {
            await runWithBackoff(
              () => cpSync(stagedItem, destItem, { recursive: true, force: true }),
              { maxRetries, baseDelayMs },
            );
          } else {
            throw placeErr;
          }
        }
        swapRecord.placedNew = true;
      }
    } catch (swapErr) {
      for (let i = swapped.length - 1; i >= 0; i--) {
        const record = swapped[i];
        try {
          if (record.placedNew && existsFn(record.destItem)) {
            rmSync(record.destItem, { recursive: true, force: true });
          }
          if (record.hadExisting && existsFn(record.bakItem)) {
            mkdirSync(dirname(record.destItem), { recursive: true });
            try {
              renameSync(record.bakItem, record.destItem);
            } catch {
              cpSync(record.bakItem, record.destItem, { recursive: true, force: true });
            }
          }
        } catch {
          // best-effort rollback for remaining entries
        }
      }
      throw swapErr;
    }

    return {
      ok: true,
      checkOnly: false,
      targetDir: resolvedTarget,
      checkedBinaries: lockStatus.checked,
      syncedItems: stagedEntries.map((e) => e.label),
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function isDirectCliRun() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const entryPath = resolve(process.argv[1]);
  return process.platform === 'win32'
    ? selfPath.toLowerCase() === entryPath.toLowerCase()
    : selfPath === entryPath;
}

if (isDirectCliRun()) {
  try {
    const opts = parseInstallArgs();
    if (opts.help) {
      console.log('Usage: node scripts/install.mjs [--target <dir>] [--check-only] [--code-only]');
      process.exit(0);
    }
    const result = await installPlugin({
      targetDir: opts.targetDir,
      checkOnly: opts.checkOnly,
      codeOnly: opts.codeOnly,
    });
    if (result.checkOnly) {
      console.log(
        `预检通过 (${result.targetDir})：已检查 ${result.checkedBinaries.length} 个原生 .node 文件，无进程文件锁占用。`,
      );
    } else if (result.codeOnly) {
      console.log(`已热同步纯代码资产至: ${result.targetDir}（原生 .node SHA-256 校验一致，无需覆盖）`);
      console.log(`同步内容: ${result.syncedItems.join(', ')}`);
    } else {
      console.log(`已安全部署 agy-context-menu v2.0 至: ${result.targetDir}`);
      console.log(`同步内容: ${result.syncedItems.join(', ')}`);
    }
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}
