import { DarwinAdapter } from './darwin.mjs';
import {
  Win32FfiAdapter,
  getWin32PlatformStatus,
  hasCachedWin32Bindings,
  loadDefaultWin32Bindings,
  readClipboardFileDropList,
  readClipboardText,
  resetWin32BindingsState,
} from './win32-ffi.mjs';

let defaultAdapterInstance = null;

/**
 * Creates a platform-specific adapter for file actions and native clipboard operations.
 */
export function createPlatformAdapter(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === 'win32') {
    return new Win32FfiAdapter(options);
  }

  if (platform === 'darwin') {
    return new DarwinAdapter(options);
  }

  throw new Error(`Unsupported platform "${platform}". Expected "win32" or "darwin".`);
}

/**
 * Returns the lazily created default platform adapter singleton for the current OS.
 */
export function getDefaultPlatformAdapter() {
  if (!defaultAdapterInstance) {
    defaultAdapterInstance = createPlatformAdapter();
  }
  return defaultAdapterInstance;
}

/**
 * Exposes the active platform adapter runtime mode and degradation reason (Patch P6).
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Record<string, any>} [options.adapter]
 * @returns {Promise<{ mode: 'koffi_native' | 'powershell_fallback' | 'darwin_native', degradeReason: string | null }>}
 */
export async function getPlatformStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    return { mode: 'darwin_native', degradeReason: null };
  }

  if (platform === 'win32') {
    const adapter = options.adapter || defaultAdapterInstance;
    if (adapter && typeof adapter.mode === 'string') {
      return {
        mode: adapter.mode,
        degradeReason: adapter.degradeReason ?? null,
      };
    }
    return getWin32PlatformStatus();
  }

  return { mode: 'powershell_fallback', degradeReason: `Unsupported platform: ${platform}` };
}

export {
  DarwinAdapter,
  Win32FfiAdapter,
  hasCachedWin32Bindings,
  loadDefaultWin32Bindings,
  readClipboardFileDropList,
  readClipboardText,
  resetWin32BindingsState,
};
