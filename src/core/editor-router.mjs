import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Safely test if a path points to an existing regular file.
 * @param {typeof fs} fsImpl
 * @param {string} candidate
 * @returns {boolean}
 */
function fileExists(fsImpl, candidate) {
  if (!candidate) {
    return false;
  }
  try {
    const st = fsImpl.statSync(candidate);
    return Boolean(st && typeof st.isFile === 'function' && st.isFile());
  } catch {
    return false;
  }
}

/**
 * Expand `%VAR%` and `~` in editor candidate paths.
 * @param {string} templatePath
 * @param {Record<string, string | undefined>} env
 * @param {string} [home]
 * @returns {string | null}
 */
function expandEditorPath(templatePath, env, home) {
  let missingVar = false;
  let result = templatePath;

  if (result.startsWith('~/')) {
    const resolvedHome = home || env.HOME || env.USERPROFILE;
    if (!resolvedHome) {
      return null;
    }
    result = resolvedHome + result.slice(1);
  }

  result = result.replace(/%([^%]+)%/g, (_, key) => {
    const direct = env[key];
    if (direct) {
      return direct;
    }
    const upper = key.toUpperCase();
    for (const [k, v] of Object.entries(env)) {
      if (k.toUpperCase() === upper && v) {
        return v;
      }
    }
    missingVar = true;
    return '';
  });

  return missingVar ? null : result;
}

/**
 * Search `PATH` for an executable file without spawning `where` or `which`.
 * @param {string[]} names
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {(candidate: string) => boolean} checkExists
 * @returns {string | null}
 */
function findInPath(names, platform, env, checkExists) {
  const pathEnv = env.PATH || env.Path || '';
  if (!pathEnv || !Array.isArray(names) || names.length === 0) {
    return null;
  }
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const fullPath = pathImpl.join(dir, name);
      if (checkExists(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

const EDITOR_DEFINITIONS = {
  vscode: {
    label: 'VS Code',
    style: 'goto',
    win32Paths: [
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles(x86)%\\Microsoft VS Code\\Code.exe',
    ],
    win32PathNames: ['Code.exe'],
    darwinPaths: [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/opt/homebrew/bin/code',
      '/usr/local/bin/code',
    ],
    darwinPathNames: ['code'],
    linuxPaths: ['/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code'],
    linuxPathNames: ['code'],
    buildArgs: (filePath, line, column) =>
      line ? ['--goto', `${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  'vscode-insiders': {
    label: 'VS Code Insiders',
    style: 'goto',
    win32Paths: [
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
      '%ProgramFiles%\\Microsoft VS Code Insiders\\Code - Insiders.exe',
      '%ProgramFiles(x86)%\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    ],
    win32PathNames: ['Code - Insiders.exe'],
    darwinPaths: [
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      '~/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      '/opt/homebrew/bin/code-insiders',
      '/usr/local/bin/code-insiders',
    ],
    darwinPathNames: ['code-insiders'],
    linuxPaths: ['/usr/bin/code-insiders', '/usr/share/code-insiders/bin/code-insiders', '/snap/bin/code-insiders'],
    linuxPathNames: ['code-insiders'],
    buildArgs: (filePath, line, column) =>
      line ? ['--goto', `${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  cursor: {
    label: 'Cursor',
    style: 'goto',
    win32Paths: [
      '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
      '%ProgramFiles%\\cursor\\Cursor.exe',
    ],
    win32PathNames: ['Cursor.exe'],
    darwinPaths: [
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      '~/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      '/opt/homebrew/bin/cursor',
      '/usr/local/bin/cursor',
    ],
    darwinPathNames: ['cursor'],
    linuxPaths: ['/usr/bin/cursor', '/usr/local/bin/cursor'],
    linuxPathNames: ['cursor'],
    buildArgs: (filePath, line, column) =>
      line ? ['--goto', `${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  windsurf: {
    label: 'Windsurf',
    style: 'goto',
    win32Paths: [
      '%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe',
      '%ProgramFiles%\\Windsurf\\Windsurf.exe',
    ],
    win32PathNames: ['Windsurf.exe'],
    darwinPaths: [
      '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
      '~/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
      '/opt/homebrew/bin/windsurf',
      '/usr/local/bin/windsurf',
    ],
    darwinPathNames: ['windsurf'],
    linuxPaths: ['/usr/bin/windsurf', '/usr/local/bin/windsurf'],
    linuxPathNames: ['windsurf'],
    buildArgs: (filePath, line, column) =>
      line ? ['--goto', `${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  zed: {
    label: 'Zed',
    style: 'colon',
    win32Paths: [
      '%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe',
      '%LOCALAPPDATA%\\Zed\\Zed.exe',
      '%ProgramFiles%\\Zed\\Zed.exe',
    ],
    win32PathNames: ['Zed.exe', 'zed.exe'],
    darwinPaths: [
      '/Applications/Zed.app/Contents/MacOS/cli',
      '~/Applications/Zed.app/Contents/MacOS/cli',
      '/opt/homebrew/bin/zed',
      '/usr/local/bin/zed',
    ],
    darwinPathNames: ['zed'],
    linuxPaths: ['/usr/bin/zed', '~/.local/bin/zed'],
    linuxPathNames: ['zed'],
    buildArgs: (filePath, line, column) =>
      line ? [`${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  sublime: {
    label: 'Sublime Text',
    style: 'colon',
    win32Paths: [
      '%ProgramFiles%\\Sublime Text\\subl.exe',
      '%ProgramFiles%\\Sublime Text 3\\subl.exe',
      '%ProgramFiles%\\Sublime Text\\sublime_text.exe',
      '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe',
    ],
    win32PathNames: ['subl.exe', 'sublime_text.exe'],
    darwinPaths: [
      '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
      '~/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
      '/opt/homebrew/bin/subl',
      '/usr/local/bin/subl',
    ],
    darwinPathNames: ['subl'],
    linuxPaths: ['/usr/bin/subl'],
    linuxPathNames: ['subl'],
    buildArgs: (filePath, line, column) =>
      line ? [`${filePath}:${line}${column ? `:${column}` : ''}`] : [filePath],
  },
  notepadpp: {
    label: 'Notepad++',
    style: 'notepadpp',
    win32Paths: [
      '%ProgramFiles%\\Notepad++\\notepad++.exe',
      '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe',
    ],
    win32PathNames: ['notepad++.exe'],
    darwinPaths: [],
    darwinPathNames: [],
    linuxPaths: [],
    linuxPathNames: [],
    buildArgs: (filePath, line, column) => {
      if (!line) {
        return [filePath];
      }
      const args = [`-n${line}`];
      if (column) {
        args.push(`-c${column}`);
      }
      args.push(filePath);
      return args;
    },
  },
};

const DEFAULT_ORDER = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'sublime', 'notepadpp'];
const EDITOR_CACHE_TTL_MS = 60_000;

let cachedEditors = null;
let cachedEditorsAt = 0;

/**
 * Probe an individual editor definition for an installed executable.
 * @param {string} editorId
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @param {(candidate: string) => boolean} checkExists
 * @returns {{ id: string, label: string, style: string, executable: string } | null}
 */
function probeEditorExecutable(editorId, platform, env, home, checkExists) {
  const def = EDITOR_DEFINITIONS[editorId];
  if (!def) {
    return null;
  }

  const candidates =
    platform === 'win32'
      ? def.win32Paths
      : platform === 'darwin'
        ? def.darwinPaths
        : def.linuxPaths;

  for (const template of candidates) {
    const expanded = expandEditorPath(template, env, home);
    if (expanded && checkExists(expanded)) {
      return { id: editorId, label: def.label, style: def.style, executable: expanded };
    }
  }

  const pathNames =
    platform === 'win32'
      ? def.win32PathNames
      : platform === 'darwin'
        ? def.darwinPathNames
        : def.linuxPathNames;

  const fromPath = findInPath(pathNames, platform, env, checkExists);
  if (fromPath) {
    return { id: editorId, label: def.label, style: def.style, executable: fromPath };
  }

  return null;
}

/**
 * Detect all installed external code editors on the host machine with 60s probe caching.
 * Exports the same shape `{ id, label, style, executable }[]` consumed by `main.mjs` & UI panel.
 * @param {object} [options]
 * @param {Record<string, any>} [options.config]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 * @param {typeof fs} [options.fsImpl]
 * @param {(candidate: string) => boolean} [options.existsFn]
 * @param {boolean} [options.bypassCache]
 * @returns {Array<{ id: string, label: string, style: string, executable: string }>}
 */
export function detectEditors(options = {}) {
  const platform = options.platform || process.platform;
  const useDefaultRuntime =
    platform === process.platform &&
    !options.fsImpl &&
    !options.existsFn &&
    !options.env &&
    !options.home &&
    !options.config;

  if (
    useDefaultRuntime &&
    !options.bypassCache &&
    cachedEditors &&
    Date.now() - cachedEditorsAt < EDITOR_CACHE_TTL_MS
  ) {
    return cachedEditors;
  }

  const config = options.config || {};
  const env = options.env || process.env;
  const home = options.home || env.HOME || env.USERPROFILE || homedir();
  const checkExists = options.existsFn
    ? options.existsFn
    : (candidate) => fileExists(options.fsImpl || fs, candidate);

  const order = Array.isArray(config.editorPreferenceOrder)
    ? config.editorPreferenceOrder
    : DEFAULT_ORDER;

  const found = [];
  const seen = new Set();
  for (const editorId of order) {
    if (seen.has(editorId)) {
      continue;
    }
    seen.add(editorId);
    const hit = probeEditorExecutable(editorId, platform, env, home, checkExists);
    if (hit) {
      found.push(hit);
    }
  }

  if (useDefaultRuntime && !options.bypassCache) {
    cachedEditors = found;
    cachedEditorsAt = Date.now();
  }

  return found;
}

/**
 * Detect the highest-priority installed code editor on the host machine.
 * @param {object} [options]
 * @param {Record<string, any>} [options.config]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 * @param {typeof fs} [options.fsImpl]
 * @param {(candidate: string) => boolean} [options.existsFn]
 * @param {boolean} [options.bypassCache]
 * @returns {{ editorId: string, command: string, argsTemplate?: string[] | null, isFallback: boolean } | null}
 */
export function detectInstalledEditor(options = {}) {
  const config = options.config || {};
  const preferred = config.preferredEditor;

  if ((preferred === 'custom' || !preferred || preferred === 'auto') && config.customEditor && config.customEditor.command) {
    return {
      editorId: 'custom',
      command: config.customEditor.command,
      argsTemplate: Array.isArray(config.customEditor.argsTemplate) ? config.customEditor.argsTemplate : null,
      isFallback: false,
    };
  }

  const baseOrder = Array.isArray(config.editorPreferenceOrder)
    ? config.editorPreferenceOrder
    : DEFAULT_ORDER;

  const effectiveOrder =
    preferred && preferred !== 'auto' && preferred !== 'custom'
      ? [preferred, ...baseOrder.filter((id) => id !== preferred)]
      : baseOrder;

  const editors = detectEditors({
    ...options,
    config: { ...config, editorPreferenceOrder: effectiveOrder },
  });

  if (editors.length > 0) {
    return {
      editorId: editors[0].id,
      command: editors[0].executable,
      isFallback: false,
    };
  }

  if (config.customEditor && config.customEditor.command) {
    return {
      editorId: 'custom',
      command: config.customEditor.command,
      argsTemplate: Array.isArray(config.customEditor.argsTemplate) ? config.customEditor.argsTemplate : null,
      isFallback: false,
    };
  }

  return null;
}

/**
 * Resolve the editor command and CLI arguments for opening a source file,
 * falling back to a safe plain-text viewer (`notepad.exe` on Windows, `open -t` on macOS)
 * when no modern code editor is found.
 * @param {object} params
 * @param {string} params.filePath
 * @param {number | null} [params.line]
 * @param {number | null} [params.column]
 * @param {Record<string, any>} [params.config]
 * @param {NodeJS.Platform} [params.platform]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {typeof fs} [params.fsImpl]
 * @returns {{ editorId: string, editorCommand: string, editorArgs: string[], isFallback: boolean }}
 */
export function resolveEditorInvocation({
  filePath,
  line = null,
  column = null,
  config = {},
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
}) {
  const detected = detectInstalledEditor({ config, platform, env, fsImpl });

  if (detected) {
    if (detected.editorId === 'custom') {
      const editorArgs = detected.argsTemplate
        ? detected.argsTemplate.map((token) =>
            String(token)
              .replace(/\{file\}/g, filePath)
              .replace(/\{line\}/g, String(line || 1))
              .replace(/\{column\}/g, String(column || 1)),
          )
        : [filePath];
      return {
        editorId: 'custom',
        editorCommand: detected.command,
        editorArgs,
        isFallback: false,
      };
    }

    const def = EDITOR_DEFINITIONS[detected.editorId];
    return {
      editorId: detected.editorId,
      editorCommand: detected.command,
      editorArgs: def.buildArgs(filePath, line, column),
      isFallback: false,
    };
  }

  // Safe plain-text viewer fallback (never shell-execute .js/.ts!)
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    return {
      editorId: 'notepad',
      editorCommand: path.win32.join(systemRoot, 'System32', 'notepad.exe'),
      editorArgs: [filePath],
      isFallback: true,
    };
  }

  if (platform === 'darwin') {
    return {
      editorId: 'textedit',
      editorCommand: '/usr/bin/open',
      editorArgs: ['-t', filePath],
      isFallback: true,
    };
  }

  return {
    editorId: 'plain_text_fallback',
    editorCommand: 'xdg-open',
    editorArgs: [filePath],
    isFallback: true,
  };
}
