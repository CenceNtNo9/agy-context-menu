import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  WorkspaceRootResolver,
  buildContextMenu,
  encodePathToFileUrl,
  executeMenuAction,
  isUntrustedUncPath,
  loadConfig,
  resolveBestTargetWithEngine,
  resolveEditorInvocation,
  resolveTargetAsync,
} from '../../src/index.mjs';
import { detectEditors } from '../../src/core/editor-router.mjs';
import {
  getDefaultPlatformAdapter,
  getPlatformStatus,
  loadDefaultWin32Bindings,
} from '../../src/platform/index.mjs';
import { detectTerminals, openInTerminal } from './os-actions.mjs';
import { isPluginEnabled, resolvePlatformPaths } from './platform.mjs';
import { PreferencesStore } from './preferences.mjs';
import { RuntimeBridge } from './runtime-bridge.mjs';
import { loadSidecarSdk } from './sdk-loader.mjs';
import { SidecarOwner } from './sidecar-owner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const RESOLUTION_TTL_MS = 60_000;
const RESOLUTION_MAX_ENTRIES = 64;

/**
 * Query Antigravity `agentapi` asynchronously for conversation metadata with a 2s timeout (Patch P5).
 * Never blocks the Sidecar event loop.
 */
export async function queryAgentConversationMetadata(
  conversationId,
  { execFileFn = execFileAsync, env = process.env } = {},
) {
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE;
  if (!exe && !env.ANTIGRAVITY_LS_ADDRESS) {
    return null;
  }
  try {
    const file = exe || 'agentapi';
    const args = exe
      ? ['agentapi', 'get-conversation-metadata', conversationId]
      : ['get-conversation-metadata', conversationId];
    const result = await execFileFn(file, args, {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const stdout = typeof result === 'string' ? result : result?.stdout || '';
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

function resolveUiLanguage(prefLang) {
  if (prefLang === 'zh-CN' || prefLang === 'en') {
    return prefLang;
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  } catch {
    return 'zh-CN';
  }
}

function buildRuntimeConfig(baseConfig, prefs, overrides = {}) {
  const preferredEditor = overrides.preferredEditor || prefs.preferredEditor || 'auto';
  const nextConfig = {
    ...baseConfig,
    preferredEditor,
  };
  if (preferredEditor === 'custom' && prefs.customEditorCommand) {
    nextConfig.customEditor = {
      ...(baseConfig.customEditor || {}),
      command: prefs.customEditorCommand,
    };
  }
  return nextConfig;
}

function isWindowsStylePath(targetPath, platform) {
  return platform === 'win32' || /^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\/.test(targetPath);
}

export function computeContainingDirPath(targetPath, platform) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return null;
  }
  const pathImpl = isWindowsStylePath(targetPath, platform) ? win32 : posix;
  const dir = pathImpl.dirname(targetPath);
  if (!dir || dir === '.' || dir === targetPath) {
    return null;
  }
  return dir;
}

function formatV1ResolveFields(target, { platform, prefs, editors }) {
  if (!target) {
    return { matched: false };
  }

  if (target.kind === 'untrusted_unc') {
    return {
      matched: true,
      exists: false,
      isDirectory: false,
      isUntrustedUnc: true,
      fileName: target.fileName,
      targetPath: target.normalizedPath,
      parentDir: null,
      nearestExistingDir: null,
      line: target.line ?? undefined,
      endLine: target.endLine ?? undefined,
      col: target.column ?? undefined,
      size: null,
      mtimeMs: null,
      relativePath: null,
      fileUrl: '',
      platform,
      language: prefs.language,
      preferredEditor: prefs.preferredEditor,
      editors,
    };
  }

  if (
    target.kind === 'existing_file' ||
    target.kind === 'existing_directory' ||
    target.kind === 'missing_path'
  ) {
    const exists = target.kind === 'existing_file' || target.kind === 'existing_directory';
    const isDirectory = target.kind === 'existing_directory';
    const targetPath = target.normalizedPath;
    const pathImpl = isWindowsStylePath(targetPath, platform) ? win32 : posix;
    const parentDir = target.parentDir || (isDirectory ? targetPath : pathImpl.dirname(targetPath));
    const containingDir = isDirectory ? null : computeContainingDirPath(targetPath, platform);
    const nearestExistingDir = isDirectory
      ? targetPath
      : exists
        ? parentDir
        : target.nearestExistingParent || null;

    return {
      matched: true,
      exists,
      isDirectory,
      targetPath,
      fileName: target.fileName,
      parentDir,
      containingDir,
      nearestExistingDir,
      line: target.line ?? undefined,
      endLine: target.endLine ?? undefined,
      col: target.column ?? undefined,
      size: target.kind === 'existing_file' ? (target.sizeBytes ?? 0) : null,
      mtimeMs: target.mtimeMs ?? null,
      relativePath: target.relativePath ?? null,
      fileUrl: target.fileUrl || encodePathToFileUrl(targetPath, platform),
      platform,
      language: prefs.language,
      preferredEditor: prefs.preferredEditor,
      editors,
    };
  }

  return {
    matched: false,
    platform,
    language: prefs.language,
    preferredEditor: prefs.preferredEditor,
    editors,
  };
}

function mapActionId(rawAction, target) {
  if (rawAction === 'open-default' || rawAction === 'open_file') {
    if (target.kind === 'untrusted_unc') {
      return 'open_untrusted_unc';
    }
    if (target.kind === 'existing_directory') {
      return 'open_directory';
    }
    return 'open_file';
  }
  if (rawAction === 'reveal') {
    return target.kind === 'missing_path' ? 'reveal_nearest_parent' : 'reveal_in_folder';
  }
  if (rawAction === 'copy-file') {
    return 'copy_file_entity';
  }
  return rawAction;
}

function isPureTextCopyAction(rawAction) {
  if (!rawAction) return false;
  if (rawAction === 'copy-text' || rawAction === 'copy_text') return true;
  if (rawAction === 'copy_parent_path') return true;
  return rawAction.startsWith('copy-') && rawAction !== 'copy-file';
}

/**
 * Create the Sidecar RPC handler with bidirectional v1/v2 protocol compatibility,
 * one-time `resolutionId` replay/spoof protection (Patch P8), and async path resolution (Patch P5).
 */
export function createSidecarRpcHandler({
  paths,
  preferences,
  rootResolver,
  baseConfig = loadConfig(),
  platformAdapter,
  detectEditorsFn = detectEditors,
  detectTerminalsFn = detectTerminals,
  openInTerminalFn = openInTerminal,
  asyncStatImpl,
  fsImpl,
  nowFn = () => Date.now(),
  onActionRecorded = () => {},
} = {}) {
  const platform = paths?.platform || process.platform;
  const resolutionCache = new Map();

  function pruneExpired(now) {
    for (const [key, entry] of resolutionCache.entries()) {
      if (now - entry.createdAt > RESOLUTION_TTL_MS) {
        resolutionCache.delete(key);
      }
    }
  }

  function storeResolution(id, entry) {
    const now = nowFn();
    pruneExpired(now);
    while (resolutionCache.size >= RESOLUTION_MAX_ENTRIES) {
      const oldestKey = resolutionCache.keys().next().value;
      if (!oldestKey) break;
      resolutionCache.delete(oldestKey);
    }
    resolutionCache.set(id, { ...entry, createdAt: now });
  }

  function getResolution(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }
    const now = nowFn();
    pruneExpired(now);
    const entry = resolutionCache.get(id);
    if (!entry) {
      return null;
    }
    if (now - entry.createdAt > RESOLUTION_TTL_MS) {
      resolutionCache.delete(id);
      return null;
    }
    return entry;
  }

  return async function handleRpc(type, input = {}) {
    const prefs = await preferences.get();
    const uiLang = resolveUiLanguage(prefs.language);
    const zh = uiLang === 'zh-CN';
    const editors = detectEditorsFn({ platform });
    const terminals = detectTerminalsFn({ platform });

    if (type === 'get-config') {
      return {
        ok: true,
        platform,
        language: prefs.language,
        preferredEditor: prefs.preferredEditor,
        preferredTerminal: prefs.preferredTerminal,
        altClickOpenDefault: prefs.altClickOpenDefault,
        minimalMenuShowHeader: prefs.minimalMenuShowHeader,
        minimalMenuShowTerminal: prefs.minimalMenuShowTerminal,
        minimalMenuShowMention: prefs.minimalMenuShowMention,
        editors,
        terminals,
      };
    }

    const runtimeConfig = buildRuntimeConfig(baseConfig, prefs);

    if (type === 'resolve-target') {
      const workspaceRoots = await rootResolver.getRoots({
        conversationId: input.conversationId,
        hintDirs: input.hintDirs,
      });

      const rawCandidates = Array.isArray(input.candidates) ? [...input.candidates] : [];
      if (rawCandidates.length === 0 && typeof input.clickedCodeText === 'string' && input.clickedCodeText.trim()) {
        rawCandidates.push({
          source: 'inline-code',
          value: input.clickedCodeText.trim(),
          linkText: input.clickedCodeText.trim(),
          isInlineCode: true,
        });
      }

      const target = await resolveBestTargetWithEngine({
        candidates: rawCandidates,
        workspaceRoots,
        config: runtimeConfig,
        platform,
        homeDir: paths?.home,
        asyncStatImpl,
        fsImpl,
      });

      const resolutionId = randomUUID();
      storeResolution(resolutionId, { target, workspaceRoots });

      const menu = buildContextMenu(target, runtimeConfig, {
        language: uiLang,
        showHeader: Boolean(prefs.minimalMenuShowHeader),
        showTerminal: Boolean(prefs.minimalMenuShowTerminal),
        showMention: Boolean(prefs.minimalMenuShowMention),
      });

      const v1Fields = formatV1ResolveFields(target, { platform, prefs, editors });

      return {
        ok: true,
        resolutionId,
        target,
        menu,
        ...v1Fields,
      };
    }

    if (type === 'execute-action') {
      const rawAction = String(input?.actionId || input?.action || '').trim();
      if (!rawAction) {
        return {
          ok: false,
          status: 'error',
          reason: 'missing_action',
          error: zh ? '缺少执行动作名称' : 'Missing action name',
        };
      }

      const adapter = platformAdapter || getDefaultPlatformAdapter();
      const hasResolutionId = typeof input?.resolutionId === 'string' && input.resolutionId.length > 0;

      // Pure text copy (fallback inline copy or v1 copy-parent-path / copy-relative-path / copy-filename / copy-display-text)
      if (isPureTextCopyAction(rawAction)) {
        let textToCopy = input.text;
        const isParentCopy = rawAction === 'copy-parent-path' || rawAction === 'copy_parent_path';
        if (hasResolutionId) {
          const cached = getResolution(input.resolutionId);
          if (!cached) {
            return {
              ok: false,
              status: 'error',
              reason: 'invalid_or_expired_resolution',
              error: zh ? '操作令牌已过期或失效，请重新右键打开菜单' : 'Action token expired or invalid',
            };
          }
          resolutionCache.delete(input.resolutionId);
          if (textToCopy === undefined) {
            textToCopy = isParentCopy
              ? (computeContainingDirPath(cached.target?.normalizedPath, platform) ?? '')
              : (cached.target?.text ?? cached.target?.normalizedPath ?? '');
          }
        } else if (textToCopy === undefined) {
          textToCopy = isParentCopy
            ? (computeContainingDirPath(input.targetPath, platform) ?? '')
            : (input.targetPath ?? '');
        }

        try {
          const res = await executeMenuAction({
            actionId: 'copy_text',
            target: { kind: 'inline_code_text', text: String(textToCopy ?? '') },
            platformAdapter: adapter,
            config: runtimeConfig,
            platform,
            fsImpl,
          });
          onActionRecorded({
            action: rawAction,
            target: String(textToCopy ?? '').slice(0, 60),
            ok: Boolean(res.ok),
            error: res.ok ? undefined : res.message,
          });
          return res.ok ? res : { ...res, error: res.error || res.message || 'Copy failed' };
        } catch (err) {
          const msg = err?.message || 'Copy failed';
          onActionRecorded({ action: rawAction, target: '', ok: false, error: msg });
          return { ok: false, status: 'error', error: msg, message: msg };
        }
      }

      // Resolve target exclusively from server-side cache or server-side re-resolution (never trust client ext/isDirectory)
      let target = null;
      if (hasResolutionId) {
        const cached = getResolution(input.resolutionId);
        if (!cached) {
          return {
            ok: false,
            status: 'error',
            reason: 'invalid_or_expired_resolution',
            error: zh ? '操作令牌已过期或失效，请重新右键打开菜单' : 'Action token expired or invalid',
          };
        }
        target = cached.target;
      } else {
        if (input?.confirmed === true) {
          return {
            ok: false,
            status: 'error',
            reason: 'confirmation_token_required',
            error: zh ? '二次确认必须携带有效的一次性解析令牌' : 'Confirmation requires a valid resolutionId',
          };
        }
        if (typeof input?.targetPath !== 'string' || !input.targetPath.trim()) {
          return {
            ok: false,
            status: 'error',
            reason: 'missing_target_path',
            error: zh ? '缺少目标路径' : 'Missing targetPath',
          };
        }
        target = await resolveTargetAsync(
          { rawUri: input.targetPath, text: input.targetPath },
          {
            workspaceRoots: [],
            cwd: null,
            config: runtimeConfig,
            platform,
            asyncStatImpl,
            fsImpl,
          },
        );
        if (
          target.kind === 'existing_file' &&
          !target.line &&
          Number.isSafeInteger(input.line) &&
          input.line > 0
        ) {
          target = {
            ...target,
            line: input.line,
            column: Number.isSafeInteger(input.col) && input.col > 0 ? input.col : null,
          };
        }
      }

      const consumeToken = () => {
        if (hasResolutionId) {
          resolutionCache.delete(input.resolutionId);
        }
      };

      // Validate confirmed execution target matches cached path and consume one-time token immediately
      const confirmed = input?.confirmed === true;
      if (confirmed) {
        consumeToken();
        if (
          typeof input.expectedTargetPath !== 'string' ||
          input.expectedTargetPath !== target.normalizedPath
        ) {
          return {
            ok: false,
            status: 'error',
            reason: 'target_mismatch',
            error: zh ? '安全拦截：确认路径与服务端解析目标不一致' : 'Blocked: expectedTargetPath mismatch',
          };
        }
      }

      try {
        // Explicit editor action from v1 submenu ("open-editor" or "open-editor:<id>")
        if (rawAction === 'open-editor' || rawAction.startsWith('open-editor:')) {
          const requestedEditor = rawAction.startsWith('open-editor:')
            ? rawAction.slice('open-editor:'.length)
            : input.editorId;
          if (
            target.kind === 'untrusted_unc' ||
            isUntrustedUncPath(target.normalizedPath, platform, runtimeConfig)
          ) {
            if (!confirmed) {
              return {
                ok: false,
                status: 'confirmation_required',
                reason: 'untrusted_unc_path',
                targetPath: target.normalizedPath,
                error: zh
                  ? '安全拦截：高危可执行文件或外部网络路径，已阻止直接运行'
                  : 'Blocked executable or untrusted UNC path',
              };
            }
          }
          if (target.kind !== 'existing_file') {
            consumeToken();
            const msg = zh ? `目标不存在或不是文件: ${target.normalizedPath || ''}` : 'Target file does not exist';
            return { ok: false, status: 'error', error: msg, message: msg };
          }
          const editorConfig = buildRuntimeConfig(baseConfig, prefs, {
            preferredEditor: requestedEditor || prefs.preferredEditor,
          });
          const invocation = resolveEditorInvocation({
            filePath: target.normalizedPath,
            line: target.line ?? null,
            column: target.column ?? null,
            config: editorConfig,
            platform,
            fsImpl,
          });
          const adapterResult = await adapter.openInEditor({
            filePath: target.normalizedPath,
            line: target.line ?? null,
            column: target.column ?? null,
            editorId: invocation.editorId,
            editorCommand: invocation.editorCommand,
            editorArgs: invocation.editorArgs,
          });
          consumeToken();
          onActionRecorded({ action: rawAction, target: target.normalizedPath, ok: true });
          return {
            ok: true,
            status: 'executed',
            actionId: 'open_file',
            editorId: invocation.editorId,
            ...adapterResult,
          };
        }

        // Terminal action (v1 "open-terminal" or v2 optional "open_terminal")
        if (rawAction === 'open-terminal' || rawAction === 'open_terminal') {
          consumeToken();
          if (
            target.kind === 'untrusted_unc' ||
            isUntrustedUncPath(target.normalizedPath, platform, runtimeConfig)
          ) {
            const msg = zh
              ? '安全策略拒绝执行：未受信任的外部 UNC 路径禁止启动终端'
              : 'Blocked terminal launch for untrusted UNC path';
            return { ok: false, status: 'error', reason: 'untrusted_unc_rejected', error: msg, message: msg };
          }
          let dirPath = null;
          if (target.kind === 'existing_directory') {
            dirPath = target.normalizedPath;
          } else if (target.kind === 'existing_file') {
            dirPath = target.parentDir || dirname(target.normalizedPath);
          } else if (target.kind === 'missing_path') {
            dirPath = target.nearestExistingParent;
          }
          if (!dirPath) {
            const msg = zh ? '未找到可用的本地目录' : 'No existing directory found';
            return { ok: false, status: 'error', error: msg, message: msg };
          }
          await openInTerminalFn({
            dirPath,
            terminalId: prefs.preferredTerminal,
            platform,
          });
          onActionRecorded({ action: rawAction, target: dirPath, ok: true });
          return { ok: true, status: 'executed', actionId: 'open_terminal' };
        }

        // Standard v2 / mapped v1 actions via 3-tier engine
        const mappedAction = mapActionId(rawAction, target);
        const result = await executeMenuAction({
          actionId: mappedAction,
          target,
          confirmed,
          platformAdapter: adapter,
          config: runtimeConfig,
          platform,
          fsImpl,
        });

        if (result.status === 'confirmation_required') {
          // Keep resolutionId alive so the user's confirmed follow-up call can verify and consume it
          const blockMsg = zh
            ? '安全拦截：高危可执行文件或外部网络路径，已阻止直接运行'
            : 'Blocked executable or untrusted UNC path';
          onActionRecorded({
            action: rawAction,
            target: target.normalizedPath || '',
            ok: false,
            error: blockMsg,
          });
          return {
            ...result,
            ok: false,
            error: blockMsg,
          };
        }

        consumeToken();
        if (!result.ok) {
          const errMsg = result.error || result.message || (zh ? '操作失败' : 'Action failed');
          onActionRecorded({
            action: rawAction,
            target: target.normalizedPath || '',
            ok: false,
            error: errMsg,
          });
          return {
            ...result,
            error: errMsg,
          };
        }

        onActionRecorded({
          action: rawAction,
          target: target.normalizedPath || '',
          ok: true,
        });
        return result;
      } catch (err) {
        consumeToken();
        const errMsg = err?.message || 'Action failed';
        onActionRecorded({
          action: rawAction,
          target: target?.normalizedPath || input?.targetPath || '',
          ok: false,
          error: errMsg,
        });
        return {
          ok: false,
          status: 'error',
          error: errMsg,
          message: errMsg,
        };
      }
    }

    return {
      ok: false,
      error: `Unknown RPC type: ${type}`,
    };
  };
}

function isDirectCliRun() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const entryPath = resolve(process.argv[1]);
  return process.platform === 'win32'
    ? selfPath.toLowerCase() === entryPath.toLowerCase()
    : selfPath === entryPath;
}

if (isDirectCliRun()) {
  const paths = resolvePlatformPaths();
  const baseConfig = loadConfig();
  const preferences = new PreferencesStore(paths.preferencesFile);
  const clientSource = readFileSync(join(HERE, 'renderer-client.cjs'), 'utf8');
  const panelHtml = readFileSync(join(HERE, 'panel.html'), 'utf8');
  const recentActions = [];

  function recordAction(entry) {
    recentActions.unshift({ ...entry, at: new Date().toISOString() });
    if (recentActions.length > 10) {
      recentActions.length = 10;
    }
  }

  const rootResolver = new WorkspaceRootResolver({
    platform: paths.platform,
    projectsDir: paths.projectsDir,
    brainDir: paths.brainDir,
    scratchDir: paths.scratchDir,
    config: baseConfig,
    getConversationMetadata: (id) => queryAgentConversationMetadata(id),
  });

  let pluginEnabled = isPluginEnabled(paths.pluginConfigFile);
  const isSidecarMode = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  const ownership = new SidecarOwner(paths.dataDir);
  const claimed = await ownership.claim();
  if (!claimed) {
    process.exit(0);
  }

  const handleRpc = createSidecarRpcHandler({
    paths,
    preferences,
    rootResolver,
    baseConfig,
    onActionRecorded: recordAction,
  });

  const bridge = new RuntimeBridge({
    userDataDir: paths.userDataDir,
    devToolsPortFile: paths.devToolsPortFile,
    stateFile: paths.stateFile,
    clientSource,
    onRpc: handleRpc,
    ownerToken: ownership.token,
    generation: ownership.startedAt,
    owns: () => ownership.isOwner(),
    enabled: () => pluginEnabled,
    platform: paths.platform,
  });

  let configWatcher = null;
  if (existsSync(paths.geminiConfigDir)) {
    try {
      configWatcher = watch(paths.geminiConfigDir, (_eventType, filename) => {
        if (!filename || String(filename) === 'config.json') {
          const nextEnabled = isPluginEnabled(paths.pluginConfigFile);
          if (nextEnabled !== pluginEnabled) {
            pluginEnabled = nextEnabled;
            void bridge.sync();
          }
        }
      });
      configWatcher.unref?.();
    } catch {
      // non-fatal
    }
  }

  let sidecarApp = null;
  if (isSidecarMode) {
    const { SidecarApp, Response } = await loadSidecarSdk();
    sidecarApp = new SidecarApp();

    sidecarApp.page('/', () => {
      const html = panelHtml.replace('</head>', '  <script src="/preload.js"></script>\n</head>');
      return new Response(html, {
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    });

    sidecarApp.api('/api/status', async () => {
      let adapterStatus = await getPlatformStatus({ platform: paths.platform });
      if (paths.platform === 'win32' && adapterStatus.mode === 'koffi_native') {
        try {
          await loadDefaultWin32Bindings();
        } catch (err) {
          adapterStatus = {
            mode: 'powershell_fallback',
            degradeReason: err?.message || String(err),
          };
        }
      }
      return {
        ...bridge.health,
        enabled: pluginEnabled,
        engineVersion: '2.0.0',
        adapterStatus,
        editors: detectEditors({ platform: paths.platform, bypassCache: true }),
        terminals: detectTerminals({ platform: paths.platform }),
      };
    }, 'GET');

    sidecarApp.api('/api/preferences', async () => preferences.get(), 'GET');
    sidecarApp.api('/api/preferences', async (data) => preferences.set(data), 'POST');
    sidecarApp.api('/api/recent', async () => ({ items: recentActions }), 'GET');
    sidecarApp.api('/api/workspace-context', async (data) => {
      if (Array.isArray(data?.workspaceUris)) {
        rootResolver.setLiveWorkspaceUris(data.workspaceUris);
      }
      return { ok: true };
    }, 'POST');

    await sidecarApp.run();
  }

  bridge.start();

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    configWatcher?.close();
    ownership.stop();
    const forceExit = setTimeout(() => process.exit(0), 2000);
    forceExit.unref?.();
    await bridge.stop().catch(() => undefined);
    await sidecarApp?.close().catch(() => undefined);
    process.exit(0);
  }

  ownership.watch(shutdown);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      void shutdown();
    });
  }
}
