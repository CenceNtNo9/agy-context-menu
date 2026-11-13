import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../config.default.jsonc', import.meta.url));

/**
 * Strip single-line comments, block comments, and trailing commas from JSONC text
 * while preserving string literals verbatim.
 * @param {string} rawText
 * @returns {string}
 */
export function stripJsonc(rawText) {
  if (typeof rawText !== 'string') {
    throw new TypeError('JSONC input must be a string');
  }

  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        output += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (ch === '\n' || ch === '\r') {
        output += ch;
      }
      continue;
    }

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    output += ch;
  }

  return stripTrailingCommas(output);
}

/**
 * Remove trailing commas before `}` or `]` outside string literals.
 * @param {string} jsonText
 * @returns {string}
 */
function stripTrailingCommas(jsonText) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < jsonText.length && /\s/.test(jsonText[j])) {
        j++;
      }
      const nextToken = jsonText[j];
      if (nextToken === '}' || nextToken === ']') {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/**
 * Parse a JSONC string into a JavaScript value.
 * @param {string} rawText
 * @returns {any}
 */
export function parseJsonc(rawText) {
  const cleaned = stripJsonc(rawText);
  return JSON.parse(cleaned);
}

/**
 * Check whether a value is a non-null plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deeply merge two configuration objects. Arrays and primitives in `override` replace `base`.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} override
 * @returns {Record<string, any>}
 */
export function deepMerge(base, override) {
  const target = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(override)) {
    return target;
  }

  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) {
      continue;
    }
    if (isPlainObject(val) && isPlainObject(target[key])) {
      target[key] = deepMerge(target[key], val);
    } else if (Array.isArray(val)) {
      target[key] = [...val];
    } else {
      target[key] = val;
    }
  }

  return target;
}

/**
 * Resolve optional user config file path from environment or standard user directory.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function resolveDefaultUserConfigPath(env, platform) {
  if (env.AGY_CONTEXT_MENU_CONFIG) {
    return env.AGY_CONTEXT_MENU_CONFIG;
  }
  if (env.AGY_FILE_ACTIONS_CONFIG) {
    return env.AGY_FILE_ACTIONS_CONFIG;
  }
  if (platform === 'win32' && env.APPDATA) {
    return path.win32.join(env.APPDATA, 'agy-context-menu', 'config.jsonc');
  }
  const home = env.HOME || env.USERPROFILE;
  if (home) {
    return path.join(home, '.config', 'agy-context-menu', 'config.jsonc');
  }
  return null;
}

/**
 * Safely read and parse a JSONC file if it exists.
 * @param {string | null | undefined} filePath
 * @param {typeof fs} fsImpl
 * @returns {Record<string, any> | null}
 */
function readOptionalJsoncFile(filePath, fsImpl) {
  if (!filePath) {
    return null;
  }
  try {
    if (!fsImpl.existsSync(filePath)) {
      return null;
    }
  } catch {
    return null;
  }
  const content = fsImpl.readFileSync(filePath, 'utf8');
  return parseJsonc(content);
}

/**
 * Load default JSONC config and merge optional user JSONC config + runtime overrides.
 * @param {object} [options]
 * @param {string} [options.defaultConfigPath]
 * @param {string | null} [options.userConfigPath]
 * @param {Record<string, any>} [options.overrideConfig]
 * @param {typeof fs} [options.fsImpl]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Record<string, any>}
 */
export function loadConfig(options = {}) {
  const fsImpl =
    options.fsImpl && typeof options.fsImpl.readFileSync === 'function' ? options.fsImpl : fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const defaultPath = options.defaultConfigPath || DEFAULT_CONFIG_PATH;

  const defaultContent = fsImpl.readFileSync(defaultPath, 'utf8');
  let merged = parseJsonc(defaultContent);

  const userPath =
    options.userConfigPath !== undefined
      ? options.userConfigPath
      : resolveDefaultUserConfigPath(env, platform);

  const userConfig = readOptionalJsoncFile(userPath, fsImpl);
  if (userConfig) {
    merged = deepMerge(merged, userConfig);
  }

  if (options.overrideConfig) {
    merged = deepMerge(merged, options.overrideConfig);
  }

  return merged;
}
