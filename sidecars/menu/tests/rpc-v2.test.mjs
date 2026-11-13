import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../../src/index.mjs';
import { installPlugin, parseInstallArgs } from '../../../scripts/install.mjs';
import { computeContainingDirPath, createSidecarRpcHandler, queryAgentConversationMetadata } from '../main.mjs';
import { PreferencesStore } from '../preferences.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function createMockAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      async openDefault(targetPath) {
        calls.push({ method: 'openDefault', targetPath });
        return { method: 'mock_openDefault', targetPath };
      },
      async openInEditor(params) {
        calls.push({ method: 'openInEditor', ...params });
        return { method: 'mock_openInEditor', ...params };
      },
      async revealInFolder(targetPath) {
        calls.push({ method: 'revealInFolder', targetPath });
        return { method: 'mock_revealInFolder', targetPath };
      },
      async openDirectory(dirPath) {
        calls.push({ method: 'openDirectory', dirPath });
        return { method: 'mock_openDirectory', dirPath };
      },
      async copyFileEntity(targetPath) {
        calls.push({ method: 'copyFileEntity', targetPath });
        return { method: 'mock_copyFileEntity', targetPath };
      },
      async copyText(text) {
        calls.push({ method: 'copyText', text });
        return { method: 'mock_copyText', text };
      },
    },
  };
}

function createTestHarness(tempDir, { workspaceRoots = [], platform = 'win32', asyncStatImpl } = {}) {
  const prefs = new PreferencesStore(path.join(tempDir, 'preferences.json'));
  const baseConfig = loadConfig();
  const rootResolver = {
    async getRoots() {
      return workspaceRoots;
    },
  };
  const { calls, adapter } = createMockAdapter();
  const recorded = [];

  const handleRpc = createSidecarRpcHandler({
    paths: {
      platform,
      home: tempDir,
    },
    preferences: prefs,
    rootResolver,
    baseConfig,
    platformAdapter: adapter,
    detectEditorsFn: () => [{ id: 'vscode', label: 'VS Code', style: 'goto', executable: 'C:\\Tools\\Code.exe' }],
    detectTerminalsFn: () => [{ id: 'wt', label: 'Windows Terminal', executable: 'wt.exe' }],
    openInTerminalFn: async (opts) => {
      calls.push({ method: 'openInTerminal', ...opts });
      return { launched: 'Windows Terminal' };
    },
    asyncStatImpl,
    onActionRecorded: (entry) => recorded.push(entry),
  });

  return { prefs, handleRpc, calls, recorded };
}

test('P5: queryAgentConversationMetadata executes asynchronously with timeout and handles errors', async () => {
  const noEnv = await queryAgentConversationMetadata('11111111-1111-1111-1111-111111111111', { env: {} });
  assert.equal(noEnv, null);

  let seenOpts = null;
  const okMeta = await queryAgentConversationMetadata('11111111-1111-1111-1111-111111111111', {
    env: { ANTIGRAVITY_AGENTAPI_EXE: 'C:\\app\\Antigravity.exe' },
    execFileFn: async (file, args, opts) => {
      seenOpts = { file, args, opts };
      await new Promise((r) => setTimeout(r, 5));
      return { stdout: JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: 'proj-1' } } } }) };
    },
  });
  assert.equal(seenOpts.file, 'C:\\app\\Antigravity.exe');
  assert.deepEqual(seenOpts.args, ['agentapi', 'get-conversation-metadata', '11111111-1111-1111-1111-111111111111']);
  assert.equal(seenOpts.opts.timeout, 2000);
  assert.equal(seenOpts.opts.windowsHide, true);
  assert.equal(okMeta.response.conversationMetadata.metadata.projectId, 'proj-1');

  const failedMeta = await queryAgentConversationMetadata('11111111-1111-1111-1111-111111111111', {
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999' },
    execFileFn: async () => {
      throw new Error('ETIMEDOUT');
    },
  });
  assert.equal(failedMeta, null);
});

test('Bidirectional resolve-target returns v2 menu + v1 fields, respects preferences, and blocks P3/P4 edges', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agy-rpc-v2-'));
  try {
    const wsRoot = path.join(tempDir, 'repo');
    const srcDir = path.join(wsRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    const tsFile = path.join(srcDir, 'app.ts');
    writeFileSync(tsFile, 'export const x = 1;\n', 'utf8');

    const { prefs, handleRpc } = createTestHarness(tempDir, {
      workspaceRoots: [wsRoot],
      platform: process.platform,
    });

    // 1. Existing .ts file with line anchor
    const resTs = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: '`src/app.ts:42`' }],
    });
    assert.equal(resTs.ok, true);
    assert.ok(typeof resTs.resolutionId === 'string' && resTs.resolutionId.length > 10);
    assert.equal(resTs.target.kind, 'existing_file');
    assert.equal(resTs.target.line, 42);
    assert.equal(resTs.menu.intercept, true);
    assert.equal(resTs.menu.items.length, 4);
    assert.deepEqual(
      resTs.menu.items.map((i) => i.id),
      ['open_file', 'reveal_in_folder', 'copy_file_entity', 'copy_path'],
    );
    // v1 compatibility fields
    assert.equal(resTs.matched, true);
    assert.equal(resTs.exists, true);
    assert.equal(resTs.isDirectory, false);
    assert.equal(resTs.targetPath, tsFile);
    assert.equal(resTs.containingDir, srcDir);
    assert.equal(resTs.line, 42);
    assert.equal(resTs.relativePath, path.join('src', 'app.ts'));
    assert.ok(resTs.fileUrl.startsWith('file://'));

    // Edge cases for computeContainingDirPath (drive root vs subdirectory vs root itself)
    assert.equal(computeContainingDirPath('C:\\test.txt', 'win32'), 'C:\\');
    assert.equal(computeContainingDirPath('C:\\', 'win32'), null);
    assert.equal(computeContainingDirPath('C:\\repo\\scripts\\install.mjs', 'win32'), 'C:\\repo\\scripts');
    assert.equal(computeContainingDirPath('/etc/hosts', 'darwin'), '/etc');
    assert.equal(computeContainingDirPath('/hosts', 'darwin'), '/');
    assert.equal(computeContainingDirPath('/', 'darwin'), null);

    // Server-side copy-parent-path action copies containingDir cleanly
    const copyParentRes = await handleRpc('execute-action', {
      action: 'copy-parent-path',
      targetPath: tsFile,
    });
    assert.equal(copyParentRes.ok, true);
    assert.equal(copyParentRes.text, srcDir);

    // 2. Preferences toggles extend minimal menu + switch language
    await prefs.set({
      language: 'en',
      minimalMenuShowHeader: true,
      minimalMenuShowTerminal: true,
      minimalMenuShowMention: true,
    });
    const resExt = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: '`src/app.ts`' }],
    });
    assert.deepEqual(
      resExt.menu.items.map((i) => i.id),
      ['header', 'open_file', 'reveal_in_folder', 'copy_file_entity', 'copy_path', 'open_terminal', 'mention_target'],
    );
    assert.equal(resExt.menu.items[1].label, 'Open');

    // 3. Existing directory (via relative slash path or absolute path)
    const resDir = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: 'src/' }],
    });
    assert.equal(resDir.target.kind, 'existing_directory');
    assert.equal(resDir.isDirectory, true);
    assert.equal(resDir.containingDir, null);
    assert.equal(resDir.exists, true);
    assert.equal(resDir.menu.items.length, 5); // with showHeader + showTerminal + showMention still enabled on prefs

    // 4. Missing file inside repo
    const missingFile = path.join(srcDir, 'ghost', 'lost.txt');
    const resMissing = await handleRpc('resolve-target', {
      candidates: [{ source: 'explicit-uri', value: 'file:///' + missingFile.replace(/\\/g, '/').replace(/^\/+/, '') }],
    });
    assert.equal(resMissing.target.kind, 'missing_path');
    assert.equal(resMissing.matched, true);
    assert.equal(resMissing.exists, false);
    assert.equal(resMissing.nearestExistingDir, srcDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('P3 + P4: untrusted UNC (GLOBALROOT/@SSL/mixed slash) triggers 0 stats & safe v1 fields; empty roots never match cwd', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agy-rpc-sec-'));
  try {
    let statCalls = 0;
    const countingStat = async (p) => {
      statCalls++;
      throw new Error(`Unexpected stat on ${p}`);
    };

    const { handleRpc } = createTestHarness(tempDir, {
      workspaceRoots: [],
      platform: 'win32',
      asyncStatImpl: countingStat,
    });

    const uncPayloads = [
      '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\share\\a.txt',
      '\\\\?\\UNC\\evil\\share\\a.txt',
      '\\\\evil@SSL\\DavWWWRoot\\a.txt',
      '\\/evil/share/a.txt',
    ];

    for (const payload of uncPayloads) {
      const res = await handleRpc('resolve-target', {
        candidates: [{ source: 'explicit-uri', value: payload }],
      });
      assert.equal(res.target.kind, 'untrusted_unc', `Expected untrusted_unc for ${payload}`);
      assert.equal(res.matched, true);
      assert.equal(res.exists, false);
      assert.equal(res.isUntrustedUnc, true);
      assert.equal(res.nearestExistingDir, null);
      assert.equal(res.fileUrl, '');
    }
    assert.equal(statCalls, 0, 'Pre-stat UNC interception must perform zero stat calls');

    // P4: without workspace roots, `main.mjs` must NOT match sidecars/menu/main.mjs
    const noRootRes = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: '`main.mjs`' }],
    });
    assert.equal(noRootRes.target.kind, 'inline_code_text');
    assert.equal(noRootRes.matched, false);
    assert.equal(noRootRes.menu.items.length, 1);
    assert.equal(noRootRes.menu.items[0].id, 'copy_text');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('P8: 3-tier routing, spoof resistance, one-time resolutionId confirmation & burn-after-use', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agy-rpc-p8-'));
  try {
    const wsRoot = path.join(tempDir, 'repo');
    mkdirSync(wsRoot, { recursive: true });
    const tsFile = path.join(wsRoot, 'demo.ts');
    const mdFile = path.join(wsRoot, 'notes.md');
    const vbsFile = path.join(wsRoot, 'danger.vbs');
    writeFileSync(tsFile, 'console.log(1);\n', 'utf8');
    writeFileSync(mdFile, '# Notes\n', 'utf8');
    writeFileSync(vbsFile, 'MsgBox "hi"\n', 'utf8');

    const { handleRpc, calls } = createTestHarness(tempDir, {
      workspaceRoots: [wsRoot],
      platform: process.platform,
    });

    // 1. v1 open-default on .ts routes to openInEditor (never openDefault), even if client spoofs ext/isDirectory
    const v1Ts = await handleRpc('execute-action', {
      action: 'open-default',
      targetPath: tsFile,
      ext: '.pdf',
      isDirectory: true,
    });
    assert.equal(v1Ts.ok, true);
    assert.equal(calls.at(-1).method, 'openInEditor');

    // 2. .md without line -> openDefault; .md with #L10 -> openInEditor
    const mdNoLine = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: 'notes.md' }],
    });
    const execMdNoLine = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: mdNoLine.resolutionId,
    });
    assert.equal(execMdNoLine.ok, true);
    assert.equal(calls.at(-1).method, 'openDefault');

    // Replaying consumed resolutionId fails
    const replayMd = await handleRpc('execute-action', {
      actionId: 'copy_path',
      resolutionId: mdNoLine.resolutionId,
    });
    assert.equal(replayMd.ok, false);
    assert.equal(replayMd.reason, 'invalid_or_expired_resolution');

    const mdWithLine = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: 'notes.md#L10' }],
    });
    const execMdLine = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: mdWithLine.resolutionId,
    });
    assert.equal(execMdLine.ok, true);
    assert.equal(calls.at(-1).method, 'openInEditor');
    assert.equal(calls.at(-1).line, 10);

    // 3. Executable .vbs blocked in both v1 and v2 without confirmation
    const v1Vbs = await handleRpc('execute-action', {
      action: 'open-default',
      targetPath: vbsFile,
      ext: '.txt', // spoof attempt
    });
    assert.equal(v1Vbs.ok, false);
    assert.equal(v1Vbs.status, 'confirmation_required');
    assert.equal(v1Vbs.reason, 'executable_extension');
    assert.ok(v1Vbs.error);

    // Cannot confirm without resolutionId
    const spoofConfirm = await handleRpc('execute-action', {
      actionId: 'open_file',
      targetPath: vbsFile,
      confirmed: true,
      expectedTargetPath: vbsFile,
    });
    assert.equal(spoofConfirm.ok, false);
    assert.equal(spoofConfirm.reason, 'confirmation_token_required');

    // v2 confirmation flow: mismatch expectedTargetPath rejects & burns token
    const vbsRes1 = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: 'danger.vbs' }],
    });
    const block1 = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes1.resolutionId,
      confirmed: false,
    });
    assert.equal(block1.status, 'confirmation_required');

    const mismatch = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes1.resolutionId,
      confirmed: true,
      expectedTargetPath: mdFile,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'target_mismatch');

    // Token is burned after mismatch
    const replayAfterMismatch = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes1.resolutionId,
      confirmed: true,
      expectedTargetPath: vbsFile,
    });
    assert.equal(replayAfterMismatch.ok, false);
    assert.equal(replayAfterMismatch.reason, 'invalid_or_expired_resolution');

    // Valid v2 confirmation succeeds once and burns token
    const vbsRes2 = await handleRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: 'danger.vbs' }],
    });
    const block2 = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes2.resolutionId,
    });
    assert.equal(block2.status, 'confirmation_required');

    const confirmedOk = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes2.resolutionId,
      confirmed: true,
      expectedTargetPath: block2.targetPath,
    });
    assert.equal(confirmedOk.ok, true);
    assert.equal(calls.at(-1).method, 'openDefault');
    assert.equal(calls.at(-1).targetPath, vbsFile);

    const replayAfterOk = await handleRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: vbsRes2.resolutionId,
      confirmed: true,
      expectedTargetPath: vbsFile,
    });
    assert.equal(replayAfterOk.ok, false);
    assert.equal(replayAfterOk.reason, 'invalid_or_expired_resolution');

    // 4. Reveal & copy actions
    await handleRpc('execute-action', { action: 'reveal', targetPath: tsFile });
    assert.equal(calls.at(-1).method, 'revealInFolder');
    await handleRpc('execute-action', { action: 'copy-file', targetPath: tsFile });
    assert.equal(calls.at(-1).method, 'copyFileEntity');
    await handleRpc('execute-action', { action: 'copy-text', text: 'hello' });
    assert.equal(calls.at(-1).method, 'copyText');
    assert.equal(calls.at(-1).text, 'hello');

    // 5. Untrusted UNC confirmation & rejection of reveal/terminal (explicit win32 harness so macOS/Linux also test Win32 UNC policy)
    const { handleRpc: win32Rpc, calls: win32Calls } = createTestHarness(tempDir, {
      workspaceRoots: [],
      platform: 'win32',
    });
    const uncPath = '\\\\?\\GLOBALROOT\\Device\\Mup\\evil\\share\\payload.txt';
    const uncRes = await win32Rpc('resolve-target', {
      candidates: [{ source: 'explicit-uri', value: uncPath }],
    });
    assert.equal(uncRes.target.kind, 'untrusted_unc');

    const uncBlocked = await win32Rpc('execute-action', {
      actionId: 'open_untrusted_unc',
      resolutionId: uncRes.resolutionId,
    });
    assert.equal(uncBlocked.ok, false);
    assert.equal(uncBlocked.status, 'confirmation_required');
    assert.equal(uncBlocked.reason, 'untrusted_unc_path');

    const uncTerminalRejected = await win32Rpc('execute-action', {
      action: 'open-terminal',
      targetPath: uncPath,
    });
    assert.equal(uncTerminalRejected.ok, false);
    assert.equal(uncTerminalRejected.reason, 'untrusted_unc_rejected');

    const uncConfirmed = await win32Rpc('execute-action', {
      actionId: 'open_untrusted_unc',
      resolutionId: uncRes.resolutionId,
      confirmed: true,
      expectedTargetPath: uncBlocked.targetPath,
    });
    assert.equal(uncConfirmed.ok, true);
    assert.equal(win32Calls.at(-1).method, 'openDefault');
    assert.equal(win32Calls.at(-1).targetPath, uncBlocked.targetPath);

    // 5b. Cross-platform darwin simulation (ensures macOS POSIX paths & colons work identically regardless of host OS)
    const { handleRpc: darwinRpc, calls: darwinCalls } = createTestHarness(tempDir, {
      workspaceRoots: ['/Users/demo/project'],
      platform: 'darwin',
      asyncStatImpl: async (p) => {
        if (p === '/Users/demo/project/src/main.ts' || p === '/Users/demo/project/docs/12:30_notes.md') {
          return {
            isFile: () => true,
            isDirectory: () => false,
            size: 64,
            mtimeMs: 1700000000000,
          };
        }
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });
    const macTs = await darwinRpc('resolve-target', {
      candidates: [{ source: 'inline-code', value: '`src/main.ts:18`' }],
    });
    assert.equal(macTs.target.kind, 'existing_file');
    assert.equal(macTs.containingDir, '/Users/demo/project/src');
    await darwinRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: macTs.resolutionId,
    });
    assert.equal(darwinCalls.at(-1).method, 'openInEditor');

    const macColonMd = await darwinRpc('resolve-target', {
      candidates: [{ source: 'explicit-uri', value: 'file:///Users/demo/project/docs/12%3A30_notes.md' }],
    });
    assert.equal(macColonMd.target.kind, 'existing_file');
    const macColonOpen = await darwinRpc('execute-action', {
      actionId: 'open_file',
      resolutionId: macColonMd.resolutionId,
    });
    assert.equal(macColonOpen.ok, true);
    assert.equal(darwinCalls.at(-1).method, 'openDefault');

    // 6. Resolution cache bounded to 64 entries (oldest evicted)
    const ids = [];
    for (let i = 0; i < 66; i++) {
      const r = await handleRpc('resolve-target', {
        candidates: [{ source: 'inline-code', value: 'notes.md' }],
      });
      ids.push(r.resolutionId);
    }
    const evicted = await handleRpc('execute-action', {
      actionId: 'copy_path',
      resolutionId: ids[0],
    });
    assert.equal(evicted.ok, false);
    assert.equal(evicted.reason, 'invalid_or_expired_resolution');
    const kept = await handleRpc('execute-action', {
      actionId: 'copy_path',
      resolutionId: ids.at(-1),
    });
    assert.equal(kept.ok, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function snapshotTreeHashes(rootDir) {
  const hashes = new Map();
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, fullPath);
        const digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
        hashes.set(rel, digest);
      }
    }
  }
  return hashes;
}

test('P1: install.mjs parses args, rolls back on mid-swap failure, and aborts cleanly under real Windows koffi.node lock', async () => {
  const parsed = parseInstallArgs(['--target', './tmp-out', '--check-only']);
  assert.equal(parsed.checkOnly, true);
  assert.ok(parsed.targetDir.endsWith('tmp-out'));

  const parentTmp = mkdtempSync(path.join(tmpdir(), 'agy-install-test-'));
  const tmpDest = path.join(parentTmp, 'plugin-target');
  let holder = null;

  try {
    // 1. Fresh install to temporary directory
    const res = await installPlugin({ targetDir: tmpDest });
    assert.equal(res.ok, true);
    assert.ok(existsSync(path.join(tmpDest, 'plugin.json')));
    assert.ok(existsSync(path.join(tmpDest, 'config.default.jsonc')));
    assert.ok(existsSync(path.join(tmpDest, 'package.json')));
    assert.ok(existsSync(path.join(tmpDest, 'src', 'index.mjs')));
    assert.ok(existsSync(path.join(tmpDest, 'sidecars', 'menu', 'main.mjs')));
    assert.equal(existsSync(path.join(tmpDest, 'sidecars', 'menu', 'tests')), false);
    assert.equal(existsSync(path.join(tmpDest, 'sidecars', 'menu', 'package.json')), false);
    assert.ok(existsSync(path.join(tmpDest, 'node_modules', 'koffi')));

    // 2. Unit-level EBUSY openFn rejection & mid-swap rollback integrity check
    const beforeRollback = snapshotTreeHashes(tmpDest);
    await assert.rejects(
      () =>
        installPlugin({
          targetDir: tmpDest,
          openFn: () => {
            const err = new Error('resource busy or locked');
            err.code = 'EBUSY';
            throw err;
          },
        }),
      (err) => err.code === 'NATIVE_BINARY_LOCKED' && /Customizations/.test(err.message),
    );
    assert.deepEqual(snapshotTreeHashes(tmpDest), beforeRollback);

    const { renameSync: realRenameSync } = await import('node:fs');
    await assert.rejects(
      () =>
        installPlugin({
          targetDir: tmpDest,
          baseDelayMs: 1,
          maxRetries: 1,
          renameFn: (src, dst) => {
            if (src.endsWith(`${path.sep}node_modules`) && !src.includes('.staging-')) {
              const err = new Error('simulated swap failure');
              err.code = 'EPERM';
              throw err;
            }
            return realRenameSync(src, dst);
          },
        }),
      (err) => err.code === 'EPERM',
    );
    assert.deepEqual(snapshotTreeHashes(tmpDest), beforeRollback);
    const parentLeftoversAfterRollback = readdirSync(parentTmp).filter(
      (n) => n.includes('.staging-') || n.includes('.bak-'),
    );
    assert.deepEqual(parentLeftoversAfterRollback, []);

    // 3. Real process lock regression (Windows): child process loads koffi.node from tmpDest
    if (process.platform === 'win32') {
      const koffiEntryUrl = pathToFileURL(path.join(tmpDest, 'node_modules', 'koffi', 'index.js')).href;
      holder = spawn(
        process.execPath,
        [
          '-e',
          `import(${JSON.stringify(koffiEntryUrl)}).then((m) => { const k = m.default || m; k.load('user32.dll'); process.stdout.write('LOADED\\n'); setInterval(() => {}, 1000); }).catch((e) => { process.stderr.write(String(e)); process.exit(2); });`,
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('Timed out waiting for koffi holder child')), 8000);
        let out = '';
        let err = '';
        holder.stdout.on('data', (chunk) => {
          out += String(chunk);
          if (out.includes('LOADED')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        holder.stderr.on('data', (chunk) => {
          err += String(chunk);
        });
        holder.once('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`Holder exited early (${code}): ${err}`));
        });
      });

      const beforeLocked = snapshotTreeHashes(tmpDest);
      const installScript = path.join(REPO_ROOT, 'scripts', 'install.mjs');
      const cliRes = spawnSync(
        process.execPath,
        [installScript, '--target', tmpDest],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
        },
      );

      assert.equal(cliRes.status, 1, `Expected exit 1 under real lock, got ${cliRes.status}; stdout=${cliRes.stdout}`);
      assert.match(cliRes.stderr, /Customizations/);
      assert.deepEqual(snapshotTreeHashes(tmpDest), beforeLocked, 'Locked target files/hashes must remain 100% unchanged');

      const parentLeftovers = readdirSync(parentTmp).filter(
        (n) => n.includes('.staging-') || n.includes('.bak-') || n.endsWith('.lockcheck'),
      );
      assert.deepEqual(parentLeftovers, []);

      // Ensure no .lockcheck leftovers inside node_modules
      const nmStack = [path.join(tmpDest, 'node_modules')];
      const lockchecks = [];
      while (nmStack.length > 0) {
        const cur = nmStack.pop();
        for (const entry of readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, entry.name);
          if (entry.isDirectory()) nmStack.push(p);
          else if (entry.name.endsWith('.lockcheck')) lockchecks.push(p);
        }
      }
      assert.deepEqual(lockchecks, []);
    }
  } finally {
    if (holder && holder.exitCode === null) {
      holder.kill();
      await new Promise((resolveExit) => {
        holder.once('exit', resolveExit);
        setTimeout(resolveExit, 1500);
      });
    }
    rmSync(parentTmp, { recursive: true, force: true });
  }
});
