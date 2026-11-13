import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildEditorLaunch,
  copyFileEntity,
  copyTextToOsClipboard,
  detectEditors,
  openDefault,
  openInTerminal,
  revealInFolder,
} from '../os-actions.mjs';

test('macOS (darwin) commands use /usr/bin/open, JXA ObjC NSPasteboard, and pbcopy', async () => {
  const calls = [];
  const mockExecFile = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { stdout: '', stderr: '' };
  };

  await openDefault('/Users/demo/docs/设计稿.pdf', {
    platform: 'darwin',
    existsFn: () => true,
    execFileFn: mockExecFile,
  });
  assert.deepEqual(calls.at(-1).file, '/usr/bin/open');
  assert.deepEqual(calls.at(-1).args, ['/Users/demo/docs/设计稿.pdf']);

  await revealInFolder('/Users/demo/docs/设计稿.pdf', {
    platform: 'darwin',
    exists: true,
    existsFn: () => true,
    execFileFn: mockExecFile,
  });
  assert.equal(calls.at(-1).file, '/usr/bin/open');
  assert.deepEqual(calls.at(-1).args, ['-R', '/Users/demo/docs/设计稿.pdf']);

  await copyFileEntity('/Users/demo/docs/设计稿.pdf', {
    platform: 'darwin',
    existsFn: () => true,
    execFileFn: mockExecFile,
  });
  const jxaCall = calls.at(-1);
  assert.equal(jxaCall.file, '/usr/bin/osascript');
  assert.equal(jxaCall.args[0], '-l');
  assert.equal(jxaCall.args[1], 'JavaScript');
  assert.equal(jxaCall.args[2], '-e');
  assert.match(jxaCall.args[3], /ObjC\.import\("AppKit"\)/);
  assert.match(jxaCall.args[3], /NSPasteboard\.generalPasteboard/);
  assert.equal(jxaCall.args[4], '/Users/demo/docs/设计稿.pdf');

  await openInTerminal({
    dirPath: '/Users/demo/docs',
    terminalId: 'iterm',
    platform: 'darwin',
    home: '/Users/demo',
    existsFn: (p) => p === '/Users/demo/docs' || p === '/Applications/iTerm.app',
    execFileFn: mockExecFile,
  });
  assert.equal(calls.at(-1).file, '/usr/bin/open');
  assert.deepEqual(calls.at(-1).args, ['-a', 'iTerm', '/Users/demo/docs']);
});

test('Windows (win32) editor detection resolves .exe directly with --goto line jumps', () => {
  const editors = detectEditors({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    existsFn: (p) =>
      p === 'C:\\Users\\demo\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' ||
      p === 'C:\\Users\\demo\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
    bypassCache: true,
  });

  assert.equal(editors.length, 2);
  const launch = buildEditorLaunch({
    targetPath: 'C:\\proj\\main.ts',
    line: 42,
    col: 7,
    editorId: 'vscode',
    editors,
  });
  assert.equal(launch.executable, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
  assert.deepEqual(launch.args, ['--goto', 'C:\\proj\\main.ts:42:7']);
});

test('Windows live STA clipboard roundtrip copies real UTF-8 Chinese file entity and text', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-clip-'));
  const filePath = path.join(dir, '测试文档 🚀.txt');
  writeFileSync(filePath, 'hello antigravity', 'utf8');

  try {
    await copyFileEntity(filePath, { platform: 'win32' });
    const dropped = execFileSync(
      'powershell.exe',
      [
        '-Sta',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }',
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    assert.equal(dropped, filePath);

    const sampleText = 'C:\\工作区\\中文路径\\demo.ts:42';
    await copyTextToOsClipboard(sampleText, { platform: 'win32' });
    const pastedText = execFileSync(
      'powershell.exe',
      [
        '-Sta',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [System.Windows.Forms.Clipboard]::GetText()',
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    assert.equal(pastedText, sampleText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
