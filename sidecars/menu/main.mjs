import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyFileEntity,
  copyTextToOsClipboard,
  detectEditors,
  detectTerminals,
  openDefault,
  openInEditor,
  openInTerminal,
  revealInFolder,
} from './os-actions.mjs';
import { resolveBestTarget, WorkspaceRootResolver } from './path-resolver.mjs';
import { isPluginEnabled, resolvePlatformPaths } from './platform.mjs';
import { PreferencesStore } from './preferences.mjs';
import { RuntimeBridge } from './runtime-bridge.mjs';
import { loadSidecarSdk } from './sdk-loader.mjs';
import { SidecarOwner } from './sidecar-owner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = resolvePlatformPaths();
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

function queryAgentConversationMetadata(conversationId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (!exe && !process.env.ANTIGRAVITY_LS_ADDRESS) {
    return null;
  }
  try {
    const file = exe || 'agentapi';
    const args = exe
      ? ['agentapi', 'get-conversation-metadata', conversationId]
      : ['get-conversation-metadata', conversationId];
    const out = execFileSync(file, args, { encoding: 'utf8', timeout: 2000, windowsHide: true });
    return out.trim() ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

const rootResolver = new WorkspaceRootResolver({
  platform: paths.platform,
  projectsDir: paths.projectsDir,
  brainDir: paths.brainDir,
  scratchDir: paths.scratchDir,
  getConversationMetadata: (id) => queryAgentConversationMetadata(id),
});

let pluginEnabled = isPluginEnabled(paths.pluginConfigFile);
const isSidecarMode = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const ownership = new SidecarOwner(paths.dataDir);
const claimed = await ownership.claim();
if (!claimed) {
  process.exit(0);
}

async function handleRpc(type, input) {
  const prefs = await preferences.get();
  const editors = detectEditors({ platform: paths.platform });
  const terminals = detectTerminals({ platform: paths.platform });

  if (type === 'get-config') {
    return {
      ok: true,
      platform: paths.platform,
      language: prefs.language,
      preferredEditor: prefs.preferredEditor,
      preferredTerminal: prefs.preferredTerminal,
      altClickOpenDefault: prefs.altClickOpenDefault,
      editors,
      terminals,
    };
  }

  if (type === 'resolve-target') {
    const workspaceRoots = await rootResolver.getRoots({
      conversationId: input.conversationId,
      hintDirs: input.hintDirs,
    });
    const resolved = await resolveBestTarget({
      candidates: input.candidates || [],
      workspaceRoots,
      platform: paths.platform,
      homeDir: paths.home,
    });
    return {
      ok: true,
      ...resolved,
      platform: paths.platform,
      language: prefs.language,
      preferredEditor: prefs.preferredEditor,
      editors,
    };
  }

  if (type === 'execute-action') {
    const action = input.action;
    try {
      if (action === 'open-default') {
        await openDefault(input.targetPath, { platform: paths.platform });
      } else if (action === 'reveal') {
        await revealInFolder(input.targetPath, {
          exists: input.exists !== false,
          nearestExistingDir: input.nearestExistingDir || null,
          platform: paths.platform,
        });
      } else if (action === 'open-editor') {
        await openInEditor({
          targetPath: input.targetPath,
          line: input.line,
          col: input.col,
          editorId: input.editorId || prefs.preferredEditor,
          customCommand: prefs.customEditorCommand,
          platform: paths.platform,
        });
      } else if (action === 'open-terminal') {
        const dirPath = input.exists === false
          ? input.nearestExistingDir
          : input.isDirectory
            ? input.targetPath
            : dirname(input.targetPath);
        await openInTerminal({
          dirPath,
          terminalId: prefs.preferredTerminal,
          platform: paths.platform,
        });
      } else if (action === 'copy-file') {
        await copyFileEntity(input.targetPath, { platform: paths.platform });
      } else if (action === 'copy-text' || action.startsWith('copy-')) {
        await copyTextToOsClipboard(input.text ?? input.targetPath ?? '', {
          platform: paths.platform,
        });
      } else {
        return { ok: false, error: `Unknown action: ${action}` };
      }

      recordAction({
        action,
        target: input.targetPath || (input.text ? String(input.text).slice(0, 60) : ''),
        ok: true,
      });
      return { ok: true };
    } catch (err) {
      recordAction({
        action,
        target: input.targetPath || '',
        ok: false,
        error: err?.message || 'Action failed',
      });
      return { ok: false, error: err?.message || 'Action failed' };
    }
  }

  return { ok: false, error: `Unknown RPC type: ${type}` };
}

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

  sidecarApp.api('/api/status', async () => ({
    ...bridge.health,
    enabled: pluginEnabled,
    editors: detectEditors({ platform: paths.platform, bypassCache: true }),
    terminals: detectTerminals({ platform: paths.platform }),
  }), 'GET');

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
