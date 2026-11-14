# Stage 2 渲染层升级指南（`sidecars/menu/renderer-client.cjs`）

> [!NOTE]
> **为什么分为 Stage 1 与 Stage 2？**
> - **Stage 1（已全自动完成）**：后端引擎、`koffi` `<1ms` Win32 FFI、P1–P8 安全与异步补丁、双协议向后兼容 RPC 均已在插件 Sidecar 进程内落地。即使暂不升级 `renderer-client.cjs`，旧版前端也能无缝享受 `<1ms` 原生 FFI、NTLMv2 外部 UNC Pre-stat 拦截、`.ts/.js` 自动转代码编辑器打开以及高危可执行文件拦截提示。
> - **Stage 2（本指南，由你审阅后自行合入）**：升级注入宿主渲染进程的 `sidecars/menu/renderer-client.cjs`，解锁 **5 态 4/2/2/1 极简菜单**、**非阻塞 Shadow DOM 二次确认卡片**、**`Alt+Click` 安全 3 层分流**，以及 **本地盘符 `revealInFilePicker` + WSL/后备 `koffi` 双通道协同**。

---

## 1. 升级收益与协议约束

1. **严格 CJS / 浏览器 IIFE 规范（P7）**：`renderer-client.cjs` 仅被 `runtime-bridge.mjs` 用 `readFileSync` 作为纯字符串注入页面，**严禁在其中使用 ESM `import`**。
2. **消费后端 `menu.items`（5 态极简结构）**：
   - `existing_file`：4 项（打开、在文件夹中打开、复制、复制文件路径）+ 可选扩展项（由面板开关控制）。
   - `existing_directory`：2 项（打开、复制路径）。
   - `missing_path`：2 项（打开上层文件夹、复制路径）。
   - `untrusted_unc`：2 项（打开、复制路径）。
   - `inline_code_text`：1 项（复制文本）。
   - `passthrough`：若 `menu.intercept === false` 且无选中/行内代码，不拦截，交还宿主原生菜单。
3. **一次性 `resolutionId` 防重放二次确认闭环（P8）**：
   - 渲染层不再向后端传回可被伪造的 `ext` / `isDirectory`，而是传 `resolutionId` 与 `actionId`。
   - 当执行 `.exe/.bat/.vbs/.ps1` 或 `untrusted_unc` 时，后端返回 `{ ok: false, status: 'confirmation_required', reason, targetPath, error }`；前端弹出非阻塞 Shadow DOM 确认条，用户点击「确认仍要打开」后，携带 `confirmed: true` 与 `expectedTargetPath: res.targetPath` 重新调用 `execute-action`。
4. **双通道 Reveal 协同**：
   - 仅当目标为本地盘符路径（`/^[a-zA-Z]:[\\/]/`）且存在、`fileUrl` 非空、`window.electronNative?.revealInFilePicker` 可用时，优先调用宿主 `revealInFilePicker(fileUrl)`；
   - `\\wsl.localhost\...`、`\\wsl$\...`、缺失文件（`reveal_nearest_parent`）或宿主调用失败时，自动走 Sidecar `koffi` `<1ms` `SHOpenFolderAndSelectItems` / `openDirectory`（macOS `open -R`）。

---

## 2. 精确升级代码（供审阅合入 `sidecars/menu/renderer-client.cjs`）

以下为完整的 v2 渲染层升级片段，可直接替换 `sidecars/menu/renderer-client.cjs` 中对应的 **`showConfirmCard`、`presentV2Menu`、`executeV2Action`、`onContextMenu` 与 `onQuickClick`** 区块（并保留原有的 `rpc`、`showToast`、`extractCandidates`、`insertIntoComposer`、`__agyCtxMenuDispose` 生命周期管理）：

### 2.1 新增 Shadow DOM 非阻塞二次确认条（插入在 `showToast` 之后）

```javascript
  var confirmHost = null;

  function closeConfirmCard() {
    if (confirmHost) {
      confirmHost.remove();
      confirmHost = null;
    }
  }

  /**
   * Non-blocking Shadow DOM confirmation bar for high-risk executables and untrusted UNC paths.
   */
  function showConfirmCard(opts) {
    closeConfirmCard();
    return new Promise(function (resolve) {
      if (!document.body) {
        resolve(false);
        return;
      }
      confirmHost = document.createElement('div');
      confirmHost.id = 'agy-ctx-menu-confirm-host';
      confirmHost.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
      var shadow = confirmHost.attachShadow({ mode: 'open' });

      var style = document.createElement('style');
      style.textContent =
        '.card{width:360px;max-width:calc(100vw - 40px);padding:12px 14px;border-radius:10px;' +
        'background:rgba(24,24,27,0.97);color:#f8fafc;border:1px solid rgba(245,158,11,0.55);' +
        'box-shadow:0 14px 34px rgba(0,0,0,0.48);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
        'font-size:12.5px;line-height:1.45}' +
        '.title{font-weight:600;color:#fcd34d;margin-bottom:6px;display:flex;align-items:center;gap:6px}' +
        '.msg{color:#e2e8f0;margin-bottom:8px;word-break:break-word}' +
        '.path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:6px 8px;' +
        'border-radius:6px;background:rgba(0,0,0,0.35);color:#cbd5e1;word-break:break-all;margin-bottom:10px}' +
        '.actions{display:flex;justify-content:flex-end;gap:8px}' +
        'button{border:0;border-radius:6px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}' +
        '.cancel{background:rgba(148,163,184,0.18);color:#e2e8f0}' +
        '.cancel:hover{background:rgba(148,163,184,0.28)}' +
        '.confirm{background:#d97706;color:#fff;font-weight:600}' +
        '.confirm:hover{background:#b45309}';
      shadow.appendChild(style);

      var card = document.createElement('div');
      card.className = 'card';

      var titleEl = document.createElement('div');
      titleEl.className = 'title';
      titleEl.textContent = opts.title || '安全确认';

      var msgEl = document.createElement('div');
      msgEl.className = 'msg';
      msgEl.textContent = opts.message || '';

      var pathEl = document.createElement('div');
      pathEl.className = 'path';
      pathEl.textContent = opts.targetPath || '';

      var actions = document.createElement('div');
      actions.className = 'actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cancel';
      cancelBtn.textContent = opts.cancelLabel || '取消';

      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'confirm';
      confirmBtn.textContent = opts.confirmLabel || '确认仍要打开';

      var settled = false;
      function finish(accepted) {
        if (settled) return;
        settled = true;
        clearTimeout(autoCloseTimer);
        window.removeEventListener('keydown', onKeyDown, true);
        closeConfirmCard();
        resolve(accepted);
      }

      function onKeyDown(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
      }

      cancelBtn.addEventListener('click', function () { finish(false); });
      confirmBtn.addEventListener('click', function () { finish(true); });
      window.addEventListener('keydown', onKeyDown, true);

      var autoCloseTimer = setTimeout(function () { finish(false); }, 15000);

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      card.appendChild(titleEl);
      card.appendChild(msgEl);
      if (opts.targetPath) card.appendChild(pathEl);
      card.appendChild(actions);
      shadow.appendChild(card);
      document.body.appendChild(confirmHost);
    });
  }
```

### 2.2 消费后端 `menu.items`、双通道 Reveal 与 P8 确认闭环

```javascript
  function mapBackendMenuItems(menuItems) {
    var out = [];
    for (var i = 0; i < menuItems.length; i++) {
      var item = menuItems[i];
      if (!item) continue;
      if (item.separatorBefore && out.length > 0) {
        out.push({ type: 'separator' });
      }
      if (item.type === 'separator') {
        out.push({ type: 'separator' });
        continue;
      }
      out.push({
        id: item.id,
        label: item.label,
        disabled: item.enabled === false,
      });
    }
    return out;
  }

  function isLocalDrivePath(p) {
    return typeof p === 'string' && /^[a-zA-Z]:[\\/]/.test(p);
  }

  async function executeV2Action(actionId, resolved, displayText) {
    if (!actionId) return;
    var zh = isZhLanguage(resolved.language);
    var target = resolved.target || {};
    var normalizedPath = target.normalizedPath || resolved.targetPath || '';

    if (actionId === 'mention-composer' || actionId === 'mention_composer') {
      var mentionVal = resolved.relativePath || normalizedPath;
      var ok = insertIntoComposer(mentionVal);
      showToast(ok ? (zh ? '已引用到输入框' : 'Inserted into composer') : (zh ? '未找到聊天输入框' : 'Composer input not found'), !ok);
      return;
    }

    // Dual-channel reveal: local Windows/macOS existing paths prefer electronNative.revealInFilePicker;
    // WSL UNC (\\wsl.localhost / \\wsl$), missing parents, or errors seamlessly fall back to koffi Sidecar.
    if (
      actionId === 'reveal_in_folder' &&
      target.kind === 'existing_file' &&
      (resolved.platform !== 'win32' || isLocalDrivePath(normalizedPath)) &&
      resolved.fileUrl &&
      window.electronNative &&
      typeof window.electronNative.revealInFilePicker === 'function'
    ) {
      try {
        await window.electronNative.revealInFilePicker(resolved.fileUrl);
        return;
      } catch (_) {
        // Fallback to Sidecar koffi SHOpenFolderAndSelectItems
      }
    }

    var textPayload;
    if (actionId === 'copy_text') {
      textPayload = target.text || displayText || '';
    } else if (actionId === 'copy_path') {
      textPayload = normalizedPath;
    }

    var payload = {
      actionId: actionId,
      resolutionId: resolved.resolutionId,
      confirmed: false,
      text: textPayload,
    };

    var res = await rpc('execute-action', payload);

    // P8 secondary confirmation flow for high-risk executables or untrusted UNC paths
    if (res && res.status === 'confirmation_required') {
      var isUnc = res.reason === 'untrusted_unc_path';
      var accepted = await showConfirmCard({
        title: zh ? (isUnc ? '⚠️ 外部网络路径安全拦截' : '⚠️ 高危可执行文件拦截') : (isUnc ? '⚠️ Untrusted UNC Blocked' : '⚠️ Executable Blocked'),
        message: res.message || res.error || (zh ? '此操作存在安全风险，是否继续执行？' : 'This operation may be unsafe. Continue anyway?'),
        targetPath: res.targetPath || normalizedPath,
        confirmLabel: zh ? '确认仍要打开' : 'Open Anyway',
        cancelLabel: zh ? '取消' : 'Cancel',
      });
      if (!accepted) {
        showToast(zh ? '已取消操作' : 'Cancelled');
        return;
      }
      res = await rpc('execute-action', {
        actionId: actionId,
        resolutionId: resolved.resolutionId,
        confirmed: true,
        expectedTargetPath: res.targetPath || normalizedPath,
      });
    }

    if (!res || res.ok === false) {
      showToast((res && (res.error || res.message)) || (zh ? '操作失败' : 'Action failed'), true);
      return;
    }

    if (actionId === 'copy_file_entity') {
      showToast(zh ? '已复制文件实体，可直接粘贴发送' : 'Copied file to clipboard');
    } else if (actionId === 'copy_path') {
      showToast(zh ? '已复制文件路径' : 'Copied file path');
    } else if (actionId === 'copy_text') {
      showToast(zh ? '已复制文本到剪贴板' : 'Copied text to clipboard');
    } else if (actionId === 'reveal_nearest_parent') {
      showToast(zh ? '原文件已移除，已打开最近的上级目录' : 'File missing; opened nearest parent folder');
    }
  }
```

### 2.3 `onContextMenu` 与 `onQuickClick` 接入 v2 菜单与安全分流

```javascript
  async function onContextMenu(event) {
    if (event.shiftKey) return;
    var extracted = extractCandidates(event);

    if ((isInsideEditable(event.target) || isInsideExcludedChrome(event.target)) && !extracted.hasExplicitAnchor) {
      return;
    }

    if (extracted.hasExternalLink && !extracted.hasExplicitAnchor) {
      return;
    }

    var hasCandidates = extracted.candidates.length > 0;
    var hasCodeWithoutSelection = Boolean(extracted.clickedCodeText && !extracted.selectionText);
    if (!hasCandidates && !hasCodeWithoutSelection) {
      return;
    }

    var convId = getConversationId();
    var hintDirs = collectHintDirs();

    // Note: preventDefault must run synchronously if we expect to hijack Antigravity's grayed-out menu
    event.preventDefault();
    event.stopImmediatePropagation();

    var resolved = await rpc('resolve-target', {
      candidates: extracted.candidates,
      clickedCodeText: extracted.clickedCodeText,
      selectionText: extracted.selectionText,
      conversationId: convId,
      hintDirs: hintDirs,
    });

    if (resolved && resolved.menu && resolved.menu.intercept && Array.isArray(resolved.menu.items) && resolved.menu.items.length > 0) {
      var items = mapBackendMenuItems(resolved.menu.items);
      var chosen = await presentContextMenu(items, event);
      await executeV2Action(chosen, resolved, extracted.selectionText || extracted.anchorText || extracted.clickedCodeText || '');
      return;
    }

    var fallbackText = extracted.selectionText || extracted.clickedCodeText || extracted.anchorText;
    if (!fallbackText) return;
    var zh = isZhLanguage(resolved && resolved.language);
    var copyChoice = await presentContextMenu(
      [{ id: 'copy_text', label: zh ? '复制内容' : 'Copy Text' }],
      event
    );
    if (copyChoice === 'copy_text') {
      var copyRes = await rpc('execute-action', { actionId: 'copy_text', text: fallbackText });
      if (copyRes && copyRes.ok) {
        showToast(zh ? '已复制内容到剪贴板' : 'Copied text to clipboard');
      } else {
        showToast((copyRes && (copyRes.error || copyRes.message)) || (zh ? '复制失败' : 'Copy failed'), true);
      }
    }
  }

  async function onQuickClick(event) {
    if (!event.altKey || event.button !== 0) return;
    if (isInsideEditable(event.target)) return;

    var extracted = extractCandidates(event);
    if (isInsideExcludedChrome(event.target) && !extracted.hasExplicitAnchor) return;
    if (extracted.hasExternalLink && !extracted.hasExplicitAnchor) return;
    var hasExplicit = extracted.candidates.some(function (c) {
      return c.source === 'explicit-uri' || c.source === 'react-prop';
    });
    if (!hasExplicit) return;

    var cfgRes = await rpc('get-config', {});
    if (cfgRes && cfgRes.altClickOpenDefault === false) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    var resolved = await rpc('resolve-target', {
      candidates: extracted.candidates,
      conversationId: getConversationId(),
      hintDirs: collectHintDirs(),
    });
    if (!resolved || !resolved.target || resolved.target.kind === 'passthrough') return;

    var targetKind = resolved.target.kind;
    var actionId;
    if (event.ctrlKey || event.metaKey) {
      actionId = targetKind === 'missing_path' ? 'reveal_nearest_parent' : 'reveal_in_folder';
    } else if (targetKind === 'untrusted_unc') {
      actionId = 'open_untrusted_unc';
    } else if (targetKind === 'existing_directory') {
      actionId = 'open_directory';
    } else if (targetKind === 'missing_path') {
      actionId = 'reveal_nearest_parent';
    } else {
      actionId = 'open_file'; // Routes through 3-tier smart security policy
    }

    await executeV2Action(actionId, resolved, '');
  }
```

### 2.4 清理钩子补充

在 `__agyCtxMenuDispose` 中补一行 `closeConfirmCard();` 以确保停用或热重载时无残留 DOM。

---

## 3. 应用 Stage 2 升级后的生效步骤

1. 在本地修改或审阅合入 `sidecars/menu/renderer-client.cjs`；
2. 若已部署到运行目录，请先在 Antigravity Customizations 页面关闭 **Context Menu Plus** 开关，等待进程释放后执行 `node scripts/install.mjs` 同步，再重新打开开关；
3. 在 Antigravity 窗口按一次重载（或重开窗口），使新脚本替换旧版注入监听器。
