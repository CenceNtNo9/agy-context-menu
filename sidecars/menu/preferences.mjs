import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_PREFERENCES = {
  language: 'auto',
  preferredEditor: 'auto',
  customEditorCommand: '',
  preferredTerminal: 'auto',
  altClickOpenDefault: true,
  minimalMenuShowHeader: false,
  minimalMenuShowTerminal: false,
  minimalMenuShowMention: false,
};

const ALLOWED_LANGUAGES = new Set(['auto', 'zh-CN', 'en']);
const ALLOWED_EDITORS = new Set([
  'auto',
  'vscode',
  'vscode-insiders',
  'cursor',
  'windsurf',
  'zed',
  'sublime',
  'notepadpp',
  'custom',
]);
const ALLOWED_TERMINALS = new Set(['auto', 'wt', 'powershell', 'terminal', 'iterm', 'warp', 'ghostty']);

function sanitizePreferences(raw, base = DEFAULT_PREFERENCES) {
  const next = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return next;
  }
  if (typeof raw.language === 'string' && ALLOWED_LANGUAGES.has(raw.language)) {
    next.language = raw.language;
  }
  if (typeof raw.preferredEditor === 'string' && ALLOWED_EDITORS.has(raw.preferredEditor)) {
    next.preferredEditor = raw.preferredEditor;
  }
  if (typeof raw.customEditorCommand === 'string') {
    next.customEditorCommand = raw.customEditorCommand.trim().slice(0, 512);
  }
  if (typeof raw.preferredTerminal === 'string' && ALLOWED_TERMINALS.has(raw.preferredTerminal)) {
    next.preferredTerminal = raw.preferredTerminal;
  }
  if (typeof raw.altClickOpenDefault === 'boolean') {
    next.altClickOpenDefault = raw.altClickOpenDefault;
  }
  if (typeof raw.minimalMenuShowHeader === 'boolean') {
    next.minimalMenuShowHeader = raw.minimalMenuShowHeader;
  }
  if (typeof raw.minimalMenuShowTerminal === 'boolean') {
    next.minimalMenuShowTerminal = raw.minimalMenuShowTerminal;
  }
  if (typeof raw.minimalMenuShowMention === 'boolean') {
    next.minimalMenuShowMention = raw.minimalMenuShowMention;
  }
  return next;
}

/**
 * Atomic JSON preference store for Context Menu Plus settings.
 */
export class PreferencesStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cached = null;
  }

  async get() {
    if (this.cached) {
      return { ...this.cached };
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cached = sanitizePreferences(JSON.parse(raw));
    } catch {
      this.cached = { ...DEFAULT_PREFERENCES };
    }
    return { ...this.cached };
  }

  async set(patch) {
    const current = await this.get();
    const next = sanitizePreferences(patch, current);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    this.cached = next;
    return { ...next };
  }
}
