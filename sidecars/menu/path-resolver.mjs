import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_PRIORITY = {
  'explicit-uri': 6,
  'react-prop': 5,
  'dom-attr': 4,
  'media-src': 3,
  'inline-code': 2,
  'caret-token': 1,
  'selection-text': 1,
};

const DENIED_SCHEMES_RE = /^(?:https?|mailto|data|blob|javascript|about|sidecar|customization|plugin|conversation|vscode):/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_FILE_BARE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'nan', 'infinity',
  'const', 'let', 'var', 'function', 'return', 'import', 'export',
  'async', 'await', 'class', 'interface', 'type', 'enum',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'pip', 'git', 'bash', 'sh',
]);

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function stripSurroundingPunctuation(raw) {
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
  // Strip unmatched trailing closing bracket/paren or period
  if (s.endsWith(')') && !s.includes('(')) {
    s = s.slice(0, -1);
  }
  if (s.endsWith(']') && !s.includes('[')) {
    s = s.slice(0, -1);
  }
  return s.trim();
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

export function encodePathToFileUrl(targetPath, platform = process.platform) {
  if (!targetPath) return '';
  if (platform === 'win32') {
    const normalized = targetPath.replace(/\\/g, '/');
    if (normalized.startsWith('//')) {
      // UNC path \\host\share\... -> file://host/share/...
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

function extractLineAndColFromFragment(fragment) {
  if (!fragment) return {};
  const clean = fragment.replace(/^#/, '');
  const match = clean.match(/^L?(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/i);
  if (!match) return {};
  const line = Number(match[1]);
  const col = match[2] ? Number(match[2]) : undefined;
  const endLine = match[3] ? Number(match[3]) : undefined;
  return {
    line: Number.isSafeInteger(line) && line > 0 ? line : undefined,
    col: Number.isSafeInteger(col) && col > 0 ? col : undefined,
    endLine: Number.isSafeInteger(endLine) && endLine > 0 ? endLine : undefined,
  };
}

function extractLineAndColFromSuffix(rawPath) {
  // Check parenthesis stack trace format: file.cs(42,10) or file.ts(42)
  const parenMatch = rawPath.match(/^(.*?)\((\d+)(?:,(\d+))?\)$/);
  if (parenMatch && parenMatch[1]) {
    return {
      cleanPath: parenMatch[1],
      line: Number(parenMatch[2]),
      col: parenMatch[3] ? Number(parenMatch[3]) : undefined,
    };
  }

  // Check #L42-L58 or #L42C10 on plain paths
  const hashIdx = rawPath.lastIndexOf('#');
  if (hashIdx > 0) {
    const frag = extractLineAndColFromFragment(rawPath.slice(hashIdx));
    if (frag.line) {
      return {
        cleanPath: rawPath.slice(0, hashIdx),
        ...frag,
      };
    }
  }

  // Check :line or :line:col (must NOT confuse Windows drive letter C:\... with :line)
  const colonMatch = rawPath.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (colonMatch && colonMatch[1] && !/^[a-zA-Z]$/.test(colonMatch[1])) {
    return {
      cleanPath: colonMatch[1],
      line: Number(colonMatch[2]),
      col: colonMatch[3] ? Number(colonMatch[3]) : undefined,
    };
  }

  return { cleanPath: rawPath };
}

function isAbsolutePathForPlatform(candidate, platform) {
  if (!candidate) return false;
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(candidate) || /^\\\\[^\\]+\\[^\\]+/.test(candidate);
  }
  return candidate.startsWith('/');
}

function looksLikeRelativePath(candidate) {
  if (!candidate || candidate.length > 500 || /[\r\n\t]/.test(candidate)) {
    return false;
  }
  if (DENIED_SCHEMES_RE.test(candidate)) {
    return false;
  }
  if (/^v?\d+(?:\.\d+){1,3}(?:-[\w.]+)?$/i.test(candidate)) {
    return false;
  }
  const lower = candidate.toLowerCase();
  if (NON_FILE_BARE_WORDS.has(lower)) {
    return false;
  }
  if (candidate.includes('/') || candidate.includes('\\')) {
    return !/\s{2,}/.test(candidate);
  }
  // Single-segment file name like package.json, README.md, .gitignore
  return /^[a-zA-Z0-9_.\-\u4e00-\u9fff]+\.[a-zA-Z0-9]{1,12}$/.test(candidate) || /^\.[a-zA-Z0-9_.-]+$/.test(candidate);
}

/**
 * Parses a raw DOM/link/code/selection candidate into a normalized path structure.
 */
export function parseRawCandidate(raw, { platform = process.platform, homeDir = homedir() } = {}) {
  const cleaned = stripSurroundingPunctuation(raw);
  if (!cleaned || cleaned.length > 2048 || /[\r\n]/.test(cleaned)) {
    return null;
  }
  if (DENIED_SCHEMES_RE.test(cleaned)) {
    return null;
  }

  const pApi = pathApiFor(platform);
  let isExplicitUri = false;
  let pathPart = cleaned;
  let line;
  let endLine;
  let col;

  if (/^file:\/\//i.test(cleaned)) {
    isExplicitUri = true;
    let parsedUrl;
    try {
      parsedUrl = new URL(cleaned);
    } catch {
      return null;
    }
    const frag = extractLineAndColFromFragment(parsedUrl.hash);
    line = frag.line;
    endLine = frag.endLine;
    col = frag.col;
    parsedUrl.hash = '';
    const decoded = decodeFileUriToPath(parsedUrl.href, platform);
    if (!decoded) return null;
    pathPart = decoded;
  } else {
    const extracted = extractLineAndColFromSuffix(cleaned);
    pathPart = extracted.cleanPath;
    line = extracted.line;
    endLine = extracted.endLine;
    col = extracted.col;
  }

  if (!pathPart) return null;

  // Home directory expansion
  if (pathPart === '~') {
    pathPart = homeDir;
  } else if (pathPart.startsWith('~/') || pathPart.startsWith('~\\')) {
    pathPart = pApi.join(homeDir, pathPart.slice(2));
  }

  // WSL /mnt/<drive>/... convenience mapping on Windows when not literal
  if (platform === 'win32' && /^\/mnt\/([a-zA-Z])\/(.*)$/.test(pathPart)) {
    const match = pathPart.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    pathPart = `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
  }

  if (platform === 'win32' && !pathPart.startsWith('/') && pathPart.includes('/')) {
    // Normalize forward slashes on Windows absolute/relative paths (e.g. C:/foo/bar or src/foo.ts)
    if (/^[a-zA-Z]:\//.test(pathPart) || !pathPart.startsWith('/')) {
      pathPart = pathPart.replace(/\//g, '\\');
    }
  }

  const isAbsolute = isAbsolutePathForPlatform(pathPart, platform);
  if (isAbsolute) {
    pathPart = pApi.normalize(pathPart);
  }

  if (!isExplicitUri && !isAbsolute && !looksLikeRelativePath(pathPart)) {
    return null;
  }

  return {
    raw: cleaned,
    path: pathPart,
    isExplicitUri,
    isAbsolute,
    line,
    endLine,
    col,
  };
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

function readProjectRoots(projectsDir, projectId, platform) {
  if (!projectsDir || !projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
    return [];
  }
  try {
    const filePath = path.join(projectsDir, `${projectId}.json`);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const uris = [];
    collectFolderUrisFromProject(parsed?.projectResources, uris);
    return uris
      .map((uri) => decodeFileUriToPath(uri, platform))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readAllRecentProjectRoots(projectsDir, platform) {
  if (!projectsDir) return [];
  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
    const roots = [];
    for (const name of entries) {
      try {
        const parsed = JSON.parse(readFileSync(path.join(projectsDir, name), 'utf8'));
        const uris = [];
        collectFolderUrisFromProject(parsed?.projectResources, uris);
        for (const uri of uris) {
          const decoded = decodeFileUriToPath(uri, platform);
          if (decoded) roots.push(decoded);
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

export class WorkspaceRootResolver {
  constructor({
    platform = process.platform,
    projectsDir,
    brainDir,
    scratchDir,
    getConversationMetadata,
    ttlMs = 30_000,
  }) {
    this.platform = platform;
    this.projectsDir = projectsDir;
    this.brainDir = brainDir;
    this.scratchDir = scratchDir;
    this.getConversationMetadata = getConversationMetadata;
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
      if (decoded) roots.push(decoded);
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
              convRoots.push(...readProjectRoots(this.projectsDir, projectId, this.platform));
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
        const parsed = parseRawCandidate(dir, { platform: this.platform });
        if (parsed?.isAbsolute) {
          roots.push(parsed.path);
        }
      }
    }

    if (this.scratchDir) {
      roots.push(this.scratchDir);
    }

    // Fallback: include workspace folders registered in ~/.gemini/config/projects
    if (roots.length === 0 || !conversationId) {
      roots.push(...readAllRecentProjectRoots(this.projectsDir, this.platform));
    }

    // Deduplicate while preserving order
    const seen = new Set();
    const unique = [];
    for (const root of roots) {
      const key = this.platform === 'win32' ? root.toLowerCase() : root;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(root);
      }
    }
    return unique;
  }
}

async function defaultStat(targetPath) {
  const st = await stat(targetPath);
  return {
    isDirectory: st.isDirectory(),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function findNearestExistingDir(targetPath, { platform, existsSyncFn = existsSync }) {
  const pApi = pathApiFor(platform);
  let cur = pApi.dirname(targetPath);
  for (let i = 0; i < 12; i++) {
    if (!cur) break;
    if (existsSyncFn(cur)) {
      return cur;
    }
    const parent = pApi.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function computeRelativePath(targetPath, workspaceRoots, platform) {
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
 * Resolves the highest-priority valid file or directory target from extracted UI candidates.
 */
export async function resolveBestTarget({
  candidates = [],
  workspaceRoots = [],
  platform = process.platform,
  homeDir = homedir(),
  statFn = defaultStat,
  existsSyncFn = existsSync,
} = {}) {
  const pApi = pathApiFor(platform);
  const sorted = [...candidates].sort(
    (a, b) => (SOURCE_PRIORITY[b?.source] || 0) - (SOURCE_PRIORITY[a?.source] || 0)
  );

  let missingExplicitCandidate = null;

  for (const item of sorted) {
    if (!item || typeof item.value !== 'string') continue;
    const parsed = parseRawCandidate(item.value, { platform, homeDir });
    if (!parsed) continue;

    if (parsed.isAbsolute) {
      try {
        const info = await statFn(parsed.path);
        const relativePath = computeRelativePath(parsed.path, workspaceRoots, platform);
        return {
          matched: true,
          exists: true,
          source: item.source || 'unknown',
          linkText: item.linkText || '',
          isDirectory: Boolean(info.isDirectory),
          targetPath: parsed.path,
          fileName: pApi.basename(parsed.path) || parsed.path,
          parentDir: pApi.dirname(parsed.path),
          nearestExistingDir: info.isDirectory ? parsed.path : pApi.dirname(parsed.path),
          line: parsed.line,
          endLine: parsed.endLine,
          col: parsed.col,
          size: info.size,
          mtimeMs: info.mtimeMs,
          relativePath,
          fileUrl: encodePathToFileUrl(parsed.path, platform),
        };
      } catch {
        // Remember the highest-priority explicit URI or unambiguous absolute path if missing on disk
        if (
          !missingExplicitCandidate &&
          (parsed.isExplicitUri || item.source === 'explicit-uri' || item.source === 'react-prop')
        ) {
          const nearestExistingDir = findNearestExistingDir(parsed.path, { platform, existsSyncFn });
          missingExplicitCandidate = {
            matched: true,
            exists: false,
            source: item.source || 'explicit-uri',
            linkText: item.linkText || '',
            isDirectory: false,
            targetPath: parsed.path,
            fileName: pApi.basename(parsed.path) || parsed.path,
            parentDir: pApi.dirname(parsed.path),
            nearestExistingDir,
            line: parsed.line,
            endLine: parsed.endLine,
            col: parsed.col,
            size: null,
            mtimeMs: null,
            relativePath: computeRelativePath(parsed.path, workspaceRoots, platform),
            fileUrl: encodePathToFileUrl(parsed.path, platform),
          };
        }
        continue;
      }
    }

    // Relative candidate: must resolve to an existing file inside one of the workspaceRoots
    for (const root of workspaceRoots) {
      const candidateAbs = pApi.resolve(root, parsed.path);
      try {
        const info = await statFn(candidateAbs);
        const relativePath = computeRelativePath(candidateAbs, workspaceRoots, platform) || parsed.path;
        return {
          matched: true,
          exists: true,
          source: item.source || 'inline-code',
          linkText: item.linkText || '',
          isDirectory: Boolean(info.isDirectory),
          targetPath: candidateAbs,
          fileName: pApi.basename(candidateAbs) || candidateAbs,
          parentDir: pApi.dirname(candidateAbs),
          nearestExistingDir: info.isDirectory ? candidateAbs : pApi.dirname(candidateAbs),
          line: parsed.line,
          endLine: parsed.endLine,
          col: parsed.col,
          size: info.size,
          mtimeMs: info.mtimeMs,
          relativePath,
          fileUrl: encodePathToFileUrl(candidateAbs, platform),
        };
      } catch {
        // try next workspace root
      }
    }
  }

  if (missingExplicitCandidate) {
    return missingExplicitCandidate;
  }

  return { matched: false };
}
