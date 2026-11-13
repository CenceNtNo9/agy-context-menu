# Context Menu Plus (`agy-context-menu` v2.0)

Cross-platform (**Windows & macOS**) right-click file enhancement plugin for **Antigravity Desktop (2.0)** chat canvases, powered by a `<1ms` native Win32 FFI engine (`koffi`) and 3-tier security routing.

## What's New in v2.0

- **Zero-PowerShell Native Win32 FFI (`<1ms`)**:
  - Uses `koffi` (`shell32.dll`, `user32.dll`, `kernel32.dll`) directly inside the Sidecar process for `SHOpenFolderAndSelectItems`, `ShellExecuteW`, `CF_HDROP` file entity copy, and `CF_UNICODETEXT` copy — eliminating slow `powershell.exe` child spawns.
  - Automatically falls back to `os-actions.mjs` if a native binary is unavailable, and surfaces active/degraded status in the Aux Pane settings panel.
  - macOS continues to use `/usr/bin/open -R`, JXA `NSPasteboard`, and `pbcopy`.
- **3-Tier Smart Open & Security Policy**:
  - **Tier 1 (Executable / Untrusted UNC Interception)**: High-risk extensions (`.exe`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.reg`, `.dmg`, etc.) and external UNC paths (`\\server\share`, `\\?\GLOBALROOT\Device\Mup\...`, WebDAV `@SSL`) are blocked before any `stat` or execution, requiring explicit confirmation with one-time `resolutionId` replay protection.
  - **Tier 2 (Code Editor Routing)**: Source code extensions (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.json`, etc.) and line-anchored links (`#L42`, `:42:10`, `file.cs(42,10)`) automatically open in your configured code editor (`VS Code`, `Cursor`, `Windsurf`, `Zed`, `Sublime Text`, `Notepad++`, or plain-text viewer fallback) — never via WScript or media players.
  - **Tier 3 (Default App)**: Documents, images, PDFs, and non-line-anchored Markdown/HTML open with the OS default handler.
- **Non-Blocking Async Workspace Resolution**:
  - Asynchronous `stat` and `agentapi` metadata lookup with timeout guards prevent offline mapped drives or sleeping WSL shares from stalling the Sidecar event loop.
  - Strictly avoids falling back to `process.cwd()` when no conversation workspace root exists.
- **5-State Minimal Menu Engine (`4 / 2 / 2 / 1`)**:
  - Supports concise context menus tailored to `existing_file`, `existing_directory`, `missing_path`, `untrusted_unc`, and `inline_code_text`, with optional panel toggles for file header, terminal, and composer mention.
  - Full backwards compatibility with v1 `renderer-client.cjs`, plus a ready-to-review Stage 2 renderer upgrade guide in [docs/STAGE2_RENDERER_UPGRADE.md](docs/STAGE2_RENDERER_UPGRADE.md).

- **Copy Containing Folder Path (`复制所在文件夹路径`)**:
  - Adds `Copy Containing Folder Path` as the top entry in `Copy More Formats ▸` for file targets (preserving drive root slashes like `C:\` on Windows), while automatically adapting directory targets to `Copy Folder Path`.

## Safe Installation & Deployment

### Prerequisites

Install dependencies in the source repository (never directly inside the live running plugin folder):

```bash
npm install
```

### Safe Deploy Script (`scripts/install.mjs`)

Because Windows locks loaded `.node` native addons (such as `koffi.node`) while a Sidecar process is alive, `scripts/install.mjs` performs a real `openSync('r+')` write-handle lock pre-check and stages assets in `os.tmpdir()` with transactional rollback:

1. **Full Install / Native Dependency Update**:
   - Disable **Context Menu Plus** in Antigravity's **Customizations** panel so the Sidecar exits and releases `koffi.node`.
   - Optionally pre-check locks without modifying files:
     ```bash
     node scripts/install.mjs --check-only
     ```
   - Deploy to `~/.gemini/config/plugins/agy-context-menu` (or pass `--target <dir>`):
     ```bash
     node scripts/install.mjs
     ```
   - Re-enable **Context Menu Plus** in **Customizations**.
2. **Code-Only Hot Sync (when `koffi.node` SHA-256 is unchanged)**:
   ```bash
   node scripts/install.mjs --code-only
   ```
   Then toggle **Context Menu Plus** OFF → ON once in **Customizations** to reload the Sidecar.

For upgrading the injected chat UI script to v2 minimal menus and non-blocking confirmation cards, see [docs/STAGE2_RENDERER_UPGRADE.md](docs/STAGE2_RENDERER_UPGRADE.md).

## Testing

Run all engine and sidecar tests under standard Node.js:

```bash
npm test
```

Or run Sidecar RPC/installer tests only:

```bash
node --test sidecars/menu/tests/*.test.mjs
```

On Windows with Antigravity installed, you can also verify `koffi` under the host Electron `RunAsNode` runtime:

```powershell
& "$env:APPDATA\Antigravity\bin\agy-node.cmd" --test tests/*.test.mjs sidecars/menu/tests/*.test.mjs
```

## License

[MIT](LICENSE)
