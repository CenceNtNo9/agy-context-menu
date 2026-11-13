import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WIN_SHOPEN_SCRIPT = [
  '$target = $env:AGY_TARGET_PATH',
  'if ([string]::IsNullOrWhiteSpace($target)) { exit 1 }',
  '$sig = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class AgyShellReveal {',
  '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]',
  '  public static extern IntPtr ILCreateFromPathW(string pszPath);',
  '  [DllImport("shell32.dll")]',
  '  public static extern int SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr apidl, uint dwFlags);',
  '  [DllImport("shell32.dll")]',
  '  public static extern void ILFree(IntPtr pidl);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $sig -ErrorAction Stop',
  '$pidl = [AgyShellReveal]::ILCreateFromPathW($target)',
  'if ($pidl -eq [IntPtr]::Zero) { exit 2 }',
  'try {',
  '  $hr = [AgyShellReveal]::SHOpenFolderAndSelectItems($pidl, 0, [IntPtr]::Zero, 0)',
  '  if ($hr -ne 0) { exit 3 }',
  '} finally {',
  '  [AgyShellReveal]::ILFree($pidl)',
  '}',
].join('\n');

const WIN_COPY_FILE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$target = $env:AGY_CLIP_PATH',
  'if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)) { exit 1 }',
  '$col = New-Object System.Collections.Specialized.StringCollection',
  '[void]$col.Add($target)',
  '[System.Windows.Forms.Clipboard]::SetFileDropList($col)',
  'if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { exit 2 }',
].join('; ');

const WIN_COPY_TEXT_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$txt = $env:AGY_CLIP_TEXT',
  'if ($null -eq $txt) { $txt = "" }',
  'if ($txt.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($txt) }',
].join('; ');

const MAC_COPY_FILE_JXA = [
  'ObjC.import("AppKit");',
  'function run(argv) {',
  '  const filePath = argv[0];',
  '  if (!filePath) throw new Error("Missing file path");',
  '  const pb = $.NSPasteboard.generalPasteboard;',
  '  pb.clearContents();',
  '  const url = $.NSURL.fileURLWithPath(filePath);',
  '  const ok = pb.writeObjects($.NSArray.arrayWithObject(url));',
  '  if (!ok) throw new Error("NSPasteboard writeObjects failed");',
  '}',
].join('\n');

function getWindowsEditorCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  return [
    {
      id: 'vscode',
      label: 'VS Code',
      style: 'goto',
      bins: [
        localAppData && path.win32.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.win32.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
        path.win32.join(programFilesX86, 'Microsoft VS Code', 'Code.exe'),
      ].filter(Boolean),
    },
    {
      id: 'vscode-insiders',
      label: 'VS Code Insiders',
      style: 'goto',
      bins: [
        localAppData && path.win32.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        path.win32.join(programFiles, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
      ].filter(Boolean),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      style: 'goto',
      bins: [
        localAppData && path.win32.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
        path.win32.join(programFiles, 'cursor', 'Cursor.exe'),
      ].filter(Boolean),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      style: 'goto',
      bins: [
        localAppData && path.win32.join(localAppData, 'Programs', 'Windsurf', 'Windsurf.exe'),
        path.win32.join(programFiles, 'Windsurf', 'Windsurf.exe'),
      ].filter(Boolean),
    },
    {
      id: 'zed',
      label: 'Zed',
      style: 'colon',
      bins: [
        localAppData && path.win32.join(localAppData, 'Programs', 'Zed', 'Zed.exe'),
        path.win32.join(programFiles, 'Zed', 'Zed.exe'),
      ].filter(Boolean),
    },
    {
      id: 'sublime',
      label: 'Sublime Text',
      style: 'colon',
      bins: [
        path.win32.join(programFiles, 'Sublime Text', 'sublime_text.exe'),
        path.win32.join(programFiles, 'Sublime Text 3', 'sublime_text.exe'),
      ],
    },
  ];
}

function getDarwinEditorCandidates(home = homedir()) {
  const apps = ['/Applications', path.posix.join(home, 'Applications')];
  const fromApps = (appName, innerRel) => apps.map((dir) => path.posix.join(dir, appName, innerRel));

  return [
    {
      id: 'vscode',
      label: 'VS Code',
      style: 'goto',
      bins: [
        ...fromApps('Visual Studio Code.app', 'Contents/Resources/app/bin/code'),
        '/opt/homebrew/bin/code',
        '/usr/local/bin/code',
      ],
    },
    {
      id: 'vscode-insiders',
      label: 'VS Code Insiders',
      style: 'goto',
      bins: [
        ...fromApps('Visual Studio Code - Insiders.app', 'Contents/Resources/app/bin/code'),
        '/opt/homebrew/bin/code-insiders',
        '/usr/local/bin/code-insiders',
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      style: 'goto',
      bins: [
        ...fromApps('Cursor.app', 'Contents/Resources/app/bin/cursor'),
        '/opt/homebrew/bin/cursor',
        '/usr/local/bin/cursor',
      ],
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      style: 'goto',
      bins: [
        ...fromApps('Windsurf.app', 'Contents/Resources/app/bin/windsurf'),
        '/opt/homebrew/bin/windsurf',
        '/usr/local/bin/windsurf',
      ],
    },
    {
      id: 'zed',
      label: 'Zed',
      style: 'colon',
      bins: [
        ...fromApps('Zed.app', 'Contents/MacOS/cli'),
        '/opt/homebrew/bin/zed',
        '/usr/local/bin/zed',
      ],
    },
    {
      id: 'sublime',
      label: 'Sublime Text',
      style: 'colon',
      bins: [
        ...fromApps('Sublime Text.app', 'Contents/SharedSupport/bin/subl'),
        '/opt/homebrew/bin/subl',
        '/usr/local/bin/subl',
      ],
    },
  ];
}

let cachedEditors = null;
let cachedEditorsAt = 0;

/**
 * Detects installed external code editors on Windows or macOS.
 */
export function detectEditors({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  existsFn = existsSync,
  bypassCache = false,
} = {}) {
  if (!bypassCache && cachedEditors && Date.now() - cachedEditorsAt < 60_000 && platform === process.platform) {
    return cachedEditors;
  }

  const specs =
    platform === 'win32'
      ? getWindowsEditorCandidates(env)
      : platform === 'darwin'
        ? getDarwinEditorCandidates(home)
        : [];

  const found = [];
  for (const spec of specs) {
    const exe = spec.bins.find((candidate) => existsFn(candidate));
    if (exe) {
      found.push({ id: spec.id, label: spec.label, style: spec.style, executable: exe });
    }
  }

  if (!bypassCache && platform === process.platform) {
    cachedEditors = found;
    cachedEditorsAt = Date.now();
  }
  return found;
}

/**
 * Detects available terminal applications on Windows or macOS.
 */
export function detectTerminals({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  existsFn = existsSync,
} = {}) {
  if (platform === 'win32') {
    const terminals = [];
    const localAppData = env.LOCALAPPDATA || '';
    const wtExe = localAppData ? path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe') : '';
    if (wtExe && existsFn(wtExe)) {
      terminals.push({ id: 'wt', label: 'Windows Terminal', executable: wtExe });
    }
    terminals.push({ id: 'powershell', label: 'PowerShell', executable: 'powershell.exe' });
    return terminals;
  }

  if (platform === 'darwin') {
    const apps = ['/Applications', path.posix.join(home, 'Applications')];
    const hasApp = (bundle) => apps.some((dir) => existsFn(path.posix.join(dir, bundle)));
    const terminals = [];
    if (hasApp('iTerm.app')) terminals.push({ id: 'iterm', label: 'iTerm2', appName: 'iTerm' });
    if (hasApp('Ghostty.app')) terminals.push({ id: 'ghostty', label: 'Ghostty', appName: 'Ghostty' });
    if (hasApp('Warp.app')) terminals.push({ id: 'warp', label: 'Warp', appName: 'Warp' });
    terminals.push({ id: 'terminal', label: 'Terminal', appName: 'Terminal' });
    return terminals;
  }

  return [];
}

/**
 * Opens a file or folder with the operating system's default application.
 */
export async function openDefault(
  targetPath,
  { platform = process.platform, existsFn = existsSync, execFileFn = execFileAsync, env = process.env } = {}
) {
  if (!targetPath || !existsFn(targetPath)) {
    throw new Error(`Target does not exist: ${targetPath}`);
  }
  if (platform === 'darwin') {
    await execFileFn('/usr/bin/open', [targetPath]);
    return;
  }
  if (platform === 'win32') {
    await execFileFn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        '$p = [System.Diagnostics.ProcessStartInfo]::new($env:AGY_TARGET_PATH); $p.UseShellExecute = $true; [void][System.Diagnostics.Process]::Start($p)',
      ],
      {
        env: { ...env, AGY_TARGET_PATH: targetPath },
        windowsHide: true,
      }
    );
    return;
  }
  await execFileFn('xdg-open', [targetPath]);
}

/**
 * Reveals a file or directory in Windows Explorer or macOS Finder.
 * Falls back to opening nearestExistingDir if the file was deleted.
 */
export async function revealInFolder(
  targetPath,
  {
    exists = true,
    nearestExistingDir = null,
    platform = process.platform,
    existsFn = existsSync,
    execFileFn = execFileAsync,
    env = process.env,
  } = {}
) {
  if (!exists) {
    if (nearestExistingDir && existsFn(nearestExistingDir)) {
      await openDefault(nearestExistingDir, { platform, existsFn, execFileFn, env });
      return { openedFallbackDir: nearestExistingDir };
    }
    throw new Error(`Neither target nor parent folder exists: ${targetPath}`);
  }

  if (platform === 'darwin') {
    await execFileFn('/usr/bin/open', ['-R', targetPath]);
    return { revealed: true };
  }

  if (platform === 'win32') {
    try {
      await execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_SHOPEN_SCRIPT],
        {
          env: { ...env, AGY_TARGET_PATH: targetPath },
          windowsHide: true,
        }
      );
      return { revealed: true, method: 'SHOpenFolderAndSelectItems' };
    } catch {
      await execFileFn('explorer.exe', [`/select,${targetPath}`], { windowsHide: true });
      return { revealed: true, method: 'explorer' };
    }
  }

  const parent = path.posix.dirname(targetPath);
  await execFileFn('xdg-open', [parent]);
  return { revealed: true };
}

/**
 * Copies a real file entity to the OS clipboard (CF_HDROP on Windows, NSURL/NSPasteboard on macOS)
 * so the user can Ctrl+V / Cmd+V directly into WeChat, Feishu, Explorer, or Finder.
 */
export async function copyFileEntity(
  targetPath,
  { platform = process.platform, existsFn = existsSync, execFileFn = execFileAsync, env = process.env } = {}
) {
  if (!targetPath || !existsFn(targetPath)) {
    throw new Error(`File does not exist: ${targetPath}`);
  }

  if (platform === 'win32') {
    await execFileFn(
      'powershell.exe',
      ['-Sta', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_COPY_FILE_SCRIPT],
      {
        env: { ...env, AGY_CLIP_PATH: targetPath },
        windowsHide: true,
      }
    );
    return;
  }

  if (platform === 'darwin') {
    await execFileFn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_COPY_FILE_JXA, targetPath]);
    return;
  }

  throw new Error(`copyFileEntity is not supported on platform: ${platform}`);
}

/**
 * Copies plain text (e.g. clean native file path or inline code) directly to the OS clipboard.
 */
export async function copyTextToOsClipboard(
  text,
  { platform = process.platform, execFileFn = execFileAsync, spawnFn = spawn, env = process.env } = {}
) {
  const value = String(text ?? '');
  if (platform === 'win32') {
    await execFileFn(
      'powershell.exe',
      ['-Sta', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_COPY_TEXT_SCRIPT],
      {
        env: { ...env, AGY_CLIP_TEXT: value },
        windowsHide: true,
      }
    );
    return;
  }

  if (platform === 'darwin') {
    await new Promise((resolve, reject) => {
      const child = spawnFn('/usr/bin/pbcopy', [], {
        env: { ...env, LANG: 'en_US.UTF-8' },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `pbcopy exited with code ${code}`));
      });
      child.stdin.end(Buffer.from(value, 'utf8'));
    });
    return;
  }

  throw new Error(`copyTextToOsClipboard is not supported on platform: ${platform}`);
}

/**
 * Builds executable + argv array for launching an external editor at an optional line/column.
 */
export function buildEditorLaunch({
  targetPath,
  line,
  col,
  editorId = 'auto',
  customCommand = '',
  editors = [],
}) {
  if (editorId === 'custom' && customCommand) {
    const targetArg = line ? `${targetPath}:${line}${col ? `:${col}` : ''}` : targetPath;
    return {
      executable: customCommand,
      args: [targetArg],
      label: path.basename(customCommand),
    };
  }

  const chosen =
    (editorId && editorId !== 'auto' ? editors.find((e) => e.id === editorId) : null) || editors[0];
  if (!chosen) {
    return null;
  }

  const loc = line ? `${targetPath}:${line}${col ? `:${col}` : ''}` : targetPath;
  const args = chosen.style === 'goto' && line ? ['--goto', loc] : [loc];
  return {
    executable: chosen.executable,
    args,
    label: chosen.label,
    id: chosen.id,
  };
}

/**
 * Launches a file in an installed external code editor (jumping to line/column if present).
 */
export async function openInEditor({
  targetPath,
  line,
  col,
  editorId = 'auto',
  customCommand = '',
  platform = process.platform,
  existsFn = existsSync,
  spawnFn = spawn,
  execFileFn = execFileAsync,
  env = process.env,
  home = homedir(),
} = {}) {
  if (!targetPath || !existsFn(targetPath)) {
    throw new Error(`Target does not exist: ${targetPath}`);
  }
  const editors = detectEditors({ platform, env, home, existsFn });
  const launch = buildEditorLaunch({ targetPath, line, col, editorId, customCommand, editors });
  if (!launch) {
    await openDefault(targetPath, { platform, existsFn, execFileFn, env });
    return { fallbackDefault: true };
  }

  const child = spawnFn(launch.executable, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return { launched: launch.label };
}

/**
 * Opens a terminal window at the specified directory.
 */
export async function openInTerminal({
  dirPath,
  terminalId = 'auto',
  platform = process.platform,
  existsFn = existsSync,
  spawnFn = spawn,
  execFileFn = execFileAsync,
  env = process.env,
  home = homedir(),
} = {}) {
  if (!dirPath || !existsFn(dirPath)) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }
  const terminals = detectTerminals({ platform, env, home, existsFn });
  const chosen =
    (terminalId && terminalId !== 'auto' ? terminals.find((t) => t.id === terminalId) : null) || terminals[0];

  if (platform === 'win32') {
    if (chosen?.id === 'wt' && chosen.executable) {
      const child = spawnFn(chosen.executable, ['-d', dirPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref?.();
      return { launched: chosen.label };
    }
    const child = spawnFn('cmd.exe', ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit'], {
      cwd: dirPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref?.();
    return { launched: 'PowerShell' };
  }

  if (platform === 'darwin') {
    const appName = chosen?.appName || 'Terminal';
    await execFileFn('/usr/bin/open', ['-a', appName, dirPath]);
    return { launched: appName };
  }

  throw new Error(`openInTerminal is not supported on platform: ${platform}`);
}
