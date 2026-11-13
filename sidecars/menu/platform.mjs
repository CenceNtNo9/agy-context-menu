import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves Antigravity desktop and customization paths across Windows, macOS, and Linux.
 */
export function resolvePlatformPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  let userDataDir;
  if (env.AGY_CONTEXT_MENU_USER_DATA) {
    userDataDir = env.AGY_CONTEXT_MENU_USER_DATA;
  } else if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    userDataDir = join(appData, 'Antigravity');
  } else if (platform === 'darwin') {
    userDataDir = join(home, 'Library', 'Application Support', 'Antigravity');
  } else {
    const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');
    userDataDir = join(xdgConfig, 'Antigravity');
  }

  const geminiConfigDir = join(home, '.gemini', 'config');
  const appDataDir = join(home, '.gemini', 'antigravity');
  const dataDir =
    env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(appDataDir, 'sidecar_data', 'agy-context-menu', 'menu', 'data');

  return {
    platform,
    home,
    userDataDir,
    devToolsPortFile: join(userDataDir, 'DevToolsActivePort'),
    geminiConfigDir,
    pluginConfigFile: join(geminiConfigDir, 'config.json'),
    projectsDir: join(geminiConfigDir, 'projects'),
    appDataDir,
    brainDir: join(appDataDir, 'brain'),
    scratchDir: join(appDataDir, 'scratch'),
    dataDir,
    preferencesFile: join(dataDir, 'preferences.json'),
    stateFile: join(dataDir, 'integration-state.json'),
  };
}

/**
 * Checks whether the plugin is enabled in ~/.gemini/config/config.json.
 * Returns false only when explicitly disabled; missing file or missing entry defaults to true.
 */
export function isPluginEnabled(pluginConfigFile, pluginDirName = 'agy-context-menu') {
  try {
    const raw = readFileSync(pluginConfigFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed?.plugins?.[pluginDirName]?.enabled !== false;
  } catch {
    return true;
  }
}
