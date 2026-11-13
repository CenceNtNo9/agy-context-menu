import { loadConfig } from './core/config-loader.mjs';
import {
  SOURCE_PRIORITY,
  WorkspaceRootResolver,
  encodePathToFileUrl,
  resolveBestTargetWithEngine,
  resolveTarget,
  resolveTargetAsync,
} from './core/path-resolver.mjs';
import { buildContextMenu } from './core/menu-builder.mjs';
import {
  classifyOpenStrategy,
  isTrustedUncHost,
  isUntrustedUncPath,
  parseUncPath,
} from './core/security-policy.mjs';
import {
  detectEditors,
  detectInstalledEditor,
  resolveEditorInvocation,
} from './core/editor-router.mjs';

export {
  SOURCE_PRIORITY,
  WorkspaceRootResolver,
  buildContextMenu,
  classifyOpenStrategy,
  detectEditors,
  detectInstalledEditor,
  encodePathToFileUrl,
  isTrustedUncHost,
  isUntrustedUncPath,
  loadConfig,
  parseUncPath,
  resolveBestTargetWithEngine,
  resolveEditorInvocation,
  resolveTarget,
  resolveTargetAsync,
};

/**
 * Defense-in-depth guard: reject untrusted UNC paths before invoking any OS/shell adapter method.
 * @param {string | null | undefined} candidatePath
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
function isBlockedUntrustedUnc(candidatePath, config) {
  if (typeof candidatePath !== 'string' || !candidatePath) {
    return false;
  }
  return isUntrustedUncPath(candidatePath, 'win32', config);
}

/**
 * Obtain the active platform adapter, lazily loading `src/platform/index.mjs` when not injected.
 * @param {Record<string, any> | undefined} platformAdapter
 * @returns {Promise<Record<string, any>>}
 */
async function resolveAdapter(platformAdapter) {
  if (platformAdapter) {
    return platformAdapter;
  }
  const mod = await import('./platform/index.mjs');
  return mod.getDefaultPlatformAdapter();
}

/**
 * Execute a context menu action against a resolved target using the 3-tier routing & security policy.
 * @param {object} params
 * @param {string} params.actionId
 * @param {Record<string, any>} params.target
 * @param {boolean} [params.confirmed]
 * @param {Record<string, any>} [params.platformAdapter]
 * @param {Record<string, any>} [params.config]
 * @param {NodeJS.Platform} [params.platform]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {any} [params.fsImpl]
 * @returns {Promise<Record<string, any>>}
 */
export async function executeMenuAction({
  actionId,
  target,
  confirmed = false,
  platformAdapter,
  config = {},
  platform,
  env,
  fsImpl,
}) {
  if (!target || typeof target !== 'object') {
    return {
      ok: false,
      status: 'error',
      reason: 'invalid_target',
      message: '缺少有效的目标对象',
    };
  }

  const adapter = await resolveAdapter(platformAdapter);

  // Defense-in-depth: never let non-confirmed or spoofed targets pass an untrusted UNC path to FS/Shell adapters
  if (
    actionId !== 'copy_path' &&
    actionId !== 'copy_text' &&
    actionId !== 'open_untrusted_unc'
  ) {
    const pathToVerify =
      actionId === 'reveal_nearest_parent' ? target.nearestExistingParent : target.normalizedPath;
    if (isBlockedUntrustedUnc(pathToVerify, config)) {
      return {
        ok: false,
        status: 'error',
        reason: 'untrusted_unc_rejected',
        actionId,
        targetPath: pathToVerify,
        message: `安全策略拒绝执行：路径 "${pathToVerify}" 为未受信任的外部 UNC 网络路径`,
      };
    }
  }

  switch (actionId) {
    case 'open_file': {
      const strategyInfo = classifyOpenStrategy(target, config, platform);

      if (strategyInfo.strategy === 'executable_intercept') {
        if (!confirmed) {
          return {
            ok: false,
            status: 'confirmation_required',
            reason: 'executable_extension',
            targetPath: target.normalizedPath,
            ext: strategyInfo.ext,
            message: `文件 "${target.normalizedPath}" 为高危可执行/脚本类型 (${strategyInfo.ext})，直接运行存在安全风险，请确认是否继续打开。`,
          };
        }
        const adapterResult = await adapter.openDefault(target.normalizedPath);
        return {
          ok: true,
          status: 'executed',
          actionId,
          strategy: strategyInfo.strategy,
          ...adapterResult,
        };
      }

      if (strategyInfo.strategy === 'open_in_editor') {
        const invocation = resolveEditorInvocation({
          filePath: target.normalizedPath,
          line: target.line ?? null,
          column: target.column ?? null,
          config,
          platform,
          env,
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
        return {
          ok: true,
          status: 'executed',
          actionId,
          strategy: strategyInfo.strategy,
          editorId: invocation.editorId,
          isFallback: invocation.isFallback,
          ...adapterResult,
        };
      }

      if (strategyInfo.strategy === 'open_default') {
        const adapterResult = await adapter.openDefault(target.normalizedPath);
        return {
          ok: true,
          status: 'executed',
          actionId,
          strategy: strategyInfo.strategy,
          ...adapterResult,
        };
      }

      return {
        ok: false,
        status: 'error',
        reason: 'unsupported_target_for_open',
        actionId,
        targetKind: target.kind,
        message: `目标类型 "${target.kind}" 不支持 open_file 动作`,
      };
    }

    case 'open_untrusted_unc': {
      if (!confirmed) {
        return {
          ok: false,
          status: 'confirmation_required',
          reason: 'untrusted_unc_path',
          targetPath: target.normalizedPath,
          message: `路径 "${target.normalizedPath}" 指向外部 UNC 网络共享，访问它可能触发 SMB 凭据认证并泄漏本机 NTLM Hash，请确认是否继续打开。`,
        };
      }
      const adapterResult = await adapter.openDefault(target.normalizedPath);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'reveal_in_folder': {
      const adapterResult = await adapter.revealInFolder(target.normalizedPath);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'open_directory': {
      const adapterResult = await adapter.openDirectory(target.normalizedPath);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'reveal_nearest_parent': {
      if (!target.nearestExistingParent) {
        return {
          ok: false,
          status: 'error',
          reason: 'no_existing_parent',
          actionId,
          message: '未找到存在的上层文件夹',
        };
      }
      const adapterResult = await adapter.openDirectory(target.nearestExistingParent);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'copy_file_entity': {
      const adapterResult = await adapter.copyFileEntity(target.normalizedPath);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'copy_path': {
      const adapterResult = await adapter.copyText(target.normalizedPath);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    case 'copy_text': {
      const adapterResult = await adapter.copyText(target.text);
      return {
        ok: true,
        status: 'executed',
        actionId,
        ...adapterResult,
      };
    }

    default:
      return {
        ok: false,
        status: 'error',
        reason: 'unknown_action',
        actionId,
        message: `未知菜单动作: ${actionId}`,
      };
  }
}

/**
 * Create a pre-configured file action engine bound to loaded config and optional runtime overrides.
 * @param {object} [options]
 */
export function createFileActionEngine(options = {}) {
  const config =
    options.config ||
    loadConfig({
      userConfigPath: options.userConfigPath,
      overrideConfig: options.overrideConfig,
      fsImpl: options.fsImpl,
      env: options.env,
      platform: options.platform,
    });

  const baseOpts = {
    config,
    workspaceRoots: options.workspaceRoots || [],
    platform: options.platform,
    env: options.env,
    fsImpl: options.fsImpl,
    asyncStatImpl: options.asyncStatImpl,
  };

  return {
    config,
    resolveTarget(input, callOptions = {}) {
      return resolveTarget(input, { ...baseOpts, ...callOptions });
    },
    resolveTargetAsync(input, callOptions = {}) {
      return resolveTargetAsync(input, { ...baseOpts, ...callOptions });
    },
    resolveBestTargetWithEngine(callOptions = {}) {
      return resolveBestTargetWithEngine({ ...baseOpts, ...callOptions });
    },
    buildContextMenu(resolvedTarget, callConfig, callOptions) {
      return buildContextMenu(resolvedTarget, callConfig || config, callOptions);
    },
    classifyOpenStrategy(target) {
      return classifyOpenStrategy(target, config, options.platform);
    },
    executeMenuAction({ actionId, target, confirmed = false, platformAdapter, config: callConfig }) {
      return executeMenuAction({
        actionId,
        target,
        confirmed,
        platformAdapter: platformAdapter || options.platformAdapter,
        config: callConfig || config,
        platform: options.platform,
        env: options.env,
        fsImpl: options.fsImpl,
      });
    },
  };
}
