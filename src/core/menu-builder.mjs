const LABELS = {
  'zh-CN': {
    open_file: '打开',
    reveal_in_folder: '在文件夹中打开',
    copy_file_entity: '复制',
    copy_path_file: '复制文件路径',
    open_directory: '打开',
    copy_path_generic: '复制路径',
    reveal_nearest_parent: '打开上层文件夹',
    open_untrusted_unc: '打开',
    copy_text: '复制文本',
    open_terminal: '在此打开终端',
    mention_target: '引用到输入框',
  },
  en: {
    open_file: 'Open',
    reveal_in_folder: 'Reveal in Folder',
    copy_file_entity: 'Copy',
    copy_path_file: 'Copy File Path',
    open_directory: 'Open',
    copy_path_generic: 'Copy Path',
    reveal_nearest_parent: 'Open Parent Folder',
    open_untrusted_unc: 'Open',
    copy_text: 'Copy Text',
    open_terminal: 'Open Terminal Here',
    mention_target: 'Mention in Input',
  },
};

/**
 * Resolve effective menu language (`'zh-CN'` | `'en'`).
 * Defaults to `'zh-CN'` to preserve the locked 5-state contract when omitted or `'auto'`.
 * @param {string | undefined} language
 * @returns {'zh-CN' | 'en'}
 */
function resolveMenuLanguage(language) {
  if (language === 'en') {
    return 'en';
  }
  return 'zh-CN';
}

/**
 * Build optional header label for an intercepted target when `showHeader` is enabled.
 * @param {Record<string, any> | null | undefined} resolvedTarget
 * @returns {string}
 */
function buildHeaderLabel(resolvedTarget) {
  if (!resolvedTarget) {
    return '';
  }
  if (resolvedTarget.kind === 'inline_code_text') {
    const raw = String(resolvedTarget.text || '').trim();
    return raw.length > 36 ? `${raw.slice(0, 35)}…` : raw;
  }
  const targetPath = String(resolvedTarget.fileName || resolvedTarget.normalizedPath || '').trim();
  if (!targetPath) {
    return resolvedTarget.kind || '';
  }
  const base = targetPath.split(/[\\/]/).filter(Boolean).pop() || targetPath;
  const line = resolvedTarget.line ? `:${resolvedTarget.line}` : '';
  return `${base}${line}`;
}

/**
 * Build the adaptive, minimal context menu descriptor for a resolved target.
 * Labels, item IDs, ordering, and separators follow the locked 5-state 4/2/2/2/1 contract.
 * Supports `language: 'zh-CN' | 'en'` and optional `options: { showHeader, showTerminal, showMention }`
 * (all defaulting to `false`).
 *
 * @param {Record<string, any> | null | undefined} resolvedTarget
 * @param {Record<string, any>} [configOrOptions]
 * @param {Record<string, any>} [explicitOptions]
 * @returns {{ intercept: boolean, targetKind: string, items: Array<{ id: string, label: string, enabled: boolean, separatorBefore?: boolean, isHeader?: boolean }> }}
 */
export function buildContextMenu(resolvedTarget, configOrOptions = {}, explicitOptions = {}) {
  const kind = resolvedTarget?.kind || 'passthrough';
  const lang = resolveMenuLanguage(
    explicitOptions?.language ?? configOrOptions?.language,
  );
  const dict = LABELS[lang];

  const mergedOpts = {
    showHeader: false,
    showTerminal: false,
    showMention: false,
    ...(configOrOptions?.options || {}),
    ...(typeof configOrOptions?.showHeader === 'boolean' ? { showHeader: configOrOptions.showHeader } : {}),
    ...(typeof configOrOptions?.showTerminal === 'boolean' ? { showTerminal: configOrOptions.showTerminal } : {}),
    ...(typeof configOrOptions?.showMention === 'boolean' ? { showMention: configOrOptions.showMention } : {}),
    ...(explicitOptions || {}),
  };

  let items;
  let supportsPathExtras = false;

  switch (kind) {
    case 'existing_file':
      supportsPathExtras = true;
      items = [
        { id: 'open_file', label: dict.open_file, enabled: true },
        { id: 'reveal_in_folder', label: dict.reveal_in_folder, enabled: true },
        { id: 'copy_file_entity', label: dict.copy_file_entity, enabled: true, separatorBefore: true },
        { id: 'copy_path', label: dict.copy_path_file, enabled: true },
      ];
      break;

    case 'existing_directory':
      supportsPathExtras = true;
      items = [
        { id: 'open_directory', label: dict.open_directory, enabled: true },
        { id: 'copy_path', label: dict.copy_path_generic, enabled: true },
      ];
      break;

    case 'missing_path':
      supportsPathExtras = Boolean(resolvedTarget?.nearestExistingParent);
      items = [
        {
          id: 'reveal_nearest_parent',
          label: dict.reveal_nearest_parent,
          enabled: Boolean(resolvedTarget?.nearestExistingParent),
        },
        { id: 'copy_path', label: dict.copy_path_generic, enabled: true },
      ];
      break;

    case 'untrusted_unc':
      items = [
        { id: 'open_untrusted_unc', label: dict.open_untrusted_unc, enabled: true },
        { id: 'copy_path', label: dict.copy_path_generic, enabled: true },
      ];
      break;

    case 'inline_code_text':
      items = [
        { id: 'copy_text', label: dict.copy_text, enabled: true },
      ];
      break;

    case 'passthrough':
    default:
      return {
        intercept: false,
        targetKind: 'passthrough',
        items: [],
      };
  }

  if (mergedOpts.showHeader) {
    const headerLabel = buildHeaderLabel(resolvedTarget);
    if (headerLabel) {
      items.unshift({
        id: 'header',
        label: headerLabel,
        enabled: false,
        isHeader: true,
      });
    }
  }

  if (supportsPathExtras && mergedOpts.showTerminal) {
    items.push({
      id: 'open_terminal',
      label: dict.open_terminal,
      enabled: true,
      separatorBefore: true,
    });
  }

  if ((kind === 'existing_file' || kind === 'existing_directory' || kind === 'missing_path') && mergedOpts.showMention) {
    items.push({
      id: 'mention_target',
      label: dict.mention_target,
      enabled: true,
      ...(!mergedOpts.showTerminal ? { separatorBefore: true } : {}),
    });
  }

  return {
    intercept: true,
    targetKind: kind,
    items,
  };
}
