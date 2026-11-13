import fs from 'node:fs';
import { readdir, readFile, stat as fsStatAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EXECUTABLE_EXTENSIONS,
  DEFAULT_SOURCE_EXTENSIONS,
  hasNtfsAdsStream,
  isTrustedUncHost,
  isUntrustedUncPath,
  parseUncPath,
} from './security-policy.mjs';

export const SOURCE_PRIORITY = Object.freeze({
  'explicit-uri': 6,
  'react-prop': 5,
  'dom-attr': 4,
  'media-src': 3,
  'inline-code': 2,
  'caret-token': 1,
  'selection-text': 1,
});

const HIGH_PRIORITY_EXPLICIT_SOURCES = new Set(['explicit-uri', 'react-prop', 'dom-attr']);

const DEFAULT_KNOWN_DOC_MEDIA_EXTENSIONS = new Set([
  '.md', '.html', '.htm', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.mp3', '.wav', '.flac', '.ogg',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.db', '.sqlite', '.sqlite3', '.wasm', '.bin', '.dat', '.lock',
]);

const EXTERNAL_SLASH_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//;
const EXTERNAL_COLON_SCHEME_RE = /^(?:mailto|tel|sms|data|javascript|about|urn|blob|cid|news|sidecar|customization|plugin|conversation|vscode):/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_FILE_BARE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'nan', 'infinity',
  'const', 'let', 'var', 'function', 'return', 'import', 'export',
  'async', 'await', 'class', 'interface', 'type', 'enum',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'pip', 'git', 'bash', 'sh',
]);

const DEFAULT_STAT_TIMEOUT_MS = 1500;

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Strip surrounding markdown/quote punctuation without corrupting stack traces like `file.cs(42,10)`.
 * @param {string} raw
 * @returns {string}
 */
export function stripSurroundingPunctuation(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (
    (s.startsWith('`') && s.endsWith('`')) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('<') && s.endsWith('>')) ||
    (s.startsWith('(') && s.endsWith(')')) ||
    (s.startsWith('[') && s.endsWith(']'))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^["'`<(]+/, '').replace(/["'`>,;]+$/, '').trim();
  if (s.endsWith(')') && !s.includes('(')) {
    s = s.slice(0, -1);
  }
  if (s.endsWith(']') && !s.includes('[')) {
    s = s.slice(0, -1);
  }
  return s.trim();
}

/**
 * Determine whether a trimmed input string uses an external non-file URI scheme.
 * Avoids false positives on `app.ts:42` or `README.md:5`.
 * @param {string} trimmed
 * @returns {boolean}
 */
function isExternalScheme(trimmed) {
  if (/^file:/i.test(trimmed)) {
    return false;
  }
  return EXTERNAL_SLASH_SCHEME_RE.test(trimmed) || EXTERNAL_COLON_SCHEME_RE.test(trimmed);
}

/**
 * Safely decode URI percent-encoding without throwing on malformed sequences.
 * @param {string} value
 * @returns {string}
 */
function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (token) => {
      try {
        return decodeURIComponent(token);
      } catch {
        return token;
      }
    });
  }
}

/**
 * Encode a normalized local or trusted UNC path into a `file://` URL.
 * @param {string} targetPath
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function encodePathToFileUrl(targetPath, platform = process.platform) {
  if (!targetPath) return '';
  if (platform === 'win32') {
    const normalized = targetPath.replace(/\\/g, '/');
    if (normalized.startsWith('//')) {
      const withoutLeading = normalized.slice(2);
      const slash = withoutLeading.indexOf('/');
      if (slash > 0) {
        const host = withoutLeading.slice(0, slash);
        const rest = withoutLeading.slice(slash).split('/').map(encodeURIComponent).join('/');
        return `file://${host}${rest}`;
      }
    }
    if (/^[a-zA-Z]:/.test(normalized)) {
      const drive = normalized.slice(0, 2);
      const rest = normalized.slice(2).split('/').map(encodeURIComponent).join('/');
      return `file:///${drive}${rest}`;
    }
    return `file:///${normalized.split('/').map(encodeURIComponent).join('/')}`;
  }
  if (platform === process.platform) {
    try {
      return pathToFileURL(targetPath).href;
    } catch {
      // fallback below
    }
  }
  const normalized = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Parse `#L10-L20`, `#L10`, `#L10C5`, `#L10:5`, or `#10` fragments.
 * @param {string} fragment
 * @returns {{ line: number | null, column: number | null, endLine: number | null }}
 */
function parseFragmentAnchor(fragment) {
  if (!fragment) {
    return { line: null, column: null, endLine: null };
  }
  const rangeMatch = fragment.match(/^L(\d+)-L?(\d+)$/i);
  if (rangeMatch) {
    return {
      line: Number(rangeMatch[1]),
      column: null,
      endLine: Number(rangeMatch[2]),
    };
  }
  const lineColMatch = fragment.match(/^L(\d+)(?:C|:)(\d+)$/i);
  if (lineColMatch) {
    return {
      line: Number(lineColMatch[1]),
      column: Number(lineColMatch[2]),
      endLine: null,
    };
  }
  const singleLineMatch = fragment.match(/^L?(\d+)$/i);
  if (singleLineMatch) {
    return {
      line: Number(singleLineMatch[1]),
      column: null,
      endLine: null,
    };
  }
  return { line: null, column: null, endLine: null };
}

/**
 * Extract trailing `#L...`, `(line,col)`, or `:line(:col)?` anchors from a path string.
 * Avoids misinterpreting Windows drive colons (`C:`).
 * @param {string} rawPath
 * @returns {{ cleanPath: string, line: number | null, column: number | null, endLine: number | null }}
 */
function stripTrailingLineAnchor(rawPath) {
  let working = rawPath;
  let line = null;
  let column = null;
  let endLine = null;

  const hashIdx = working.indexOf('#');
  if (hashIdx > 0) {
    const maybeFrag = working.slice(hashIdx + 1);
    const parsed = parseFragmentAnchor(maybeFrag);
    if (parsed.line !== null) {
      working = working.slice(0, hashIdx);
      line = parsed.line;
      column = parsed.column;
      endLine = parsed.endLine;
    }
  }

  // Stack trace parenthesis format: `file.cs(42,10)` or `file.ts(42)`
  const parenMatch = working.match(/^(.*?)\((\d+)(?:,(\d+))?\)$/);
  if (parenMatch && parenMatch[1]) {
    working = parenMatch[1];
    if (line === null) {
      line = Number(parenMatch[2]);
      column = parenMatch[3] ? Number(parenMatch[3]) : null;
    }
  }

  // Match `:line` or `:line:column` at the end when prefix is not just a drive letter like `C`
  const colonMatch = working.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (colonMatch && colonMatch[1].length > 1) {
    working = colonMatch[1];
    if (line === null) {
      line = Number(colonMatch[2]);
      column = colonMatch[3] ? Number(colonMatch[3]) : null;
    }
  }

  return { cleanPath: working, line, column, endLine };
}

/**
 * Case-insensitive env lookup helper for Windows env conventions.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function lookupEnv(env, name) {
  if (!env || !name) {
    return undefined;
  }
  if (env[name] !== undefined) {
    return env[name];
  }
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper) {
      return v;
    }
  }
  return undefined;
}

/**
 * Expand `~`, `%VAR%`, `$VAR`, and `${VAR}` using injected `env` and `homeDir`.
 * @param {string} rawPath
 * @param {Record<string, string | undefined>} env
 * @param {string} [homeDir]
 * @returns {{ expanded: string, hadExpansion: boolean }}
 */
function expandEnvAndTilde(rawPath, env, homeDir) {
  let expanded = rawPath;
  let hadExpansion = false;

  const home = homeDir || lookupEnv(env, 'HOME') || lookupEnv(env, 'USERPROFILE');
  if (home && (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\'))) {
    expanded = home + expanded.slice(1);
    hadExpansion = true;
  }

  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (full, varName) => {
    const val = lookupEnv(env, varName);
    if (val !== undefined && val !== '') {
      hadExpansion = true;
      return val;
    }
    return full;
  });

  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, braced, bare) => {
    const varName = braced || bare;
    const val = lookupEnv(env, varName);
    if (val !== undefined && val !== '') {
      hadExpansion = true;
      return val;
    }
    return full;
  });

  return { expanded, hadExpansion };
}

/**
 * Map WSL `/mnt/<drive>/...` paths to Windows drive paths when running on Windows.
 * @param {string} candidate
 * @param {NodeJS.Platform} platform
 * @returns {{ mapped: string, wasMapped: boolean }}
 */
function mapWslMountPath(candidate, platform) {
  if (platform === 'win32') {
    const match = candidate.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
      return {
        mapped: rest ? `${drive}:\\${rest}` : `${drive}:\\`,
        wasMapped: true,
      };
    }
  }
  return { mapped: candidate, wasMapped: false };
}

/**
 * Parse a `file:` URI into a platform path + optional line/column/endLine.
 * @param {string} rawUri
 * @param {NodeJS.Platform} platform
 * @returns {{ pathStr: string, line: number | null, column: number | null, endLine: number | null }}
 */
function parseFileUri(rawUri, platform) {
  let rest = rawUri.slice(5);

  let fragment = '';
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  const queryStart = /^\/+\?(?:\/|$)/.test(rest) ? rest.indexOf('?') + 1 : 0;
  const queryIdx = rest.indexOf('?', queryStart);
  if (queryIdx !== -1) {
    rest = rest.slice(0, queryIdx);
  }

  let pathStr = '';
  if (platform === 'win32' && /^\/{4,}/.test(rest)) {
    const stripped = safeDecodeUri(rest.replace(/^\/+/, ''));
    if (/^[A-Za-z]:/.test(stripped)) {
      pathStr = stripped;
    } else {
      pathStr = `\\\\${stripped.replace(/\//g, '\\')}`;
    }
  } else if (rest.startsWith('///')) {
    const decoded = safeDecodeUri(rest.slice(2));
    if (platform === 'win32' && /^\/[A-Za-z]:/.test(decoded)) {
      pathStr = decoded.slice(1);
    } else {
      pathStr = decoded;
    }
  } else if (rest.startsWith('//')) {
    const afterSlashes = rest.slice(2);
    const firstSlash = afterSlashes.indexOf('/');
    const host = firstSlash === -1 ? afterSlashes : afterSlashes.slice(0, firstSlash);
    const rawPathPart = firstSlash === -1 ? '' : afterSlashes.slice(firstSlash);
    const decodedPath = safeDecodeUri(rawPathPart);

    if (!host || host.toLowerCase() === 'localhost') {
      if (platform === 'win32' && /^\/[A-Za-z]:/.test(decodedPath)) {
        pathStr = decodedPath.slice(1);
      } else {
        pathStr = decodedPath || '/';
      }
    } else if (platform === 'win32' && /^[A-Za-z](?::|%3A)$/i.test(host)) {
      const driveLetter = host[0];
      pathStr = `${driveLetter}:${decodedPath}`;
    } else if (platform === 'win32') {
      const winPathPart = decodedPath.replace(/\//g, '\\');
      pathStr = `\\\\${safeDecodeUri(host)}${winPathPart}`;
    } else {
      pathStr = `//${safeDecodeUri(host)}${decodedPath}`;
    }
  } else {
    const decoded = safeDecodeUri(rest);
    if (platform === 'win32' && /^\/[A-Za-z]:/.test(decoded)) {
      pathStr = decoded.slice(1);
    } else {
      pathStr = decoded;
    }
  }

  const fragAnchor = parseFragmentAnchor(fragment);
  const trailingAnchor = stripTrailingLineAnchor(pathStr);

  return {
    pathStr: trailingAnchor.cleanPath,
    line: fragAnchor.line ?? trailingAnchor.line,
    column: fragAnchor.column ?? trailingAnchor.column,
    endLine: fragAnchor.endLine ?? trailingAnchor.endLine,
  };
}

/**
 * Strip trailing non-root slashes for canonical path output.
 * @param {string} p
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function stripTrailingSeparator(p, platform) {
  if (!p) {
    return p;
  }
  if (platform === 'win32') {
    if (/^[A-Za-z]:\\$/.test(p) || /^\\\\[?.]\\[A-Za-z]:\\$/.test(p) || p === '\\' || p === '/') {
      return p;
    }
    return p.replace(/[\\/]+$/, '');
  }
  if (p === '/') {
    return p;
  }
  return p.replace(/\/+$/, '');
}

/**
 * Normalize a path string according to target platform without converting POSIX `/home/...`
 * paths into `\home\...` on Windows unless it's a drive, device, or UNC path.
 * @param {string} candidate
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function normalizeTargetPath(candidate, platform) {
  if (platform === 'win32') {
    const uncInfo = parseUncPath(candidate);
    if (uncInfo.isUnc || uncInfo.isDevicePath) {
      const decodedSlashes = candidate.replace(/%5[cC]|%2[fF]/g, '\\');
      const converted = decodedSlashes.replace(/\//g, '\\').replace(/^\\+/, '\\\\');
      const head = converted.slice(0, 2);
      const tail = converted.slice(2).replace(/\\+/g, '\\');
      return stripTrailingSeparator(head + tail, platform);
    }
    if (/^[A-Za-z]:/.test(candidate) || candidate.includes('\\')) {
      return stripTrailingSeparator(path.win32.normalize(candidate), platform);
    }
    return stripTrailingSeparator(path.posix.normalize(candidate), 'linux');
  }
  return stripTrailingSeparator(path.posix.normalize(candidate), platform);
}

/**
 * Build combined known extension set for relative path detection.
 * @param {Record<string, any>} [config]
 * @returns {Set<string>}
 */
function getKnownExtensionSet(config = {}) {
  const set = new Set(DEFAULT_KNOWN_DOC_MEDIA_EXTENSIONS);
  const lists = [
    config?.executableExtensions || DEFAULT_EXECUTABLE_EXTENSIONS,
    config?.sourceExtensions || DEFAULT_SOURCE_EXTENSIONS,
    config?.knownPathExtensions || [],
  ];
  for (const list of lists) {
    for (const ext of list) {
      set.add(String(ext).toLowerCase());
    }
  }
  return set;
}

/**
 * Heuristic check whether a non-absolute string looks like a path rather than arbitrary inline code.
 * @param {string} candidate
 * @param {boolean} hasLineAnchor
 * @param {Set<string>} knownExtensions
 * @returns {boolean}
 */
function looksLikeRelativePath(candidate, hasLineAnchor, knownExtensions) {
  if (!candidate || candidate.length > 500 || /[\r\n\t]/.test(candidate)) {
    return false;
  }
  if (/^v?\d+(?:\.\d+){1,3}(?:-[\w.]+)?$/i.test(candidate)) {
    return false;
  }
  if (NON_FILE_BARE_WORDS.has(candidate.toLowerCase())) {
    return false;
  }
  if (/[;&|`<>(){}=]/.test(candidate)) {
    return false;
  }
  if (/^\.\.?[\\/]/.test(candidate)) {
    return true;
  }
  const hasSeparator = /[\\/]/.test(candidate);
  const ext = path.extname(candidate).toLowerCase();
  const hasKnownExt = Boolean(ext && knownExtensions.has(ext));

  if (hasSeparator && !/\s/.test(candidate)) {
    return true;
  }
  if (hasSeparator && hasKnownExt) {
    return true;
  }
  if (!/\s/.test(candidate) && hasKnownExt) {
    return true;
  }
  if (!/\s/.test(candidate) && hasLineAnchor && /\.[A-Za-z0-9]{1,8}$/.test(candidate)) {
    return true;
  }
  return false;
}

/**
 * Filter workspace roots to exclude empty entries and untrusted external UNC paths (Patch P4).
 * @param {unknown} workspaceRoots
 * @param {NodeJS.Platform} platform
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
function filterSafeWorkspaceRoots(workspaceRoots, platform, config) {
  if (!Array.isArray(workspaceRoots)) {
    return [];
  }
  return workspaceRoots.filter(
    (root) =>
      typeof root === 'string' &&
      root.trim().length > 0 &&
      !isUntrustedUncPath(root.trim(), platform, config),
  );
}

function isWindowsPathShape(p, platform) {
  return platform === 'win32' && (/^[A-Za-z]:/.test(p) || p.startsWith('\\\\'));
}

function computeRelativePath(targetPath, workspaceRoots, platform) {
  if (!targetPath || !Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return null;
  }
  const pApi = pathApiFor(platform);
  const normTarget = platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  for (const root of workspaceRoots) {
    const normRoot = platform === 'win32' ? root.toLowerCase() : root;
    if (normTarget === normRoot) {
      return '.';
    }
    const sep = platform === 'win32' ? '\\' : '/';
    const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
    if (normTarget.startsWith(prefix)) {
      return pApi.relative(root, targetPath);
    }
  }
  return null;
}

/**
 * Safe `statSync` wrapper that never throws.
 * @param {typeof fs} fsImpl
 * @param {string} targetPath
 * @returns {fs.Stats | null}
 */
function tryStatSync(fsImpl, targetPath) {
  try {
    return fsImpl.statSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Async `stat` wrapper with timeout protection (Patch P5).
 * Prevents offline network shares or sleeping `\\wsl.localhost` from freezing the event loop.
 * @param {(p: string) => Promise<any>} asyncStatImpl
 * @param {string} targetPath
 * @param {number} [timeoutMs]
 * @returns {Promise<any | null>}
 */
async function tryStatAsync(asyncStatImpl, targetPath, timeoutMs = DEFAULT_STAT_TIMEOUT_MS) {
  let timer = null;
  try {
    const statPromise = Promise.resolve().then(() => asyncStatImpl(targetPath));
    // Guard against unhandled rejection if timeout settles first
    statPromise.catch(() => {});

    if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) {
      return await statPromise;
    }

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`stat timed out after ${timeoutMs}ms: ${targetPath}`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
      timer.unref?.();
    });

    return await Promise.race([statPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveAsyncStatFn(opts) {
  if (typeof opts.asyncStatImpl === 'function') {
    return opts.asyncStatImpl;
  }
  if (opts.fsImpl && typeof opts.fsImpl.promises?.stat === 'function') {
    return (targetPath) => opts.fsImpl.promises.stat(targetPath);
  }
  if (opts.fsImpl && typeof opts.fsImpl.statSync === 'function') {
    return (targetPath) => Promise.resolve(opts.fsImpl.statSync(targetPath));
  }
  return (targetPath) => fsStatAsync(targetPath);
}

/**
 * Walk upward from `normalizedPath` synchronously to find the nearest existing parent directory.
 */
function findNearestExistingParentSync(normalizedPath, platform, fsImpl, config) {
  const useWin32 = isWindowsPathShape(normalizedPath, platform);
  const pathImpl = useWin32 ? path.win32 : path.posix;

  let current = pathImpl.dirname(normalizedPath);
  for (let i = 0; i < 32 && current && current !== '.'; i++) {
    if (isUntrustedUncPath(current, platform, config)) {
      return null;
    }
    const stat = tryStatSync(fsImpl, current);
    if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
      return stripTrailingSeparator(current, useWin32 ? 'win32' : 'linux');
    }
    const next = pathImpl.dirname(current);
    if (!next || next === current) {
      break;
    }
    current = next;
  }
  return null;
}

/**
 * Walk upward from `normalizedPath` asynchronously with timeout protection and pre-stat UNC checks.
 */
async function findNearestExistingParentAsync(
  normalizedPath,
  platform,
  asyncStatImpl,
  config,
  statTimeoutMs,
) {
  const useWin32 = isWindowsPathShape(normalizedPath, platform);
  const pathImpl = useWin32 ? path.win32 : path.posix;

  let current = pathImpl.dirname(normalizedPath);
  for (let i = 0; i < 32 && current && current !== '.'; i++) {
    if (isUntrustedUncPath(current, platform, config)) {
      return null;
    }
    const stat = await tryStatAsync(asyncStatImpl, current, statTimeoutMs);
    if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
      return stripTrailingSeparator(current, useWin32 ? 'win32' : 'linux');
    }
    const next = pathImpl.dirname(current);
    if (!next || next === current) {
      break;
    }
    current = next;
  }
  return null;
}

/**
 * Parse and normalize a raw candidate prior to filesystem probing.
 * Guarantees pre-stat interception of untrusted Windows UNC / device paths.
 */
function prepareTargetCandidate(input, options = {}) {
  const inputObj = typeof input === 'object' && input !== null ? input : null;
  const opts = { ...options, ...(inputObj || {}) };

  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || lookupEnv(env, 'HOME') || lookupEnv(env, 'USERPROFILE') || homedir();
  const config = opts.config || {};
  const safeWorkspaceRoots = filterSafeWorkspaceRoots(opts.workspaceRoots, platform, config);
  const isInlineCode = Boolean(opts.isInlineCode);

  const rawSource =
    typeof input === 'string'
      ? input
      : (inputObj?.rawUri ?? inputObj?.text ?? '');
  const trimmed = stripSurroundingPunctuation(String(rawSource ?? ''));

  if (!trimmed) {
    return { done: true, opts, result: { kind: 'passthrough', reason: 'unrecognized_target' } };
  }

  const inlineOriginalText =
    inputObj?.text !== undefined
      ? stripSurroundingPunctuation(String(inputObj.text))
      : trimmed;

  // 1. External scheme check (http://, https://, mailto:, vscode://, etc.)
  if (isExternalScheme(trimmed)) {
    return {
      done: true,
      opts,
      result: {
        kind: 'passthrough',
        reason: 'external_scheme',
        raw: trimmed,
      },
    };
  }

  let candidate = trimmed;
  let line = null;
  let column = null;
  let endLine = null;
  let explicitPathLike = false;
  let isExplicitUri = false;

  // 2. Parse file:// URI or plain path/token
  if (/^file:/i.test(trimmed)) {
    explicitPathLike = true;
    isExplicitUri = true;
    const parsed = parseFileUri(trimmed, platform);
    candidate = parsed.pathStr;
    line = parsed.line;
    column = parsed.column;
    endLine = parsed.endLine;
  } else {
    const anchorStripped = stripTrailingLineAnchor(trimmed);
    candidate = anchorStripped.cleanPath;
    line = anchorStripped.line;
    column = anchorStripped.column;
    endLine = anchorStripped.endLine;

    const envExpanded = expandEnvAndTilde(candidate, env, homeDir);
    candidate = envExpanded.expanded;
    if (envExpanded.hadExpansion) {
      explicitPathLike = true;
    }
  }

  const wslMapped = mapWslMountPath(candidate, platform);
  candidate = wslMapped.mapped;
  if (wslMapped.wasMapped) {
    explicitPathLike = true;
  }

  // 3. CRITICAL SECURITY BOUNDARY: Pre-stat external UNC & device path check on Windows (Patch P3)
  if (platform === 'win32') {
    const uncInfo = parseUncPath(candidate);
    if (uncInfo.isUnc) {
      const normalizedUnc = normalizeTargetPath(candidate, 'win32');
      if (isUntrustedUncPath(candidate, 'win32', config)) {
        return {
          done: true,
          opts,
          result: {
            kind: 'untrusted_unc',
            normalizedPath: normalizedUnc,
            line,
            column,
            endLine,
            ext: path.win32.extname(normalizedUnc).toLowerCase(),
            fileName: path.win32.basename(normalizedUnc) || normalizedUnc,
            fileUrl: '',
          },
        };
      }
      explicitPathLike = true;
    } else if (uncInfo.isTrustedDevicePath) {
      explicitPathLike = true;
    }
  }

  // 3.5 Fail closed on Windows NTFS Alternate Data Streams (`:` after drive letter, e.g. `evil.vbs::$DATA`)
  if (platform === 'win32' && hasNtfsAdsStream(candidate)) {
    return {
      done: true,
      opts,
      result: {
        kind: 'passthrough',
        reason: 'ntfs_ads_blocked',
        raw: trimmed,
      },
    };
  }

  // 4. Determine whether candidate is absolute or relative
  const uncCheck = platform === 'win32' ? parseUncPath(candidate) : { isUnc: false };
  const isWinDriveAbs = /^[A-Za-z]:([\\/]|$)/.test(candidate);
  const isPosixAbs = candidate.startsWith('/') && !candidate.startsWith('//') && !uncCheck.isUnc;
  const isTrustedUncOrDevice =
    platform === 'win32' && (uncCheck.isUnc || Boolean(uncCheck.isTrustedDevicePath));
  const isAbsoluteTarget = isWinDriveAbs || isPosixAbs || isTrustedUncOrDevice;

  if (isAbsoluteTarget) {
    explicitPathLike = true;
  }

  const hasLineAnchor = line !== null;
  const knownExtensions = getKnownExtensionSet(config);

  if (!explicitPathLike && !looksLikeRelativePath(candidate, hasLineAnchor, knownExtensions)) {
    if (isInlineCode && inlineOriginalText.length > 0) {
      return {
        done: true,
        opts,
        result: {
          kind: 'inline_code_text',
          text: inlineOriginalText,
        },
      };
    }
    return {
      done: true,
      opts,
      result: { kind: 'passthrough', reason: 'unrecognized_target' },
    };
  }

  // 5. Build candidate filesystem paths to probe (Patch P4: NEVER fall back to process.cwd()!)
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const probePaths = [];

  if (isAbsoluteTarget) {
    probePaths.push(normalizeTargetPath(candidate, platform));
  } else {
    for (const root of safeWorkspaceRoots) {
      const useWinRoot = isWindowsPathShape(root, platform);
      const joined = (useWinRoot ? path.win32 : path.posix).resolve(root, candidate);
      probePaths.push(stripTrailingSeparator(joined, useWinRoot ? 'win32' : 'linux'));
    }
    // Only use explicit non-null cwd if caller deliberately supplied one (never process.cwd())
    if (probePaths.length === 0 && typeof opts.cwd === 'string' && opts.cwd.trim().length > 0) {
      const explicitCwd = opts.cwd.trim();
      if (!isUntrustedUncPath(explicitCwd, platform, config)) {
        probePaths.push(stripTrailingSeparator(pathImpl.resolve(explicitCwd, candidate), platform));
      }
    }
  }

  if (probePaths.length === 0) {
    if (isInlineCode && inlineOriginalText.length > 0) {
      return {
        done: true,
        opts,
        result: {
          kind: 'inline_code_text',
          text: inlineOriginalText,
        },
      };
    }
    return {
      done: true,
      opts,
      result: { kind: 'passthrough', reason: 'no_workspace_roots' },
    };
  }

  return {
    done: false,
    opts,
    platform,
    config,
    safeWorkspaceRoots,
    isInlineCode,
    isExplicitUri,
    inlineOriginalText,
    line,
    column,
    endLine,
    probePaths,
  };
}

function buildResolvedFileOrDirResult(probePath, stat, state) {
  const { platform, safeWorkspaceRoots, line, column, endLine } = state;
  const useWin = isWindowsPathShape(probePath, platform);
  const activePathImpl = useWin ? path.win32 : path.posix;
  const fileName = activePathImpl.basename(probePath) || probePath;
  const relativePath = computeRelativePath(probePath, safeWorkspaceRoots, platform);
  const fileUrl = encodePathToFileUrl(probePath, platform);

  if (typeof stat.isFile === 'function' && stat.isFile()) {
    return {
      kind: 'existing_file',
      normalizedPath: probePath,
      parentDir: stripTrailingSeparator(activePathImpl.dirname(probePath), useWin ? 'win32' : 'linux'),
      fileName,
      relativePath,
      fileUrl,
      line,
      column,
      endLine,
      ext: activePathImpl.extname(probePath).toLowerCase(),
      sizeBytes: stat.size ?? 0,
      mtimeMs: stat.mtimeMs ?? 0,
    };
  }

  if (typeof stat.isDirectory === 'function' && stat.isDirectory()) {
    return {
      kind: 'existing_directory',
      normalizedPath: probePath,
      fileName,
      relativePath,
      fileUrl,
      mtimeMs: stat.mtimeMs ?? 0,
    };
  }

  return null;
}

function buildUntrustedUncResult(probePath, state) {
  const { line, column, endLine } = state;
  return {
    kind: 'untrusted_unc',
    normalizedPath: probePath,
    fileName: path.win32.basename(probePath) || probePath,
    fileUrl: '',
    line,
    column,
    endLine,
    ext: path.win32.extname(probePath).toLowerCase(),
  };
}

function buildMissingPathResult(primaryPath, nearestExistingParent, state) {
  const { platform, safeWorkspaceRoots, line, column, endLine } = state;
  const useWin = isWindowsPathShape(primaryPath, platform);
  const activePathImpl = useWin ? path.win32 : path.posix;
  return {
    kind: 'missing_path',
    normalizedPath: primaryPath,
    parentDir: stripTrailingSeparator(activePathImpl.dirname(primaryPath), useWin ? 'win32' : 'linux'),
    nearestExistingParent,
    fileName: activePathImpl.basename(primaryPath) || primaryPath,
    relativePath: computeRelativePath(primaryPath, safeWorkspaceRoots, platform),
    fileUrl: encodePathToFileUrl(primaryPath, platform),
    line,
    column,
    endLine,
    ext: activePathImpl.extname(primaryPath).toLowerCase(),
  };
}

/**
 * Resolve a raw chat link, path, or inline code token synchronously.
 * Guarantees pre-stat interception of untrusted Windows UNC paths and never falls back to `process.cwd()`.
 * @param {string | Record<string, any>} input
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function resolveTarget(input, options = {}) {
  const state = prepareTargetCandidate(input, options);
  if (state.done) {
    return state.result;
  }

  const fsImpl = state.opts.fsImpl || fs;
  const { platform, config, probePaths } = state;

  for (const probePath of probePaths) {
    if (isUntrustedUncPath(probePath, platform, config)) {
      return buildUntrustedUncResult(probePath, state);
    }

    const stat = tryStatSync(fsImpl, probePath);
    if (!stat) {
      continue;
    }

    const hit = buildResolvedFileOrDirResult(probePath, stat, state);
    if (hit) {
      return hit;
    }
  }

  const primaryPath = probePaths[0];
  if (isUntrustedUncPath(primaryPath, platform, config)) {
    return buildUntrustedUncResult(primaryPath, state);
  }

  const nearestExistingParent = findNearestExistingParentSync(primaryPath, platform, fsImpl, config);
  return buildMissingPathResult(primaryPath, nearestExistingParent, state);
}

/**
 * Resolve a raw chat link, path, or inline code token asynchronously with `stat` timeout protection (Patch P5).
 * @param {string | Record<string, any>} input
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function resolveTargetAsync(input, options = {}) {
  const state = prepareTargetCandidate(input, options);
  if (state.done) {
    return state.result;
  }

  const asyncStatImpl = resolveAsyncStatFn(state.opts);
  const statTimeoutMs =
    state.opts.statTimeoutMs ?? state.config?.statTimeoutMs ?? DEFAULT_STAT_TIMEOUT_MS;
  const { platform, config, probePaths } = state;

  for (const probePath of probePaths) {
    if (isUntrustedUncPath(probePath, platform, config)) {
      return buildUntrustedUncResult(probePath, state);
    }

    const stat = await tryStatAsync(asyncStatImpl, probePath, statTimeoutMs);
    if (!stat) {
      continue;
    }

    const hit = buildResolvedFileOrDirResult(probePath, stat, state);
    if (hit) {
      return hit;
    }
  }

  const primaryPath = probePaths[0];
  if (isUntrustedUncPath(primaryPath, platform, config)) {
    return buildUntrustedUncResult(primaryPath, state);
  }

  const nearestExistingParent = await findNearestExistingParentAsync(
    primaryPath,
    platform,
    asyncStatImpl,
    config,
    statTimeoutMs,
  );
  return buildMissingPathResult(primaryPath, nearestExistingParent, state);
}

/**
 * Fuse multiple extracted UI candidates according to Patch P4 & P5:
 * 1. Never falls back to `process.cwd()` when `workspaceRoots` is empty.
 * 2. Strips untrusted UNC roots from `workspaceRoots` before probing.
 * 3. Scans sorted by `SOURCE_PRIORITY` descending:
 *    - Immediately returns `existing_file` / `existing_directory`.
 *    - Immediately returns `passthrough` on `external_scheme` from a high-priority explicit link.
 *    - Records first high-priority explicit `bestMissing` and first `bestUntrustedUnc`.
 *    - If an `untrusted_unc` is hit and no higher-priority `bestMissing` has been seen yet,
 *      immediately returns `untrusted_unc` with zero `stat` calls.
 *    - Final fallback precedence: `bestMissing > bestUntrustedUnc > inline_code_text > passthrough`.
 *
 * @param {object} [params]
 * @param {Array<{ source?: string, value?: string, linkText?: string, isInlineCode?: boolean }>} [params.candidates]
 * @param {string[]} [params.workspaceRoots]
 * @param {string} [params.conversationId]
 * @param {WorkspaceRootResolver} [params.rootResolver]
 * @param {string[]} [params.hintDirs]
 * @param {Record<string, any>} [params.config]
 * @param {NodeJS.Platform} [params.platform]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {string} [params.homeDir]
 * @param {(p: string) => Promise<any>} [params.asyncStatImpl]
 * @param {any} [params.fsImpl]
 * @param {number} [params.statTimeoutMs]
 * @returns {Promise<Record<string, any>>}
 */
export async function resolveBestTargetWithEngine({
  candidates = [],
  workspaceRoots,
  conversationId,
  rootResolver,
  hintDirs = [],
  config = {},
  platform = process.platform,
  env = process.env,
  homeDir,
  asyncStatImpl,
  fsImpl,
  statTimeoutMs,
} = {}) {
  let effectiveRoots = workspaceRoots;
  if (!Array.isArray(effectiveRoots)) {
    if (rootResolver && typeof rootResolver.getRoots === 'function') {
      effectiveRoots = await rootResolver.getRoots({ conversationId, hintDirs });
    } else {
      effectiveRoots = [];
    }
  }

  const safeRoots = filterSafeWorkspaceRoots(effectiveRoots, platform, config);

  const sorted = [...(Array.isArray(candidates) ? candidates : [])].sort(
    (a, b) => (SOURCE_PRIORITY[b?.source] || 0) - (SOURCE_PRIORITY[a?.source] || 0),
  );

  let bestMissing = null;
  let bestUntrustedUnc = null;
  let bestInlineCode = null;
  let bestPassthrough = null;

  for (const item of sorted) {
    if (!item || typeof item.value !== 'string') {
      continue;
    }

    const source = item.source || 'unknown';
    const isInlineCode = source === 'inline-code' || Boolean(item.isInlineCode);
    const trimmedRaw = stripSurroundingPunctuation(item.value);
    if (!trimmedRaw) {
      continue;
    }

    const isHighPriorityExplicit =
      HIGH_PRIORITY_EXPLICIT_SOURCES.has(source) || /^file:/i.test(trimmedRaw);

    const res = await resolveTargetAsync(
      {
        rawUri: item.value,
        text: item.value,
        isInlineCode,
      },
      {
        workspaceRoots: safeRoots,
        cwd: null,
        config,
        platform,
        env,
        homeDir,
        asyncStatImpl,
        fsImpl,
        statTimeoutMs,
      },
    );

    if (res.kind === 'existing_file' || res.kind === 'existing_directory') {
      return {
        ...res,
        source,
        linkText: item.linkText || '',
      };
    }

    if (res.kind === 'passthrough' && res.reason === 'external_scheme') {
      if (isHighPriorityExplicit) {
        return {
          ...res,
          source,
          linkText: item.linkText || '',
        };
      }
      if (!bestPassthrough) {
        bestPassthrough = { ...res, source, linkText: item.linkText || '' };
      }
      continue;
    }

    if (res.kind === 'untrusted_unc') {
      const enriched = {
        ...res,
        source,
        linkText: item.linkText || '',
      };
      if (!bestUntrustedUnc) {
        bestUntrustedUnc = enriched;
      }
      // Only short-circuit immediately if no higher-priority explicit missing_path was already seen
      if (!bestMissing) {
        return enriched;
      }
      continue;
    }

    if (res.kind === 'missing_path') {
      if (isHighPriorityExplicit) {
        if (!bestMissing) {
          bestMissing = {
            ...res,
            source,
            linkText: item.linkText || '',
          };
        }
      } else if (isInlineCode && !bestInlineCode) {
        bestInlineCode = {
          kind: 'inline_code_text',
          text: trimmedRaw,
          source,
          linkText: item.linkText || '',
        };
      }
      continue;
    }

    if (res.kind === 'inline_code_text') {
      if (!bestInlineCode) {
        bestInlineCode = {
          ...res,
          source,
          linkText: item.linkText || '',
        };
      }
      continue;
    }

    if (!bestPassthrough) {
      bestPassthrough = {
        ...res,
        source,
        linkText: item.linkText || '',
      };
    }
  }

  return (
    bestMissing ||
    bestUntrustedUnc ||
    bestInlineCode ||
    bestPassthrough || { kind: 'passthrough', reason: 'unrecognized_target' }
  );
}

function decodeFileUriToPath(uriString, platform) {
  let parsed;
  try {
    parsed = new URL(uriString);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') {
    return null;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || '');
  } catch {
    pathname = parsed.pathname || '';
  }

  const host = parsed.hostname || '';
  if (platform === 'win32') {
    if (host && host.toLowerCase() !== 'localhost') {
      return `\\\\${host}${pathname.replace(/\//g, '\\')}`;
    }
    if (/^\/[a-zA-Z]:(?:\/|$)/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, '\\');
  }

  if (host && host.toLowerCase() !== 'localhost') {
    return `//${host}${pathname}`;
  }
  return pathname;
}

function collectFolderUrisFromProject(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectFolderUrisFromProject(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'folderUri' && typeof value === 'string') {
      out.push(value);
    } else if (value && typeof value === 'object') {
      collectFolderUrisFromProject(value, out);
    }
  }
}

async function readProjectRootsAsync(projectsDir, projectId, platform, config) {
  if (!projectsDir || !projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
    return [];
  }
  try {
    const filePath = path.join(projectsDir, `${projectId}.json`);
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    const uris = [];
    collectFolderUrisFromProject(parsed?.projectResources, uris);
    return uris
      .map((uri) => decodeFileUriToPath(uri, platform))
      .filter((p) => Boolean(p) && !isUntrustedUncPath(p, platform, config));
  } catch {
    return [];
  }
}

async function readAllRecentProjectRootsAsync(projectsDir, platform, config) {
  if (!projectsDir) return [];
  try {
    const entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
    const roots = [];
    for (const name of entries) {
      try {
        const parsed = JSON.parse(await readFile(path.join(projectsDir, name), 'utf8'));
        const uris = [];
        collectFolderUrisFromProject(parsed?.projectResources, uris);
        for (const uri of uris) {
          const decoded = decodeFileUriToPath(uri, platform);
          if (decoded && !isUntrustedUncPath(decoded, platform, config)) {
            roots.push(decoded);
          }
        }
      } catch {
        // skip unreadable project metadata
      }
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Resolves workspace roots for a conversation asynchronously, filtering out untrusted UNC roots.
 */
export class WorkspaceRootResolver {
  constructor({
    platform = process.platform,
    projectsDir,
    brainDir,
    scratchDir,
    getConversationMetadata,
    config = {},
    ttlMs = 30_000,
  } = {}) {
    this.platform = platform;
    this.projectsDir = projectsDir;
    this.brainDir = brainDir;
    this.scratchDir = scratchDir;
    this.getConversationMetadata = getConversationMetadata;
    this.config = config;
    this.ttlMs = ttlMs;
    this.liveWorkspaceUris = [];
    this.cache = new Map();
  }

  setLiveWorkspaceUris(uris) {
    if (Array.isArray(uris)) {
      this.liveWorkspaceUris = uris.filter((u) => typeof u === 'string');
      this.cache.clear();
    }
  }

  async getRoots({ conversationId, hintDirs = [] } = {}) {
    const cacheKey = conversationId || '__default__';
    const cached = this.cache.get(cacheKey);
    const roots = [];

    for (const uri of this.liveWorkspaceUris) {
      const decoded = decodeFileUriToPath(uri, this.platform);
      if (decoded && !isUntrustedUncPath(decoded, this.platform, this.config)) {
        roots.push(decoded);
      }
    }

    let resolvedFromConv = null;
    if (cached && Date.now() - cached.at < this.ttlMs) {
      resolvedFromConv = cached.roots;
    } else {
      const convRoots = [];
      if (conversationId && UUID_RE.test(conversationId)) {
        if (typeof this.getConversationMetadata === 'function') {
          try {
            const meta = await this.getConversationMetadata(conversationId);
            const metaEvent = meta?.response?.conversationMetadata || meta?.response?.conversation_metadata;
            const projectId = metaEvent?.metadata?.projectId || metaEvent?.metadata?.project_id;
            if (projectId) {
              convRoots.push(
                ...(await readProjectRootsAsync(this.projectsDir, projectId, this.platform, this.config)),
              );
            }
          } catch {
            // metadata lookup is best-effort
          }
        }
        if (this.brainDir) {
          const brainConvDir = path.join(this.brainDir, conversationId);
          convRoots.push(brainConvDir, path.join(brainConvDir, 'scratch'));
        }
      }
      this.cache.set(cacheKey, { at: Date.now(), roots: convRoots });
      resolvedFromConv = convRoots;
    }

    roots.push(...resolvedFromConv);

    for (const dir of hintDirs) {
      if (typeof dir === 'string' && dir.trim()) {
        const trimmed = stripSurroundingPunctuation(dir);
        if (!trimmed || isExternalScheme(trimmed)) {
          continue;
        }
        const state = prepareTargetCandidate(trimmed, {
          platform: this.platform,
          config: this.config,
          cwd: null,
        });
        if (!state.done && state.probePaths.length > 0) {
          const candidateDir = state.probePaths[0];
          if (!isUntrustedUncPath(candidateDir, this.platform, this.config)) {
            roots.push(candidateDir);
          }
        }
      }
    }

    if (this.scratchDir && !isUntrustedUncPath(this.scratchDir, this.platform, this.config)) {
      roots.push(this.scratchDir);
    }

    if (roots.length === 0 || !conversationId) {
      roots.push(...(await readAllRecentProjectRootsAsync(this.projectsDir, this.platform, this.config)));
    }

    const seen = new Set();
    const unique = [];
    for (const root of roots) {
      if (!root || isUntrustedUncPath(root, this.platform, this.config)) {
        continue;
      }
      const key = this.platform === 'win32' ? root.toLowerCase() : root;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(root);
      }
    }
    return unique;
  }
}
