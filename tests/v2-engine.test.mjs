import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceRootResolver,
  buildContextMenu,
  classifyOpenStrategy,
  createFileActionEngine,
  detectEditors,
  encodePathToFileUrl,
  executeMenuAction,
  isUntrustedUncPath,
  loadConfig,
  parseUncPath,
  resolveBestTargetWithEngine,
  resolveEditorInvocation,
  resolveTarget,
  resolveTargetAsync,
} from '../src/index.mjs';
import { parseJsonc, stripJsonc } from '../src/core/config-loader.mjs';
import {
  Win32FfiAdapter,
  getPlatformStatus,
  hasCachedWin32Bindings,
  loadDefaultWin32Bindings,
  readClipboardFileDropList,
  readClipboardText,
  resetWin32BindingsState,
} from '../src/platform/index.mjs';

const IS_WINDOWS = process.platform === 'win32';

function createMockFs(entries = {}) {
  const map = new Map(Object.entries(entries));
  const statCalls = [];

  return {
    statCalls,
    statSync(targetPath) {
      statCalls.push(targetPath);
      const entry = map.get(targetPath);
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, stat '${targetPath}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'dir',
        size: entry.size ?? 128,
        mtimeMs: entry.mtimeMs ?? 1700000000000,
      };
    },
    existsSync(targetPath) {
      return map.has(targetPath);
    },
  };
}

function createMockAsyncStat(entries = {}) {
  const map = new Map(Object.entries(entries));
  const statCalls = [];
  const fn = async (targetPath) => {
    statCalls.push(targetPath);
    const entry = map.get(targetPath);
    if (!entry) {
      const err = new Error(`ENOENT: ${targetPath}`);
      err.code = 'ENOENT';
      throw err;
    }
    return {
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'dir',
      size: entry.size ?? 256,
      mtimeMs: entry.mtimeMs ?? 1700000000000,
    };
  };
  fn.statCalls = statCalls;
  return fn;
}

function createMockPlatformAdapter() {
  const calls = [];
  return {
    calls,
    async revealInFolder(targetPath) {
      calls.push({ method: 'revealInFolder', args: [targetPath] });
      return { ok: true, method: 'mock_reveal' };
    },
    async openDefault(targetPath) {
      calls.push({ method: 'openDefault', args: [targetPath] });
      return { ok: true, method: 'mock_open_default' };
    },
    async openDirectory(dirPath) {
      calls.push({ method: 'openDirectory', args: [dirPath] });
      return { ok: true, method: 'mock_open_dir' };
    },
    async openInEditor(payload) {
      calls.push({ method: 'openInEditor', args: [payload] });
      return { ok: true, method: 'mock_open_editor', editor: payload.editorCommand };
    },
    async copyFileEntity(filePath) {
      calls.push({ method: 'copyFileEntity', args: [filePath] });
      return { ok: true, format: 'mock_file_entity' };
    },
    async copyText(text) {
      calls.push({ method: 'copyText', args: [text] });
      return { ok: true, format: 'mock_text' };
    },
  };
}

test('config-loader: loads config.default.jsonc without ? or . in trustedUncHosts', () => {
  const raw = `{
    // comment
    "url": "https://example.com/a/*x*/",
    "arr": [1, 2,],
  }`;
  assert.ok(!stripJsonc(raw).includes('/*x*/') === false); // string literal preserved
  assert.equal(parseJsonc(raw).arr.length, 2);

  const cfg = loadConfig({ userConfigPath: null });
  assert.ok(!cfg.trustedUncHosts.includes('?'));
  assert.ok(!cfg.trustedUncHosts.includes('.'));
  assert.ok(cfg.trustedUncHosts.includes('wsl.localhost'));
  assert.ok(cfg.editorPreferenceOrder.includes('vscode-insiders'));
  assert.equal(cfg.statTimeoutMs, 1500);
});

test('P3: tightens Win32 device & UNC allowlist (0 stat calls for GLOBALROOT, UNC, @SSL, multi-slash)', async () => {
  const mockFs = createMockFs({});
  const mockAsync = createMockAsyncStat({});

  const maliciousInputs = [
    '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\share\\a.txt',
    '\\\\.\\GLOBALROOT\\Device\\Mup\\evil\\share\\a.txt',
    '\\\\?\\UNC\\evil\\share\\a.txt',
    '\\\\?\\UNC\\localhost\\c$\\secret.txt',
    '\\\\?\\Pipe\\evilpipe',
    '\\\\evil@SSL\\DavWWWRoot\\a.txt',
    '\\\\localhost@SSL\\DavWWWRoot\\a.txt',
    '\\\\127.0.0.1@80\\DavWWWRoot\\a.txt',
    '///evil/share/a.txt',
    '\\\\\\evil\\share\\a.txt',
    '\\/evil/share/a.pdf',
    '/\\evil\\share\\a.pdf',
    '\\//evil/share/a.txt',
    '%5C%5Cevil%5Cshare%5Ca.txt',
    'file://///evil/share/a.pdf',
    'file://///?/GLOBALROOT/Device/Mup/evil/share/a.txt',
    'file://evil@SSL/DavWWWRoot/a.txt',
  ];

  // Even if caller passes polluted trustedUncHosts containing '?' or '.', P3 still blocks them
  const pollutedConfig = { trustedUncHosts: ['?', '.', 'localhost', 'wsl.localhost'] };

  for (const input of maliciousInputs) {
    assert.equal(
      isUntrustedUncPath(input, 'win32', pollutedConfig),
      true,
      `Expected isUntrustedUncPath=true for ${input}`,
    );

    const syncRes = resolveTarget(input, { platform: 'win32', fsImpl: mockFs, config: pollutedConfig });
    assert.equal(syncRes.kind, 'untrusted_unc', `Sync failed for ${input}: ${JSON.stringify(syncRes)}`);

    const asyncRes = await resolveTargetAsync(input, {
      platform: 'win32',
      asyncStatImpl: mockAsync,
      config: pollutedConfig,
    });
    assert.equal(asyncRes.kind, 'untrusted_unc', `Async failed for ${input}`);

    const engineRes = await resolveBestTargetWithEngine({
      candidates: [{ source: 'explicit-uri', value: input }],
      workspaceRoots: [],
      platform: 'win32',
      asyncStatImpl: mockAsync,
      config: pollutedConfig,
    });
    assert.equal(engineRes.kind, 'untrusted_unc', `Engine failed for ${input}`);
  }

  assert.equal(mockFs.statCalls.length, 0, 'statSync MUST NOT be called on any untrusted UNC/device path');
  assert.equal(mockAsync.statCalls.length, 0, 'async stat MUST NOT be called on any untrusted UNC/device path');
});

test('P3: allows \\\\?\\X:\\ and \\\\.\\Volume{GUID}\\ local device paths and trusted WSL UNC', async () => {
  const volPath = '\\\\.\\Volume{12345678-1234-1234-1234-1234567890ab}\\data\\ok.txt';
  const driveDevPath = '\\\\?\\C:\\Users\\Song\\ok.txt';
  const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\song\\main.py';

  assert.equal(parseUncPath(driveDevPath).isTrustedDevicePath, true);
  assert.equal(parseUncPath(volPath).isTrustedDevicePath, true);
  assert.equal(isUntrustedUncPath(driveDevPath, 'win32'), false);
  assert.equal(isUntrustedUncPath(volPath, 'win32'), false);
  assert.equal(isUntrustedUncPath(wslPath, 'win32'), false);

  const mockAsync = createMockAsyncStat({
    [driveDevPath]: { type: 'file' },
    [volPath]: { type: 'file' },
    [wslPath]: { type: 'file' },
  });

  const res1 = await resolveTargetAsync(driveDevPath, { platform: 'win32', asyncStatImpl: mockAsync });
  assert.equal(res1.kind, 'existing_file');
  const res2 = await resolveTargetAsync(volPath, { platform: 'win32', asyncStatImpl: mockAsync });
  assert.equal(res2.kind, 'existing_file');
  const res3 = await resolveTargetAsync(wslPath, { platform: 'win32', asyncStatImpl: mockAsync });
  assert.equal(res3.kind, 'existing_file');
});

test('P4: empty workspaceRoots NEVER falls back to process.cwd() (main.mjs / package.json)', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const prevCwd = process.cwd();
  process.chdir(repoRoot);
  try {
    // Confirm these files genuinely exist in process.cwd()
    assert.ok(fs.existsSync(path.join(process.cwd(), 'package.json')));

    const syncPass = resolveTarget('package.json', { workspaceRoots: [] });
    assert.equal(syncPass.kind, 'passthrough');
    assert.equal(syncPass.reason, 'no_workspace_roots');

    const inlineRes = await resolveBestTargetWithEngine({
      candidates: [{ source: 'inline-code', value: '`main.mjs`' }],
      workspaceRoots: [],
      platform: 'win32',
    });
    assert.equal(inlineRes.kind, 'inline_code_text');
    assert.equal(inlineRes.text, 'main.mjs');

    const caretRes = await resolveBestTargetWithEngine({
      candidates: [{ source: 'caret-token', value: 'package.json' }],
      workspaceRoots: [],
      platform: 'win32',
    });
    assert.equal(caretRes.kind, 'passthrough');
  } finally {
    process.chdir(prevCwd);
  }
});

test('P4: filters untrusted UNC workspaceRoots & enforces multi-candidate priority', async () => {
  const mockAsync = createMockAsyncStat({
    'C:\\Repo': { type: 'dir' },
    'C:\\Repo\\src': { type: 'dir' },
    'C:\\Repo\\src\\app.ts': { type: 'file', size: 300 },
  });

  // 1. Untrusted UNC root in workspaceRoots + hintDirs is stripped before probing
  const rootFiltered = await resolveBestTargetWithEngine({
    candidates: [{ source: 'inline-code', value: 'src/app.ts' }],
    workspaceRoots: ['\\\\evil\\share', 'C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(rootFiltered.kind, 'existing_file');
  assert.equal(rootFiltered.normalizedPath, 'C:\\Repo\\src\\app.ts');
  assert.ok(
    mockAsync.statCalls.every((p) => !p.startsWith('\\\\evil')),
    'Must never stat untrusted UNC root',
  );

  // 2. High-priority explicit missing_path beats lower-priority untrusted_unc
  const missingBeatsLowerUnc = await resolveBestTargetWithEngine({
    candidates: [
      { source: 'caret-token', value: '\\\\evil\\share\\payload.exe' },
      { source: 'explicit-uri', value: 'file:///C:/Repo/src/deleted.ts#L10' },
    ],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(missingBeatsLowerUnc.kind, 'missing_path');
  assert.equal(missingBeatsLowerUnc.normalizedPath, 'C:\\Repo\\src\\deleted.ts');
  assert.equal(missingBeatsLowerUnc.nearestExistingParent, 'C:\\Repo\\src');

  // 3. Untrusted UNC without prior higher-priority missing_path short-circuits immediately with 0 stat calls
  const freshAsync = createMockAsyncStat({});
  const uncShortCircuit = await resolveBestTargetWithEngine({
    candidates: [
      { source: 'explicit-uri', value: '\\\\evil\\share\\doc.pdf' },
      { source: 'caret-token', value: 'C:\\Repo\\src\\app.ts' },
    ],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: freshAsync,
  });
  assert.equal(uncShortCircuit.kind, 'untrusted_unc');
  assert.equal(freshAsync.statCalls.length, 0);

  // 4. Existing file in lower priority beats higher-priority missing_path
  const existingBeatsMissing = await resolveBestTargetWithEngine({
    candidates: [
      { source: 'explicit-uri', value: 'file:///C:/Repo/src/missing.ts' },
      { source: 'inline-code', value: 'src/app.ts(42,10)' },
    ],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(existingBeatsMissing.kind, 'existing_file');
  assert.equal(existingBeatsMissing.line, 42);
  assert.equal(existingBeatsMissing.column, 10);

  // 5. High-priority external_scheme returns passthrough immediately
  const externalScheme = await resolveBestTargetWithEngine({
    candidates: [
      { source: 'explicit-uri', value: 'https://antigravity.google/docs' },
      { source: 'inline-code', value: 'src/app.ts' },
    ],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(externalScheme.kind, 'passthrough');
  assert.equal(externalScheme.reason, 'external_scheme');
});

test('SPA route & unknown leading-slash guard: /c/<uuid> and /settings never trigger missing_path on win32 or darwin', async () => {
  const winStat = createMockAsyncStat({
    'C:\\': { type: 'dir' },
    'C:\\Repo\\src\\app.ts': { type: 'file' },
  });
  const macStat = createMockAsyncStat({
    '/': { type: 'dir' },
    '/Users': { type: 'dir' },
    '/Users/song': { type: 'dir' },
    '/app/src/index.ts': { type: 'file' },
  });

  // 1. `/c/<uuid>` on BOTH win32 and darwin returns passthrough (`spa_route`) with ZERO stat calls
  for (const [plat, statFn] of [
    ['win32', winStat],
    ['darwin', macStat],
  ]) {
    const syncRes = resolveTarget('/c/ef629bba-982a-4e7b-ab0d-77a6837b8dda', {
      platform: plat,
      fsImpl: createMockFs({ '/': { type: 'dir' }, 'C:\\': { type: 'dir' } }),
    });
    assert.equal(syncRes.kind, 'passthrough', `sync /c/<uuid> failed on ${plat}`);
    assert.equal(syncRes.reason, 'spa_route');

    const asyncRes = await resolveTargetAsync('/c/ef629bba-982a-4e7b-ab0d-77a6837b8dda', {
      platform: plat,
      asyncStatImpl: statFn,
    });
    assert.equal(asyncRes.kind, 'passthrough', `async /c/<uuid> failed on ${plat}`);
    assert.equal(asyncRes.reason, 'spa_route');
  }
  assert.equal(winStat.statCalls.length, 0);
  assert.equal(macStat.statCalls.length, 0);

  // 2. High-priority SPA route candidate short-circuits lower-priority caret-token
  const fusedConv = await resolveBestTargetWithEngine({
    candidates: [
      { source: 'dom-attr', value: '/c/ef629bba-982a-4e7b-ab0d-77a6837b8dda' },
      { source: 'caret-token', value: 'src/app.ts' },
    ],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: winStat,
  });
  assert.equal(fusedConv.kind, 'passthrough');
  assert.equal(fusedConv.reason, 'spa_route');

  // 3. Generic SPA route `/settings/profile` never produces `missing_path` on win32 or darwin
  const winSettings = await resolveTargetAsync('/settings/profile', {
    platform: 'win32',
    asyncStatImpl: winStat,
  });
  assert.equal(winSettings.kind, 'passthrough');
  const macSettings = await resolveTargetAsync('/settings/profile', {
    platform: 'darwin',
    asyncStatImpl: macStat,
  });
  assert.equal(macSettings.kind, 'passthrough');
  assert.equal(macSettings.reason, 'spa_route');

  // 4. Slash commands in inline code (e.g. `/compact`) return `inline_code_text` cleanly
  const slashCmd = await resolveBestTargetWithEngine({
    candidates: [{ source: 'inline-code', value: '`/compact`' }],
    workspaceRoots: ['C:\\Repo'],
    platform: 'win32',
    asyncStatImpl: winStat,
  });
  assert.equal(slashCmd.kind, 'inline_code_text');
  assert.equal(slashCmd.text, '/compact');

  // 5. Real macOS missing file under `/Users/...` STILL resolves `missing_path` + `nearestExistingParent`,
  //    and existing custom root `/app/src/index.ts` in containers STILL resolves `existing_file`!
  const macMissing = await resolveTargetAsync('/Users/song/deleted.ts', {
    platform: 'darwin',
    asyncStatImpl: macStat,
  });
  assert.equal(macMissing.kind, 'missing_path');
  assert.equal(macMissing.nearestExistingParent, '/Users/song');

  const containerExisting = await resolveTargetAsync('/app/src/index.ts', {
    platform: 'linux',
    asyncStatImpl: macStat,
  });
  assert.equal(containerExisting.kind, 'existing_file');
});

test('path-resolver: supports parenthesis stack traces, WSL /mnt/<drive>, and encodePathToFileUrl', async () => {
  const mockAsync = createMockAsyncStat({
    'D:\\Proj\\Service.cs': { type: 'file' },
    'C:\\Users\\Song\\demo.ts': { type: 'file' },
  });

  const csRes = await resolveTargetAsync('Service.cs(42,10)', {
    workspaceRoots: ['D:\\Proj'],
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(csRes.kind, 'existing_file');
  assert.equal(csRes.line, 42);
  assert.equal(csRes.column, 10);

  const wslMountRes = await resolveTargetAsync('/mnt/c/Users/Song/demo.ts:7', {
    platform: 'win32',
    asyncStatImpl: mockAsync,
  });
  assert.equal(wslMountRes.kind, 'existing_file');
  assert.equal(wslMountRes.normalizedPath, 'C:\\Users\\Song\\demo.ts');
  assert.equal(wslMountRes.line, 7);

  assert.equal(
    encodePathToFileUrl('C:\\Users\\Song\\测试.txt', 'win32'),
    'file:///C:/Users/Song/%E6%B5%8B%E8%AF%95.txt',
  );
  assert.equal(
    encodePathToFileUrl('\\\\wsl.localhost\\Ubuntu\\home\\a.py', 'win32'),
    'file://wsl.localhost/Ubuntu/home/a.py',
  );
});

test('WorkspaceRootResolver: filters untrusted UNC roots from liveWorkspaceUris and hintDirs', async () => {
  const resolver = new WorkspaceRootResolver({
    platform: 'win32',
    scratchDir: 'C:\\Scratch',
  });
  resolver.setLiveWorkspaceUris([
    'file://evil/share/proj',
    'file:///C:/Local/Proj',
  ]);

  const roots = await resolver.getRoots({
    conversationId: '11111111-1111-1111-1111-111111111111',
    hintDirs: ['\\\\evil2\\share\\hint', 'D:\\Hints\\Dir'],
  });
  assert.ok(roots.includes('C:\\Local\\Proj'));
  assert.ok(roots.includes('D:\\Hints\\Dir'));
  assert.ok(!roots.some((r) => r.includes('evil')));
});

test('P5: async stat timeout protection prevents hanging on offline network/WSL paths', async () => {
  const slowStat = () => new Promise((resolve) => setTimeout(() => resolve(null), 500));

  const start = Date.now();
  const res = await resolveTargetAsync('C:\\Offline\\Share\\file.txt', {
    platform: 'win32',
    asyncStatImpl: slowStat,
    statTimeoutMs: 40,
  });
  const elapsed = Date.now() - start;

  assert.equal(res.kind, 'missing_path');
  assert.equal(res.nearestExistingParent, null);
  assert.ok(elapsed < 350, `Expected timeout protection to settle fast, took ${elapsed}ms`);
});

test('editor-router: detects vscode-insiders and exports detectEditors compatible shape', () => {
  const insidersBin = 'C:\\Users\\Song\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe';
  const mockFs = createMockFs({ [insidersBin]: { type: 'file' } });
  const env = { LOCALAPPDATA: 'C:\\Users\\Song\\AppData\\Local' };

  const list = detectEditors({
    platform: 'win32',
    env,
    fsImpl: mockFs,
    bypassCache: true,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'vscode-insiders');
  assert.equal(list[0].executable, insidersBin);

  const invocation = resolveEditorInvocation({
    filePath: 'C:\\Repo\\a.ts',
    line: 12,
    column: 3,
    platform: 'win32',
    env,
    fsImpl: mockFs,
  });
  assert.equal(invocation.editorId, 'vscode-insiders');
  assert.deepEqual(invocation.editorArgs, ['--goto', 'C:\\Repo\\a.ts:12:3']);
});

test('menu-builder: supports 5-state 4/2/2/1 minimal contract, zh-CN/en i18n, and optional extensions', () => {
  const fileTarget = { kind: 'existing_file', normalizedPath: 'C:\\a\\b.ts', fileName: 'b.ts', line: 10 };

  const defaultMenu = buildContextMenu(fileTarget);
  assert.equal(defaultMenu.items.length, 4);
  assert.deepEqual(
    defaultMenu.items.map((i) => i.id),
    ['open_file', 'reveal_in_folder', 'copy_file_entity', 'copy_path'],
  );
  assert.equal(defaultMenu.items[0].label, '打开');

  const enMenu = buildContextMenu(fileTarget, { language: 'en' });
  assert.equal(enMenu.items.length, 4);
  assert.deepEqual(
    enMenu.items.map((i) => i.label),
    ['Open', 'Reveal in Folder', 'Copy', 'Copy File Path'],
  );

  const extendedMenu = buildContextMenu(fileTarget, {
    language: 'en',
    options: { showHeader: true, showTerminal: true, showMention: true },
  });
  assert.deepEqual(
    extendedMenu.items.map((i) => i.id),
    [
      'header',
      'open_file',
      'reveal_in_folder',
      'copy_file_entity',
      'copy_path',
      'open_terminal',
      'mention_target',
    ],
  );
  assert.equal(extendedMenu.items[0].enabled, false);
  assert.equal(extendedMenu.items[0].label, 'b.ts:10');
});

test('executeMenuAction & classifyOpenStrategy: 3-tier open routing and spoofed UNC rejection', async () => {
  const adapter = createMockPlatformAdapter();
  const engine = createFileActionEngine({
    workspaceRoots: [],
    platformAdapter: adapter,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    fsImpl: createMockFs({}),
  });

  const exeBlocked = await engine.executeMenuAction({
    actionId: 'open_file',
    target: { kind: 'existing_file', normalizedPath: 'C:\\Temp\\run.ps1', ext: '.md' },
    confirmed: false,
  });
  assert.equal(exeBlocked.status, 'confirmation_required');
  assert.equal(exeBlocked.reason, 'executable_extension');

  const tsOpen = await engine.executeMenuAction({
    actionId: 'open_file',
    target: { kind: 'existing_file', normalizedPath: 'C:\\Repo\\main.ts' },
  });
  assert.equal(tsOpen.strategy, 'open_in_editor');
  assert.equal(adapter.calls.at(-1).method, 'openInEditor');

  const mdNoLine = await engine.executeMenuAction({
    actionId: 'open_file',
    target: { kind: 'existing_file', normalizedPath: 'C:\\Repo\\README.md', line: null },
  });
  assert.equal(mdNoLine.strategy, 'open_default');
  assert.equal(adapter.calls.at(-1).method, 'openDefault');

  const mdWithLine = await engine.executeMenuAction({
    actionId: 'open_file',
    target: { kind: 'existing_file', normalizedPath: 'C:\\Repo\\README.md', line: 10 },
  });
  assert.equal(mdWithLine.strategy, 'open_in_editor');

  const globalRootStrategy = classifyOpenStrategy({
    kind: 'existing_file',
    normalizedPath: '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\share\\a.txt',
  });
  assert.equal(globalRootStrategy.strategy, 'confirm_untrusted_unc');

  const spoofedRejected = await executeMenuAction({
    actionId: 'reveal_in_folder',
    target: { kind: 'existing_file', normalizedPath: '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\share\\a.txt' },
    platformAdapter: adapter,
  });
  assert.equal(spoofedRejected.ok, false);
  assert.equal(spoofedRejected.reason, 'untrusted_unc_rejected');
});

test('P8 regression: NTFS ADS (::$DATA, :Zone.Identifier), trailing dots/spaces, and extended executable suffixes are intercepted', async () => {
  const adapter = createMockPlatformAdapter();
  const mockAsync = createMockAsyncStat({});

  // 1. NTFS ADS must fail closed in path-resolver (0 stat calls, never existing_file)
  for (const adsInput of [
    'C:\\Repo\\evil.vbs::$DATA',
    'C:\\Repo\\evil.vbs:Zone.Identifier',
    'evil.vbs::$DATA',
  ]) {
    const syncRes = resolveTarget(adsInput, { platform: 'win32', workspaceRoots: ['C:\\Repo'] });
    assert.notEqual(syncRes.kind, 'existing_file');
    const asyncRes = await resolveTargetAsync(adsInput, {
      platform: 'win32',
      workspaceRoots: ['C:\\Repo'],
      asyncStatImpl: mockAsync,
    });
    assert.notEqual(asyncRes.kind, 'existing_file');
    assert.equal(asyncRes.reason, 'ntfs_ads_blocked');
  }
  assert.equal(mockAsync.statCalls.length, 0);

  // 2. Real-filesystem ADS & trailing dot/space regression (mirrors trail.mjs)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ads-'));
  try {
    const vbsPath = path.join(tmpDir, 'evil.vbs');
    fs.writeFileSync(vbsPath, 'MsgBox "hi"', 'utf8');

    for (const suffix of ['.', ' ', '. .', '...']) {
      const resolved = await resolveTargetAsync(vbsPath + suffix, {
        platform: 'win32',
        workspaceRoots: [],
      });
      if (resolved.kind === 'existing_file') {
        const strat = classifyOpenStrategy(resolved, {}, 'win32');
        assert.equal(strat.strategy, 'executable_intercept', `Expected intercept for suffix ${JSON.stringify(suffix)}`);
        assert.equal(strat.ext, '.vbs');
        const execRes = await executeMenuAction({
          actionId: 'open_file',
          target: resolved,
          confirmed: false,
          platform: 'win32',
          platformAdapter: adapter,
        });
        assert.equal(execRes.status, 'confirmation_required');
      }
    }

    for (const adsSuffix of ['::$DATA', ':Zone.Identifier']) {
      const adsResolved = await resolveTargetAsync(vbsPath + adsSuffix, {
        platform: 'win32',
        workspaceRoots: [],
      });
      assert.notEqual(adsResolved.kind, 'existing_file');
      // Defense-in-depth if someone passes an existing_file target directly to classifyOpenStrategy
      const directStrat = classifyOpenStrategy(
        {
          kind: 'existing_file',
          normalizedPath: vbsPath + adsSuffix,
        },
        {},
        'win32',
      );
      assert.equal(directStrat.strategy, 'executable_intercept');
      assert.equal(directStrat.ext, '.vbs');
    }

    const txtAdsStrat = classifyOpenStrategy(
      {
        kind: 'existing_file',
        normalizedPath: 'C:\\Temp\\note.txt::$DATA',
      },
      {},
      'win32',
    );
    assert.equal(txtAdsStrat.strategy, 'executable_intercept');
    assert.equal(txtAdsStrat.reason, 'ntfs_ads_stream');

    // macOS POSIX filenames containing a colon (`12:30_notes.md`) must NOT be misclassified as NTFS ADS
    const macColonStrat = classifyOpenStrategy(
      {
        kind: 'existing_file',
        normalizedPath: '/Users/demo/12:30_notes.md',
      },
      {},
      'darwin',
    );
    assert.equal(macColonStrat.strategy, 'open_default');
    assert.equal(macColonStrat.ext, '.md');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Extended high-risk executable/disk-mount/script extensions in both DEFAULT & config.default.jsonc
  const cfg = loadConfig({ userConfigPath: null });
  const extendedExts = [
    '.url', '.chm', '.jar', '.appref-ms', '.application', '.msp', '.msix', '.msixbundle',
    '.appx', '.appxbundle', '.appinstaller', '.scf', '.inf', '.settingcontent-ms', '.xll',
    '.ws', '.wsc', '.psm1', '.psd1', '.iso', '.img', '.vhd', '.vhdx',
    '.library-ms', '.search-ms', '.diagcab', '.gadget', '.hlp',
  ];
  for (const ext of extendedExts) {
    assert.ok(cfg.executableExtensions.includes(ext), `config.default.jsonc missing ${ext}`);
    const defaultStrat = classifyOpenStrategy({
      kind: 'existing_file',
      normalizedPath: `C:\\Downloads\\payload${ext}`,
    });
    assert.equal(defaultStrat.strategy, 'executable_intercept', `Default policy missed ${ext}`);
    const cfgStrat = classifyOpenStrategy(
      { kind: 'existing_file', normalizedPath: `C:\\Downloads\\payload${ext}` },
      cfg,
    );
    assert.equal(cfgStrat.strategy, 'executable_intercept', `Config policy missed ${ext}`);
  }
});

test('P6: koffi/DLL binding failure clears cachedBindingsPromise, degrades to os-actions fallback, and recovers', async () => {
  resetWin32BindingsState();

  if (IS_WINDOWS) {
    // 1. Simulate koffi import failure in loadDefaultWin32Bindings
    await assert.rejects(
      () => loadDefaultWin32Bindings(async () => { throw new Error('Simulated koffi.node EBUSY'); }),
      /Simulated koffi\.node EBUSY/,
    );
    // CRITICAL P6 check: failed Promise must NOT remain cached!
    assert.equal(hasCachedWin32Bindings(), false);
  }

  // 2. Test Win32FfiAdapter automatic fallback & recovery
  let shouldFail = true;
  const fallbackCalls = [];
  const mockFallbackActions = {
    async copyTextToOsClipboard(text, opts) {
      fallbackCalls.push({ fn: 'copyTextToOsClipboard', text, opts });
    },
    async copyFileEntity(filePath, opts) {
      fallbackCalls.push({ fn: 'copyFileEntity', filePath, opts });
    },
    async revealInFolder(targetPath, opts) {
      fallbackCalls.push({ fn: 'revealInFolder', targetPath, opts });
      return { revealed: true };
    },
    async openDefault(targetPath, opts) {
      fallbackCalls.push({ fn: 'openDefault', targetPath, opts });
    },
  };

  const ffiCalls = [];
  const fakeBindings = {
    koffi: { encode: () => {} },
    OpenClipboard: () => true,
    CloseClipboard: () => true,
    EmptyClipboard: () => true,
    GlobalAlloc: () => 1n,
    GlobalLock: () => 2n,
    GlobalUnlock: () => true,
    GlobalFree: () => null,
    SetClipboardData: (_fmt, hMem) => {
      ffiCalls.push('SetClipboardData');
      return hMem;
    },
    GetLastError: () => 0,
  };

  const adapter = new Win32FfiAdapter({
    bindingsLoader: async () => {
      if (shouldFail) {
        throw new Error('koffi DLL load failed');
      }
      return fakeBindings;
    },
    fallbackActions: mockFallbackActions,
  });

  const degradedRes = await adapter.copyText('hello fallback');
  assert.equal(degradedRes.ok, true);
  assert.equal(degradedRes.degraded, true);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].text, 'hello fallback');

  const degradedStatus = await getPlatformStatus({ platform: 'win32', adapter });
  assert.deepEqual(degradedStatus, {
    mode: 'powershell_fallback',
    degradeReason: 'koffi DLL load failed',
  });

  // Now recover without recreating adapter
  shouldFail = false;
  const recoveredRes = await adapter.copyText('hello koffi');
  assert.deepEqual(recoveredRes, { ok: true, format: 'CF_UNICODETEXT' });
  assert.equal(ffiCalls.length, 1);

  const recoveredStatus = await getPlatformStatus({ platform: 'win32', adapter });
  assert.deepEqual(recoveredStatus, {
    mode: 'koffi_native',
    degradeReason: null,
  });

  const darwinStatus = await getPlatformStatus({ platform: 'darwin' });
  assert.deepEqual(darwinStatus, { mode: 'darwin_native', degradeReason: null });

  resetWin32BindingsState();
});

test('P6 real Windows koffi FFI clipboard round-trip (CF_UNICODETEXT & CF_HDROP) with clipboard restore', { skip: !IS_WINDOWS }, async () => {
  resetWin32BindingsState();
  const adapter = new Win32FfiAdapter();

  // Save prior clipboard content so we leave user's clipboard clean
  const prevText = await readClipboardText().catch(() => null);
  const prevDrop = await readClipboardFileDropList().catch(() => []);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v2-ffi-'));
  const tempFile = path.join(tempDir, '测试文件 🚀, demo.txt');
  fs.writeFileSync(tempFile, 'v2 native koffi test\n', 'utf8');

  try {
    const sampleText = 'C:\\工作区\\Context Menu Plus 🚀\\示例.ts:42';
    const textRes = await adapter.copyText(sampleText);
    assert.deepEqual(textRes, { ok: true, format: 'CF_UNICODETEXT' });
    assert.equal(await readClipboardText(), sampleText);

    const dropRes = await adapter.copyFileEntity(tempFile);
    assert.deepEqual(dropRes, { ok: true, format: 'CF_HDROP' });
    assert.deepEqual(await readClipboardFileDropList(), [tempFile]);

    const status = await getPlatformStatus({ platform: 'win32', adapter });
    assert.deepEqual(status, { mode: 'koffi_native', degradeReason: null });
  } finally {
    // Restore original clipboard content
    if (Array.isArray(prevDrop) && prevDrop.length > 0 && fs.existsSync(prevDrop[0])) {
      await adapter.copyFileEntity(prevDrop[0]).catch(() => {});
    } else if (typeof prevText === 'string') {
      await adapter.copyText(prevText).catch(() => {});
    } else {
      await adapter.copyText('').catch(() => {});
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
});
