import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseRawCandidate, resolveBestTarget } from '../path-resolver.mjs';

test('parseRawCandidate handles Windows file:// URIs, encoded drive, Chinese & Emoji, and #L ranges', () => {
  const winBasic = parseRawCandidate('file:///C:/Users/demo/notes.md#L42-L58', {
    platform: 'win32',
    homeDir: 'C:\\Users\\demo',
  });
  assert.equal(winBasic.path, 'C:\\Users\\demo\\notes.md');
  assert.equal(winBasic.isAbsolute, true);
  assert.equal(winBasic.isExplicitUri, true);
  assert.equal(winBasic.line, 42);
  assert.equal(winBasic.endLine, 58);

  const winEncodedDrive = parseRawCandidate('file:///d%3A/GIT/project/main.ts#L10C3', {
    platform: 'win32',
    homeDir: 'C:\\Users\\demo',
  });
  assert.equal(winEncodedDrive.path, 'd:\\GIT\\project\\main.ts');
  assert.equal(winEncodedDrive.line, 10);
  assert.equal(winEncodedDrive.col, 3);

  const winUnicode = parseRawCandidate('file:///C:/Users/demo/%E6%B5%8B%E8%AF%95%20%F0%9F%9A%80.docx', {
    platform: 'win32',
    homeDir: 'C:\\Users\\demo',
  });
  assert.equal(winUnicode.path, 'C:\\Users\\demo\\测试 🚀.docx');
});

test('parseRawCandidate handles colon line/col suffixes without breaking Windows drive letters', () => {
  const winColon = parseRawCandidate('C:\\Users\\demo\\app.ts:42:10', {
    platform: 'win32',
    homeDir: 'C:\\Users\\demo',
  });
  assert.equal(winColon.path, 'C:\\Users\\demo\\app.ts');
  assert.equal(winColon.line, 42);
  assert.equal(winColon.col, 10);

  const stackParen = parseRawCandidate('src/Service.cs(88,12)', {
    platform: 'win32',
    homeDir: 'C:\\Users\\demo',
  });
  assert.equal(stackParen.path, 'src\\Service.cs');
  assert.equal(stackParen.line, 88);
  assert.equal(stackParen.col, 12);
});

test('parseRawCandidate handles macOS file:// URIs and ~/ tilde expansion', () => {
  const macFile = parseRawCandidate('file:///Users/demo/proj/app.ts#L12', {
    platform: 'darwin',
    homeDir: '/Users/demo',
  });
  assert.equal(macFile.path, '/Users/demo/proj/app.ts');
  assert.equal(macFile.isAbsolute, true);
  assert.equal(macFile.line, 12);

  const macTilde = parseRawCandidate('~/Desktop/report.pdf', {
    platform: 'darwin',
    homeDir: '/Users/demo',
  });
  assert.equal(macTilde.path, '/Users/demo/Desktop/report.pdf');
  assert.equal(macTilde.isAbsolute, true);
});

test('resolveBestTarget resolves workspace-relative inline code and missing file nearestExistingDir', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'agy-ctx-path-'));
  try {
    const srcDir = path.join(tempRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    const indexFile = path.join(srcDir, 'index.ts');
    writeFileSync(indexFile, 'export const ok = true;\n', 'utf8');

    const relMatch = await resolveBestTarget({
      candidates: [{ source: 'inline-code', value: '`src/index.ts:15`' }],
      workspaceRoots: [tempRoot],
      platform: process.platform,
    });
    assert.equal(relMatch.matched, true);
    assert.equal(relMatch.exists, true);
    assert.equal(relMatch.targetPath, indexFile);
    assert.equal(relMatch.line, 15);
    assert.equal(relMatch.relativePath, path.join('src', 'index.ts'));

    const missingPath = path.join(srcDir, 'deleted', 'ghost.txt');
    const missingUrl = 'file:///' + missingPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const missingMatch = await resolveBestTarget({
      candidates: [{ source: 'explicit-uri', value: missingUrl }],
      workspaceRoots: [tempRoot],
      platform: process.platform,
    });
    assert.equal(missingMatch.matched, true);
    assert.equal(missingMatch.exists, false);
    assert.equal(missingMatch.nearestExistingDir, srcDir);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
