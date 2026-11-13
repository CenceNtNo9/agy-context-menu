import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

const COINIT_APARTMENTTHREADED = 0x2;
const COINIT_DISABLE_OLE1DDE = 0x4;
const COINIT_SHELL_APARTMENT = COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE;
const S_OK = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = -2147417850;

const ASFW_ANY = 0xffffffff;
const SW_SHOWNORMAL = 1;

const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;
const GMEM_CLIPBOARD_FLAGS = GMEM_MOVEABLE | GMEM_ZEROINIT;

const CF_UNICODETEXT = 13;
const CF_HDROP = 15;

const DROPFILES_HEADER_BYTES = 20;
const CLIPBOARD_MAX_RETRIES = 5;
const CLIPBOARD_RETRY_DELAY_MS = 15;

let cachedBindingsPromise = null;
let globalWin32Mode = 'koffi_native';
let globalDegradeReason = null;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHResult(hr) {
  return `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Inspect whether the Win32 FFI bindings Promise is currently cached (for testing Patch P6).
 * @returns {boolean}
 */
export function hasCachedWin32Bindings() {
  return cachedBindingsPromise !== null;
}

/**
 * Reset cached Win32 FFI bindings and degradation state (for testing Patch P6).
 */
export function resetWin32BindingsState() {
  cachedBindingsPromise = null;
  globalWin32Mode = 'koffi_native';
  globalDegradeReason = null;
}

/**
 * Return the current Win32 FFI status (`koffi_native` vs `powershell_fallback`).
 * @returns {{ mode: 'koffi_native' | 'powershell_fallback', degradeReason: string | null }}
 */
export function getWin32PlatformStatus() {
  return {
    mode: globalWin32Mode,
    degradeReason: globalDegradeReason,
  };
}

/**
 * Lazily loads koffi and binds required Win32 DLL symbols on Windows.
 * On failure (import or DLL bind error), clears `cachedBindingsPromise = null` so future
 * calls are never permanently stuck on a rejected Promise (Patch P6).
 * @param {() => Promise<any>} [koffiImporter]
 */
export async function loadDefaultWin32Bindings(koffiImporter = () => import('koffi')) {
  if (process.platform !== 'win32') {
    throw new Error(`Win32FfiAdapter cannot load Win32 DLLs on platform "${process.platform}".`);
  }

  if (!cachedBindingsPromise) {
    cachedBindingsPromise = (async () => {
      const mod = await koffiImporter();
      const koffi = mod?.default || mod;
      if (!koffi || typeof koffi.load !== 'function') {
        throw new Error('koffi module did not expose koffi.load()');
      }

      const ole32 = koffi.load('ole32.dll');
      const user32 = koffi.load('user32.dll');
      const shell32 = koffi.load('shell32.dll');
      const kernel32 = koffi.load('kernel32.dll');

      return {
        koffi,
        // ole32.dll
        CoInitializeEx: ole32.func('int32 __stdcall CoInitializeEx(void *pvReserved, uint32 dwCoInit)'),
        CoUninitialize: ole32.func('void __stdcall CoUninitialize()'),

        // user32.dll
        AllowSetForegroundWindow: user32.func('bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)'),
        OpenClipboard: user32.func('bool __stdcall OpenClipboard(void *hWndNewOwner)'),
        CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
        EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
        SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)'),
        GetClipboardData: user32.func('void * __stdcall GetClipboardData(uint32 uFormat)'),
        IsClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32 format)'),

        // shell32.dll
        ILCreateFromPathW: shell32.func('void * __stdcall ILCreateFromPathW(str16 pszPath)'),
        SHOpenFolderAndSelectItems: shell32.func(
          'int32 __stdcall SHOpenFolderAndSelectItems(void *pidlFolder, uint32 cidl, void *apidl, uint32 dwFlags)',
        ),
        ILFree: shell32.func('void __stdcall ILFree(void *pidl)'),
        ShellExecuteW: shell32.func(
          'intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int32 nShowCmd)',
        ),
        DragQueryFileW: shell32.func(
          'uint32 __stdcall DragQueryFileW(void *hDrop, uint32 iFile, void *lpszFile, uint32 cch)',
        ),

        // kernel32.dll
        GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32 uFlags, size_t dwBytes)'),
        GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *hMem)'),
        GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(void *hMem)'),
        GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *hMem)'),
        GlobalSize: kernel32.func('size_t __stdcall GlobalSize(void *hMem)'),
        GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
      };
    })().catch((err) => {
      cachedBindingsPromise = null;
      throw err;
    });
  }

  return cachedBindingsPromise;
}

async function openClipboardWithRetry(bindings, sleepImpl = defaultSleep) {
  let lastErrorCode = 0;
  for (let attempt = 0; attempt < CLIPBOARD_MAX_RETRIES; attempt += 1) {
    if (bindings.OpenClipboard(null)) {
      return;
    }
    lastErrorCode = bindings.GetLastError();
    if (attempt < CLIPBOARD_MAX_RETRIES - 1) {
      await sleepImpl(CLIPBOARD_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `OpenClipboard failed after ${CLIPBOARD_MAX_RETRIES} attempts (Win32 error ${lastErrorCode}).`,
  );
}

/**
 * Allocates movable global memory, copies `payloadBuffer` into it, and hands
 * ownership to the Windows clipboard via SetClipboardData.
 */
function writeClipboardGlobalMemory(bindings, format, payloadBuffer) {
  const hGlobal = bindings.GlobalAlloc(GMEM_CLIPBOARD_FLAGS, payloadBuffer.length);
  if (!hGlobal) {
    throw new Error(`GlobalAlloc failed (Win32 error ${bindings.GetLastError()}).`);
  }

  let ownershipTransferred = false;
  try {
    const ptr = bindings.GlobalLock(hGlobal);
    if (!ptr) {
      throw new Error(`GlobalLock failed (Win32 error ${bindings.GetLastError()}).`);
    }

    try {
      bindings.koffi.encode(ptr, 'uint8', payloadBuffer, payloadBuffer.length);
    } finally {
      bindings.GlobalUnlock(hGlobal);
    }

    const result = bindings.SetClipboardData(format, hGlobal);
    if (!result) {
      throw new Error(`SetClipboardData(${format}) failed (Win32 error ${bindings.GetLastError()}).`);
    }
    ownershipTransferred = true;
  } finally {
    if (!ownershipTransferred) {
      bindings.GlobalFree(hGlobal);
    }
  }
}

function buildDropFilesBuffer(filePath) {
  const pathBuf = Buffer.from(`${filePath}\0\0`, 'utf16le');
  const totalBytes = DROPFILES_HEADER_BYTES + pathBuf.length;
  const dropBuf = Buffer.alloc(totalBytes);
  // DROPFILES struct: pFiles (uint32), pt.x (int32), pt.y (int32), fNC (int32), fWide (int32)
  dropBuf.writeUInt32LE(DROPFILES_HEADER_BYTES, 0);
  dropBuf.writeInt32LE(0, 4);
  dropBuf.writeInt32LE(0, 8);
  dropBuf.writeInt32LE(0, 12);
  dropBuf.writeInt32LE(1, 16);
  pathBuf.copy(dropBuf, DROPFILES_HEADER_BYTES);
  return dropBuf;
}

function quoteForCmdExe(arg) {
  const text = String(arg);
  if (/[\r\n\0]/.test(text)) {
    throw new Error('Editor command/argument contains forbidden control characters.');
  }
  if (text.includes('"')) {
    throw new Error('Editor command/argument contains unescaped double quotes.');
  }
  return `"${text}"`;
}

function spawnDetachedProcess(spawnImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
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

function decodeUtf16LeNullTerminated(rawBytes) {
  let endOffset = rawBytes.length - (rawBytes.length % 2);
  for (let i = 0; i + 1 < rawBytes.length; i += 2) {
    if (rawBytes[i] === 0 && rawBytes[i + 1] === 0) {
      endOffset = i;
      break;
    }
  }
  return rawBytes.toString('utf16le', 0, endOffset);
}

function withComApartment(bindings, fn) {
  const coInitHr = bindings.CoInitializeEx(null, COINIT_SHELL_APARTMENT);
  const shouldUninitialize = coInitHr === S_OK || coInitHr === S_FALSE;

  if (!shouldUninitialize && coInitHr !== RPC_E_CHANGED_MODE) {
    throw new Error(`CoInitializeEx failed with HRESULT ${formatHResult(coInitHr)}.`);
  }

  try {
    return fn();
  } finally {
    if (shouldUninitialize) {
      bindings.CoUninitialize();
    }
  }
}

/**
 * Windows native FFI platform adapter powered by koffi.
 * Automatically degrades to `sidecars/menu/os-actions.mjs` if koffi or Win32 DLL loading fails (Patch P6).
 */
export class Win32FfiAdapter {
  constructor(options = {}) {
    this.bindingsLoader = options.bindingsLoader || loadDefaultWin32Bindings;
    this.fallbackActions = options.fallbackActions || null;
    this.fallbackActionsLoader =
      options.fallbackActionsLoader || (() => import('../../sidecars/menu/os-actions.mjs'));
    this.spawnImpl = options.spawnImpl || nodeSpawn;
    this.sleepImpl = options.sleepImpl || defaultSleep;
    this.comSpec = options.comSpec || process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    this.updateGlobalStatus = options.updateGlobalStatus !== false;
    this.mode = 'koffi_native';
    this.degradeReason = null;
  }

  async getBindings() {
    return this.bindingsLoader();
  }

  async #getFallbackActions() {
    if (this.fallbackActions) {
      return this.fallbackActions;
    }
    return this.fallbackActionsLoader();
  }

  async #runWithFfiOrFallback(ffiExecutor, fallbackExecutor) {
    let bindings;
    try {
      bindings = await this.getBindings();
    } catch (err) {
      const reason = err?.message || String(err);
      this.mode = 'powershell_fallback';
      this.degradeReason = reason;
      if (this.updateGlobalStatus) {
        globalWin32Mode = 'powershell_fallback';
        globalDegradeReason = reason;
      }
      const fallback = await this.#getFallbackActions();
      return fallbackExecutor(fallback, reason);
    }

    this.mode = 'koffi_native';
    this.degradeReason = null;
    if (this.updateGlobalStatus) {
      globalWin32Mode = 'koffi_native';
      globalDegradeReason = null;
    }
    return ffiExecutor(bindings);
  }

  async revealInFolder(targetPath) {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('revealInFolder requires a non-empty targetPath.');
    }

    return this.#runWithFfiOrFallback(
      (bindings) => {
        withComApartment(bindings, () => {
          bindings.AllowSetForegroundWindow(ASFW_ANY);

          const pidl = bindings.ILCreateFromPathW(targetPath);
          if (!pidl) {
            throw new Error(`ILCreateFromPathW failed for path: ${targetPath}`);
          }

          try {
            const selectHr = bindings.SHOpenFolderAndSelectItems(pidl, 0, null, 0);
            if (selectHr < 0) {
              throw new Error(
                `SHOpenFolderAndSelectItems failed with HRESULT ${formatHResult(selectHr)} for path: ${targetPath}`,
              );
            }
          } finally {
            bindings.ILFree(pidl);
          }
        });

        return { ok: true, method: 'win32_SHOpenFolderAndSelectItems' };
      },
      async (fallback) => {
        const res = await fallback.revealInFolder(targetPath, { platform: 'win32' });
        return { ok: true, method: 'powershell_fallback_reveal', degraded: true, detail: res };
      },
    );
  }

  async openDefault(targetPath) {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('openDefault requires a non-empty targetPath.');
    }

    const workDir = path.win32.dirname(targetPath) || null;
    return this.#runWithFfiOrFallback(
      (bindings) => this.#shellExecuteOpenWithBindings(bindings, targetPath, workDir),
      async (fallback) => {
        await fallback.openDefault(targetPath, { platform: 'win32' });
        return { ok: true, method: 'powershell_fallback_open_default', degraded: true };
      },
    );
  }

  async openDirectory(dirPath) {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      throw new Error('openDirectory requires a non-empty dirPath.');
    }

    return this.#runWithFfiOrFallback(
      (bindings) => this.#shellExecuteOpenWithBindings(bindings, dirPath, dirPath),
      async (fallback) => {
        await fallback.openDefault(dirPath, { platform: 'win32' });
        return { ok: true, method: 'powershell_fallback_open_directory', degraded: true };
      },
    );
  }

  #shellExecuteOpenWithBindings(bindings, targetPath, workDir) {
    withComApartment(bindings, () => {
      bindings.AllowSetForegroundWindow(ASFW_ANY);

      const rawRc = bindings.ShellExecuteW(null, 'open', targetPath, null, workDir, SW_SHOWNORMAL);
      const code = typeof rawRc === 'bigint' ? Number(rawRc) : Number(rawRc);

      if (!(code > 32)) {
        const winErr = bindings.GetLastError();
        throw new Error(
          `ShellExecuteW failed with code ${code} (Win32 error ${winErr}) for path: ${targetPath}`,
        );
      }
    });

    return { ok: true, method: 'win32_ShellExecuteW' };
  }

  async openInEditor({ filePath, editorCommand, editorArgs } = {}) {
    const command = editorCommand || 'notepad.exe';
    const args = Array.isArray(editorArgs) ? editorArgs.map(String) : filePath ? [String(filePath)] : [];

    const isBatchScript = /\.(cmd|bat)$/i.test(command);
    if (isBatchScript) {
      const quotedLine = [quoteForCmdExe(command), ...args.map(quoteForCmdExe)].join(' ');
      await spawnDetachedProcess(this.spawnImpl, this.comSpec, ['/d', '/s', '/c', quotedLine], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      await spawnDetachedProcess(this.spawnImpl, command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    }

    return { ok: true, method: 'spawn_editor', editor: command };
  }

  async copyFileEntity(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('copyFileEntity requires a non-empty filePath.');
    }

    return this.#runWithFfiOrFallback(
      async (bindings) => {
        const dropBuf = buildDropFilesBuffer(filePath);

        await openClipboardWithRetry(bindings, this.sleepImpl);
        try {
          if (!bindings.EmptyClipboard()) {
            throw new Error(`EmptyClipboard failed (Win32 error ${bindings.GetLastError()}).`);
          }
          writeClipboardGlobalMemory(bindings, CF_HDROP, dropBuf);
        } finally {
          bindings.CloseClipboard();
        }

        return { ok: true, format: 'CF_HDROP' };
      },
      async (fallback) => {
        await fallback.copyFileEntity(filePath, { platform: 'win32' });
        return { ok: true, format: 'CF_HDROP', method: 'powershell_fallback_copy_file', degraded: true };
      },
    );
  }

  async copyText(text) {
    if (typeof text !== 'string') {
      throw new Error('copyText requires a string.');
    }

    return this.#runWithFfiOrFallback(
      async (bindings) => {
        const textBuf = Buffer.from(`${text}\0`, 'utf16le');

        await openClipboardWithRetry(bindings, this.sleepImpl);
        try {
          if (!bindings.EmptyClipboard()) {
            throw new Error(`EmptyClipboard failed (Win32 error ${bindings.GetLastError()}).`);
          }
          writeClipboardGlobalMemory(bindings, CF_UNICODETEXT, textBuf);
        } finally {
          bindings.CloseClipboard();
        }

        return { ok: true, format: 'CF_UNICODETEXT' };
      },
      async (fallback) => {
        await fallback.copyTextToOsClipboard(text, { platform: 'win32' });
        return { ok: true, format: 'CF_UNICODETEXT', method: 'powershell_fallback_copy_text', degraded: true };
      },
    );
  }

  async readClipboardText() {
    const bindings = await this.getBindings();
    await openClipboardWithRetry(bindings, this.sleepImpl);
    try {
      if (!bindings.IsClipboardFormatAvailable(CF_UNICODETEXT)) {
        return null;
      }

      const hData = bindings.GetClipboardData(CF_UNICODETEXT);
      if (!hData) {
        return null;
      }

      const byteSize = Number(bindings.GlobalSize(hData));
      if (!byteSize) {
        return '';
      }

      const ptr = bindings.GlobalLock(hData);
      if (!ptr) {
        throw new Error(`GlobalLock failed while reading CF_UNICODETEXT (Win32 error ${bindings.GetLastError()}).`);
      }

      try {
        const rawBytes = Buffer.from(bindings.koffi.decode(ptr, 'uint8', byteSize));
        return decodeUtf16LeNullTerminated(rawBytes);
      } finally {
        bindings.GlobalUnlock(hData);
      }
    } finally {
      bindings.CloseClipboard();
    }
  }

  async readClipboardFileDropList() {
    const bindings = await this.getBindings();
    await openClipboardWithRetry(bindings, this.sleepImpl);
    try {
      if (!bindings.IsClipboardFormatAvailable(CF_HDROP)) {
        return [];
      }

      const hDrop = bindings.GetClipboardData(CF_HDROP);
      if (!hDrop) {
        return [];
      }

      const count = bindings.DragQueryFileW(hDrop, 0xffffffff, null, 0);
      const files = [];

      for (let index = 0; index < count; index += 1) {
        const charLen = bindings.DragQueryFileW(hDrop, index, null, 0);
        if (charLen === 0) {
          continue;
        }
        const pathBuf = Buffer.alloc((charLen + 1) * 2);
        const copiedChars = bindings.DragQueryFileW(hDrop, index, pathBuf, charLen + 1);
        files.push(pathBuf.toString('utf16le', 0, copiedChars * 2));
      }

      return files;
    } finally {
      bindings.CloseClipboard();
    }
  }
}

export function createWin32FfiAdapter(options = {}) {
  return new Win32FfiAdapter(options);
}

export async function readClipboardText(options = {}) {
  const adapter = new Win32FfiAdapter(options);
  return adapter.readClipboardText();
}

export async function readClipboardFileDropList(options = {}) {
  const adapter = new Win32FfiAdapter(options);
  return adapter.readClipboardFileDropList();
}
