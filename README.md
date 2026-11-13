# Context Menu Plus (`agy-context-menu`)

Cross-platform (**Windows & macOS**) right-click file enhancement plugin for **Antigravity Desktop (2.0)** chat canvases.

## Features

- **Reveal in Explorer / Finder** (`在资源管理器中显示` / `在“访达”中显示`):
  - Uses Antigravity's native `revealInFilePicker` or Win32 `SHOpenFolderAndSelectItems` (reuses already-open Explorer windows) / macOS `open -R`.
  - Automatically falls back to opening the nearest existing parent directory if a referenced file was deleted or moved.
- **Open with Default App** (`打开文件（默认方式）`): Opens documents, images, videos, and scripts with your OS default handler.
- **Open in Code Editor at Line** (`在 VS Code / Cursor / Windsurf / Zed / Sublime Text 中打开`): Preserves `#L42-L58` / `:42:10` line & column anchors.
- **Open in Terminal Here** (`在此处打开终端`): Launches Windows Terminal / PowerShell on Windows, or Terminal / iTerm2 / Ghostty / Warp on macOS.
- **Copy File (Entity) vs Copy File Path** (`复制文件` 与 `复制文件路径`):
  - **Copy File**: Writes the actual file object (`CF_HDROP` via STA PowerShell on Windows; `NSPasteboard` + `NSURL` via JXA on macOS) so you can paste (`Ctrl+V` / `Cmd+V`) directly into WeChat, Feishu, Slack, Explorer, or Finder.
  - **Copy File Path**: Writes clean native paths (`C:\...` or `/Users/...`) with additional formats (`Relative Path`, `Path:Line`, `File Name`, `Display Text`) in a submenu.
- **Smart Non-Link Path & Inline Code Support**:
  - Recognizes `file://` links, React file chips, media previews, inline `` `src/foo.ts:42` `` tokens, and stack traces against active conversation workspace roots.
  - Fixes grayed-out Copy on inline code spans by providing a working `Copy Text` menu.
- **Quick Modifiers**:
  - `Alt + Click` (`Option + Click` on macOS): Open file with default app.
  - `Ctrl + Alt + Click` (`Cmd + Option + Click` on macOS): Reveal in Explorer / Finder.
  - `Shift + Right-Click`: Bypass directly to default menu.

## Installation (Windows & macOS)

### Option A — Direct Git Clone (Recommended)

- **macOS (Terminal)**:
  ```bash
  git clone https://github.com/CenceNtNo9/agy-context-menu.git ~/.gemini/config/plugins/agy-context-menu
  ```
- **Windows (PowerShell)**:
  ```powershell
  git clone https://github.com/CenceNtNo9/agy-context-menu.git "$HOME\.gemini\config\plugins\agy-context-menu"
  ```

### Option B — From Local Source Checkout

```bash
node scripts/install.mjs
```

Both methods deploy the plugin to `~/.gemini/config/plugins/agy-context-menu` without modifying `app.asar`.

## Testing

```bash
node --test sidecars/menu/tests/*.test.mjs
```

## License

[MIT](LICENSE)
