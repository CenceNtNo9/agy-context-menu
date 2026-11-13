import path from 'node:path';

export const DEFAULT_EXECUTABLE_EXTENSIONS = Object.freeze([
  '.exe', '.msi', '.bat', '.cmd', '.ps1',
  '.vbs', '.vbe', '.jse', '.wsf', '.wsh',
  '.hta', '.reg', '.scr', '.com', '.pif',
  '.lnk', '.msc', '.cpl', '.command', '.pkg', '.dmg',
  '.url', '.chm', '.jar', '.appref-ms', '.application',
  '.msp', '.msix', '.msixbundle', '.appx', '.appxbundle',
  '.appinstaller', '.scf', '.inf', '.settingcontent-ms', '.xll',
  '.ws', '.wsc', '.psm1', '.psd1', '.iso', '.img',
  '.vhd', '.vhdx', '.library-ms', '.search-ms', '.diagcab',
  '.gadget', '.hlp',
]);

export const DEFAULT_SOURCE_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw', ".rs", '.go', '.java', '.kt', '.kts',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
  '.cs', '.fs', '.vb', '.vue', '.svelte', '.astro',
  '.sh', '.bash', '.zsh', '.fish',
  '.yaml', '.yml', '.toml', '.json', '.jsonc', '.json5',
  '.sql', '.css', '.scss', '.sass', '.less',
  '.xml',
  '.mdx', '.txt', '.log', '.ini', '.cfg', '.conf', '.env',
  '.rb', '.php', '.lua', '.r', '.swift', '.dart', '.zig', '.nim',
  '.ex', '.exs', '.erl', '.clj', '.graphql', '.gql', '.proto', '.prisma',
]);

export const DEFAULT_TRUSTED_UNC_HOSTS = Object.freeze([
  'wsl.localhost',
  'wsl$',
  'localhost',
  '127.0.0.1',
]);

const LEADING_UNC_SLASHES_RE = /^(?:[\\/]|%5[cC]|%2[fF]){2,}/;
const DEVICE_DRIVE_SEGMENT_RE = /^[A-Za-z]:$/;
const DEVICE_VOLUME_GUID_RE = /^Volume\{[0-9a-fA-F-]{8,64}\}$/i;

/**
 * Parse a potential Windows UNC or Win32 device namespace path
 * (`\\host\share\...`, `///host/share/...`, `\\?\C:\...`, `\\?\GLOBALROOT\...`, `\\?\UNC\...`, `%5C%5Chost%5Cshare`).
 *
 * Patch P3:
 * - `\\?\` and `\\.\` are trusted ONLY when immediately followed by a local drive letter (`X:\`)
 *   or `Volume{GUID}\`. All other device namespaces (`GLOBALROOT`, `UNC`, `Pipe`, etc.) are
 *   classified as untrusted (`isUnc: true, isDevicePath: true, isTrustedDevicePath: false`).
 * - WebDAV host syntax containing `@` (e.g. `host@SSL`, `localhost@80`) is never trusted.
 * - 3+ leading slashes or mixed/encoded separators (`///`, `\/`, `/\`, `%5C%5C`) are caught.
 *
 * @param {string} rawPath
 * @returns {{
 *   isUnc: boolean,
 *   host?: string,
 *   share?: string,
 *   isDevicePath?: boolean,
 *   isTrustedDevicePath?: boolean,
 *   isDeviceUnc?: boolean,
 * }}
 */
export function parseUncPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length < 3) {
    return { isUnc: false };
  }

  if (!LEADING_UNC_SLASHES_RE.test(rawPath)) {
    return { isUnc: false };
  }

  const slashNormalized = rawPath.replace(/%5[cC]|%2[fF]/g, '\\');
  const stripped = slashNormalized.replace(/^[\\/]+/, '');
  if (!stripped) {
    return { isUnc: false };
  }

  const segments = stripped.split(/[\\/]/);
  const first = segments[0] || '';
  const second = segments[1] || '';

  if (!first) {
    return { isUnc: false };
  }

  // Win32 device namespace: \\?\... or \\.\...
  if (first === '?' || first === '.') {
    // Trusted ONLY when immediately followed by drive letter `X:` or `Volume{GUID}`
    if (DEVICE_DRIVE_SEGMENT_RE.test(second) || DEVICE_VOLUME_GUID_RE.test(second)) {
      return {
        isUnc: false,
        host: first,
        share: second,
        isDevicePath: true,
        isTrustedDevicePath: true,
        isDeviceUnc: false,
      };
    }

    // \\?\UNC\server\share\... -> untrusted device UNC
    if (second.toUpperCase() === 'UNC') {
      const uncHost = segments[2] || first;
      const uncShare = segments[3] || '';
      return {
        isUnc: true,
        host: uncHost,
        share: uncShare,
        isDevicePath: true,
        isTrustedDevicePath: false,
        isDeviceUnc: true,
      };
    }

    // Any other device namespace (e.g. \\?\GLOBALROOT\Device\Mup\..., \\.\GLOBALROOT\..., \\?\Pipe\...)
    return {
      isUnc: true,
      host: first,
      share: second,
      isDevicePath: true,
      isTrustedDevicePath: false,
      isDeviceUnc: false,
    };
  }

  return {
    isUnc: true,
    host: first,
    share: second,
    isDevicePath: false,
    isTrustedDevicePath: false,
    isDeviceUnc: false,
  };
}

/**
 * Check if a UNC host is in the trusted local/WSL allowlist.
 * Rejects `?`, `.`, and WebDAV `@SSL` / `@port` host qualifiers unconditionally.
 * @param {string} host
 * @param {Record<string, any>} [config]
 * @returns {boolean}
 */
export function isTrustedUncHost(host, config = {}) {
  if (!host || typeof host !== 'string') {
    return false;
  }

  const normalizedHost = host.toLowerCase();
  // Never trust Win32 device markers as UNC hosts, and reject WebDAV @SSL / @80 qualifiers
  if (normalizedHost === '?' || normalizedHost === '.' || normalizedHost.includes('@')) {
    return false;
  }

  const allowlist = Array.isArray(config?.trustedUncHosts)
    ? config.trustedUncHosts
    : DEFAULT_TRUSTED_UNC_HOSTS;

  return allowlist.some((item) => {
    const allowed = String(item).toLowerCase();
    return allowed !== '?' && allowed !== '.' && allowed === normalizedHost;
  });
}

/**
 * Determine whether `targetPath` is an untrusted Windows UNC or untrusted device path
 * that must never be passed to `stat` or shell execution without explicit confirmation.
 * @param {string} targetPath
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, any>} [config]
 * @returns {boolean}
 */
export function isUntrustedUncPath(targetPath, platform = process.platform, config = {}) {
  if (platform !== 'win32' || typeof targetPath !== 'string' || !targetPath) {
    return false;
  }
  let candidate = targetPath.trim();
  if (/^file:/i.test(candidate)) {
    let rest = candidate.slice(5).split('#')[0];
    const queryStart = /^\/+\?(?:\/|$)/.test(rest) ? rest.indexOf('?') + 1 : 0;
    const queryIdx = rest.indexOf('?', queryStart);
    if (queryIdx !== -1) {
      rest = rest.slice(0, queryIdx);
    }
    if (/^\/{4,}/.test(rest)) {
      candidate = `\\\\${rest.replace(/^\/+/, '').replace(/\//g, '\\')}`;
    } else if (rest.startsWith('///')) {
      try {
        candidate = decodeURIComponent(rest.slice(2));
      } catch {
        candidate = rest.slice(2);
      }
    } else if (rest.startsWith('//')) {
      const after = rest.slice(2);
      const slash = after.indexOf('/');
      const host = slash === -1 ? after : after.slice(0, slash);
      const tail = slash === -1 ? '' : after.slice(slash);
      if (host && host.toLowerCase() !== 'localhost' && !/^[A-Za-z](?::|%3A)$/i.test(host)) {
        candidate = `\\\\${host}${tail.replace(/\//g, '\\')}`;
      }
    }
  }
  const uncInfo = parseUncPath(candidate);
  if (!uncInfo.isUnc) {
    return false;
  }
  if (uncInfo.isDevicePath) {
    return !uncInfo.isTrustedDevicePath;
  }
  return !isTrustedUncHost(uncInfo.host, config);
}

/**
 * Check whether an extension is classified as a high-risk executable/script.
 * @param {string} ext
 * @param {Record<string, any>} [config]
 * @returns {boolean}
 */
export function isExecutableExtension(ext, config = {}) {
  if (!ext) {
    return false;
  }
  const list = Array.isArray(config?.executableExtensions)
    ? config.executableExtensions
    : DEFAULT_EXECUTABLE_EXTENSIONS;
  const normalized = ext.toLowerCase();
  return list.some((item) => String(item).toLowerCase() === normalized);
}

/**
 * Check whether an extension is classified as source code or structured text.
 * @param {string} ext
 * @param {Record<string, any>} [config]
 * @returns {boolean}
 */
export function isSourceExtension(ext, config = {}) {
  if (!ext) {
    return false;
  }
  const list = Array.isArray(config?.sourceExtensions)
    ? config.sourceExtensions
    : DEFAULT_SOURCE_EXTENSIONS;
  const normalized = ext.toLowerCase();
  return list.some((item) => String(item).toLowerCase() === normalized);
}

/**
 * Detect whether a Windows path contains an NTFS Alternate Data Stream (`:` after drive prefix).
 * @param {string} targetPath
 * @returns {boolean}
 */
export function hasNtfsAdsStream(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return false;
  }
  const withoutDrive = targetPath.replace(/^(?:\\\\[?.]\\)?[A-Za-z]:/, '');
  return withoutDrive.includes(':');
}

/**
 * Strip any NTFS ADS `:stream` suffix and trailing dots/spaces from a Windows path
 * before extracting the effective file extension, preventing `evil.vbs::$DATA` or
 * `evil.vbs. .` from bypassing executable interception.
 * @param {string} targetPath
 * @returns {string}
 */
function stripAdsAndTrailingWinNoise(targetPath) {
  const drivePrefixMatch = targetPath.match(/^((?:\\\\[?.]\\)?[A-Za-z]:)(.*)$/);
  const prefix = drivePrefixMatch ? drivePrefixMatch[1] : '';
  let body = drivePrefixMatch ? drivePrefixMatch[2] : targetPath;
  const colonIdx = body.indexOf(':');
  if (colonIdx !== -1) {
    body = body.slice(0, colonIdx);
  }
  // Strip trailing dots/spaces (except literal `.` or `..` segments)
  body = body.replace(/([^\\/])[. ]+$/, '$1');
  return prefix + body;
}

function shouldApplyWinNtfsRules(targetPath, platform = process.platform) {
  if (platform === 'win32') {
    return true;
  }
  if (typeof targetPath !== 'string' || !targetPath) {
    return false;
  }
  return /^(?:\\\\|[A-Za-z]:)/.test(targetPath) || /(?:::\$|:Zone\.Identifier\b)/i.test(targetPath);
}

/**
 * Classify how a resolved target should be opened across the 3-tier security & routing policy.
 * Tier 1: Executable / script extension -> requires confirmation
 * Tier 2: Source file or line-anchored target -> route to code editor / plain-text fallback
 * Tier 3: Documents, media, or other files -> open with OS default handler
 * @param {Record<string, any>} target
 * @param {Record<string, any>} [config]
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, any>}
 */
export function classifyOpenStrategy(target, config = {}, platform = process.platform) {
  if (!target || typeof target !== 'object') {
    return { tier: 0, strategy: 'unsupported', requiresConfirmation: false };
  }

  const normalizedPath = typeof target.normalizedPath === 'string' ? target.normalizedPath : '';
  if (target.kind === 'untrusted_unc' || isUntrustedUncPath(normalizedPath, 'win32', config)) {
    return {
      tier: 'untrusted_unc',
      strategy: 'confirm_untrusted_unc',
      requiresConfirmation: true,
      reason: 'untrusted_unc_path',
      targetPath: normalizedPath,
    };
  }

  if (target.kind === 'existing_directory') {
    return {
      tier: 'directory',
      strategy: 'open_directory',
      requiresConfirmation: false,
      targetPath: normalizedPath,
    };
  }

  if (target.kind !== 'existing_file') {
    return {
      tier: 0,
      strategy: 'unsupported',
      requiresConfirmation: false,
      targetKind: target.kind || 'unknown',
    };
  }

  const useWinRules = shouldApplyWinNtfsRules(normalizedPath, platform);
  const sanitizedForExt = useWinRules ? stripAdsAndTrailingWinNoise(normalizedPath) : normalizedPath;
  const ext = (useWinRules ? path.win32.extname(sanitizedForExt) : path.posix.extname(sanitizedForExt)).toLowerCase();

  if (isExecutableExtension(ext, config)) {
    return {
      tier: 1,
      strategy: 'executable_intercept',
      requiresConfirmation: true,
      reason: 'executable_extension',
      ext,
      targetPath: normalizedPath,
    };
  }

  if (useWinRules && hasNtfsAdsStream(normalizedPath)) {
    return {
      tier: 1,
      strategy: 'executable_intercept',
      requiresConfirmation: true,
      reason: 'ntfs_ads_stream',
      ext,
      targetPath: normalizedPath,
    };
  }

  const hasLineAnchor = typeof target.line === 'number' && Number.isFinite(target.line) && target.line > 0;
  if (hasLineAnchor || isSourceExtension(ext, config)) {
    return {
      tier: 2,
      strategy: 'open_in_editor',
      requiresConfirmation: false,
      ext,
      line: hasLineAnchor ? target.line : null,
      column: typeof target.column === 'number' ? target.column : null,
      targetPath: normalizedPath,
    };
  }

  return {
    tier: 3,
    strategy: 'open_default',
    requiresConfirmation: false,
    ext,
    targetPath: normalizedPath,
  };
}
