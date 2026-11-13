import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads the Antigravity Sidecar SDK, handling standard ESM, CJS NODE_PATH, and user config node_modules fallback.
 */
export async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }

  try {
    const resolved = createRequire(import.meta.url).resolve('sidecar_sdk');
    return await import(pathToFileURL(resolved).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }

  const fallbackPath = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
  if (existsSync(fallbackPath)) {
    return await import(pathToFileURL(fallbackPath).href);
  }

  throw new Error('Unable to locate sidecar_sdk in NODE_PATH or ~/.gemini/config/node_modules');
}
