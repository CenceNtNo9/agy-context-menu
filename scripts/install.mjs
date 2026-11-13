import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST = join(homedir(), '.gemini', 'config', 'plugins', 'agy-context-menu');

mkdirSync(DEST, { recursive: true });

for (const file of ['plugin.json', 'README.md', 'LICENSE']) {
  const src = join(ROOT, file);
  if (existsSync(src)) {
    cpSync(src, join(DEST, file), { force: true });
  }
}

const assetsSrc = join(ROOT, 'assets');
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, join(DEST, 'assets'), { recursive: true, force: true });
}

const sidecarSrc = join(ROOT, 'sidecars', 'menu');
const sidecarDest = join(DEST, 'sidecars', 'menu');
if (existsSync(sidecarDest)) {
  try {
    rmSync(sidecarDest, { recursive: true, force: true });
  } catch (err) {
    // On Windows a live sidecar holds a cwd handle on sidecars/menu; overwrite files in-place.
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') {
      throw err;
    }
  }
}
mkdirSync(sidecarDest, { recursive: true });

cpSync(sidecarSrc, sidecarDest, {
  recursive: true,
  force: true,
  filter: (srcPath) => {
    const normalized = srcPath.replace(/\\/g, '/');
    return !normalized.endsWith('/tests') && !normalized.includes('/tests/');
  },
});

console.log(`Installed agy-context-menu to: ${DEST}`);
