(function () {
  var cfg = window.__agyCtxMenuConfig || {};
  var bindingName = cfg.binding;
  if (!bindingName || typeof window[bindingName] !== 'function') {
    return;
  }

  var pending = new Map();
  var seq = 0;
  var toastTimer = null;
  var toastHost = null;
  var fallbackMenuHost = null;

  window.__agyCtxMenuResolve = function (id, result) {
    var item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    item.resolve(result);
  };

  function rpc(type, input, timeoutMs) {
    return new Promise(function (resolve) {
      if (pending.size >= 16) {
        resolve({ ok: false, error: 'Too many pending requests' });
        return;
      }
      var id = ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        resolve({ ok: false, error: 'Request timeout' });
      }, timeoutMs || 8000);
      pending.set(id, { resolve: resolve, timer: timer });
      try {
        window[bindingName](JSON.stringify({ id: id, type: type, input: input || {} }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: String((err && err.message) || err || 'RPC failed') });
      }
    });
  }

  function isZhLanguage(prefLang) {
    if (prefLang === 'zh-CN') return true;
    if (prefLang === 'en') return false;
    var nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('zh') === 0;
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function formatRelativeTime(mtimeMs, zh) {
    if (typeof mtimeMs !== 'number' || !isFinite(mtimeMs)) return '';
    var diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
    if (diffSec < 60) return zh ? '刚刚修改' : 'just now';
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return zh ? diffMin + ' 分钟前' : diffMin + 'm ago';
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return zh ? diffHr + ' 小时前' : diffHr + 'h ago';
    var diffDay = Math.floor(diffHr / 24);
    return zh ? diffDay + ' 天前' : diffDay + 'd ago';
  }

  function showToast(message, isError) {
    if (!document.body || !message) return;
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.id = 'agy-ctx-menu-toast-host';
      toastHost.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;pointer-events:none;';
      toastHost.attachShadow({ mode: 'open' });
      document.body.appendChild(toastHost);
    }
    var root = toastHost.shadowRoot;
    root.innerHTML =
      '<style>' +
      '.toast{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.4;padding:8px 13px;border-radius:8px;background:' +
      (isError ? 'rgba(127,29,29,0.95)' : 'rgba(24,24,27,0.94)') +
      ';color:#f8fafc;border:1px solid ' +
      (isError ? 'rgba(248,113,113,0.45)' : 'rgba(148,163,184,0.28)') +
      ';box-shadow:0 8px 24px rgba(0,0,0,0.32);max-width:340px;word-break:break-word;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease}' +
      '.toast.show{opacity:1;transform:translateY(0)}' +
      '</style><div class="toast"></div>';
    var box = root.querySelector('.toast');
    box.textContent = message;
    requestAnimationFrame(function () {
      box.classList.add('show');
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (box) box.classList.remove('show');
      setTimeout(function () {
        if (toastHost && !box.classList.contains('show')) {
          toastHost.remove();
          toastHost = null;
        }
      }, 180);
    }, 1800);
  }

  function closeFallbackMenu() {
    if (fallbackMenuHost) {
      fallbackMenuHost.remove();
      fallbackMenuHost = null;
    }
  }

  function showFallbackMenu(items, clientX, clientY) {
    closeFallbackMenu();
    return new Promise(function (resolve) {
      fallbackMenuHost = document.createElement('div');
      fallbackMenuHost.id = 'agy-ctx-menu-fallback-host';
      fallbackMenuHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
      var shadow = fallbackMenuHost.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent =
        '.backdrop{position:fixed;inset:0;background:transparent}' +
        '.menu{position:fixed;min-width:220px;max-width:340px;padding:5px;border-radius:10px;background:#1e1f22;color:#e5e7eb;border:1px solid rgba(255,255,255,0.12);box-shadow:0 12px 32px rgba(0,0,0,0.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12.5px;user-select:none}' +
        '.item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}' +
        '.item:hover:not([disabled]){background:rgba(56,189,248,0.18);color:#f8fafc}' +
        '.item[disabled]{opacity:.52;cursor:default}' +
        '.sep{height:1px;margin:4px 6px;background:rgba(255,255,255,0.1)}';
      shadow.appendChild(style);

      var backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      var menu = document.createElement('div');
      menu.className = 'menu';

      function finish(id) {
        closeFallbackMenu();
        resolve(id);
      }

      backdrop.addEventListener('mousedown', function () { finish(null); });
      backdrop.addEventListener('contextmenu', function (e) { e.preventDefault(); finish(null); });

      function appendItems(list, container) {
        for (var i = 0; i < list.length; i++) {
          var entry = list[i];
          if (!entry) continue;
          if (entry.type === 'separator') {
            var sep = document.createElement('div');
            sep.className = 'sep';
            container.appendChild(sep);
            continue;
          }
          if (Array.isArray(entry.submenu) && entry.submenu.length > 0) {
            var groupLabel = document.createElement('button');
            groupLabel.type = 'button';
            groupLabel.className = 'item';
            groupLabel.disabled = true;
            groupLabel.textContent = entry.label;
            container.appendChild(groupLabel);
            appendItems(entry.submenu, container);
            continue;
          }
          (function (it) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'item';
            btn.disabled = Boolean(it.disabled);
            btn.textContent = it.label || '';
            btn.addEventListener('click', function () {
              if (!it.disabled) finish(it.id);
            });
            container.appendChild(btn);
          })(entry);
        }
      }

      appendItems(items, menu);
      shadow.appendChild(backdrop);
      shadow.appendChild(menu);
      document.body.appendChild(fallbackMenuHost);

      var rect = menu.getBoundingClientRect();
      var left = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - rect.width - 8));
      var top = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - rect.height - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    });
  }

  async function presentContextMenu(items, event) {
    if (window.electronNative && typeof window.electronNative.showContextMenu === 'function') {
      try {
        return await window.electronNative.showContextMenu(items);
      } catch (_) {
        // fallback below
      }
    }
    return showFallbackMenu(items, event.clientX, event.clientY);
  }

  function getConversationId() {
    var pathMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (pathMatch) return pathMatch[1];
    var owner = document.querySelector('[data-cascade-id]');
    if (owner) {
      var id = owner.getAttribute('data-cascade-id');
      if (id && /^[0-9a-f-]{36}$/i.test(id)) return id;
    }
    return null;
  }

  function isInsideEditable(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'));
  }

  function isPathLikeString(val) {
    if (typeof val !== 'string') return false;
    var s = val.trim();
    if (!s || s.length > 2048 || /[\r\n]/.test(s)) return false;
    if (/^file:\/\//i.test(s)) return true;
    if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s)) return true;
    if (/^\/(?:Users|home|tmp|var|opt|etc|Volumes|Applications|mnt)\//.test(s)) return true;
    if (/^~[\\/]/.test(s)) return true;
    if ((s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) && !/^https?:\/\//i.test(s) && s.indexOf(' ') < 0) return true;
    return false;
  }

  function collectReactPropCandidates(el, out) {
    try {
      var keys = Object.keys(el);
      var propKey = null;
      var fiberKey = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactProps$') === 0) propKey = keys[i];
        else if (keys[i].indexOf('__reactFiber$') === 0) fiberKey = keys[i];
      }
      var propNames = ['href', 'uri', 'fileUri', 'fileUrl', 'filePath', 'path', 'fullPath', 'targetUri', 'artifactPath', 'src'];
      var inspectProps = function (props) {
        if (!props || typeof props !== 'object') return;
        for (var j = 0; j < propNames.length; j++) {
          var v = props[propNames[j]];
          if (isPathLikeString(v)) {
            out.push({ source: 'react-prop', value: v.trim(), linkText: (el.textContent || '').trim() });
          }
        }
        if (props.file && typeof props.file === 'object') {
          for (var k = 0; k < propNames.length; k++) {
            var fv = props.file[propNames[k]];
            if (isPathLikeString(fv)) {
              out.push({ source: 'react-prop', value: fv.trim(), linkText: (el.textContent || '').trim() });
            }
          }
        }
      };

      if (propKey) inspectProps(el[propKey]);
      if (fiberKey) {
        var fiber = el[fiberKey];
        for (var depth = 0; depth < 5 && fiber; depth++) {
          inspectProps(fiber.memoizedProps);
          fiber = fiber.return;
        }
      }
    } catch (_) {
      // React internals are strictly best-effort
    }
  }

  function extractTokenAtPoint(clientX, clientY) {
    try {
      var range = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(clientX, clientY)
        : null;
      if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return '';
      var text = range.startContainer.textContent || '';
      var offset = range.startOffset;
      var stopRe = /[\s"'`<>()[\]{},;]/;
      var start = offset;
      while (start > 0 && !stopRe.test(text[start - 1])) start--;
      var end = offset;
      while (end < text.length && !stopRe.test(text[end])) end++;
      var token = text.slice(start, end).trim();
      return token.length > 1 && token.length <= 512 ? token : '';
    } catch (_) {
      return '';
    }
  }

  function collectHintDirs() {
    var dirs = [];
    var seen = new Set();
    try {
      var links = document.querySelectorAll('a[href^="file://"]');
      for (var i = links.length - 1; i >= 0 && dirs.length < 6; i--) {
        var href = links[i].getAttribute('href');
        if (!href) continue;
        var clean = href.split('#')[0];
        var lastSlash = clean.lastIndexOf('/');
        if (lastSlash > 7) {
          var parentHref = clean.slice(0, lastSlash);
          if (!seen.has(parentHref)) {
            seen.add(parentHref);
            dirs.push(parentHref);
          }
        }
      }
    } catch (_) {}
    return dirs;
  }

  function extractCandidates(event) {
    var candidates = [];
    var seen = new Set();
    var add = function (source, value, linkText) {
      if (!value || typeof value !== 'string') return;
      var trimmed = value.trim();
      if (!trimmed || trimmed.length > 2048) return;
      var key = source + '|' + trimmed;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ source: source, value: trimmed, linkText: linkText || '' });
    };

    var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    var clickedCodeEl = null;
    var anchorEl = null;
    var steps = 0;

    for (var i = 0; i < path.length && steps < 9; i++) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue;
      steps++;
      var tag = (node.tagName || '').toUpperCase();

      if (tag === 'A') {
        anchorEl = node;
        var href = node.getAttribute('href') || node.href;
        if (href && /^file:/i.test(href)) {
          add('explicit-uri', href, (node.textContent || '').trim());
        }
      }

      if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO') && node.getAttribute('src')) {
        var src = node.getAttribute('src');
        if (/^file:/i.test(src) || isPathLikeString(src)) {
          add('media-src', src, node.getAttribute('alt') || '');
        }
      }

      var attrs = ['data-file-path', 'data-filepath', 'data-path', 'data-uri', 'data-href', 'title', 'aria-label'];
      for (var a = 0; a < attrs.length; a++) {
        var av = node.getAttribute(attrs[a]);
        if (isPathLikeString(av)) {
          add(attrs[a] === 'data-uri' || /^file:/i.test(av) ? 'explicit-uri' : 'dom-attr', av, (node.textContent || '').trim());
        }
      }

      collectReactPropCandidates(node, candidates);

      if ((tag === 'CODE' || tag === 'KBD') && !clickedCodeEl) {
        var codeText = (node.textContent || '').trim();
        if (codeText && codeText.indexOf('\n') < 0 && codeText.length <= 512) {
          clickedCodeEl = node;
          add('inline-code', codeText, codeText);
        }
      }

      if (tag === 'ARTICLE' || tag === 'MAIN' || node.getAttribute('role') === 'main' || tag === 'BODY') {
        break;
      }
    }

    var caretToken = extractTokenAtPoint(event.clientX, event.clientY);
    if (caretToken && isPathLikeString(caretToken)) {
      add('caret-token', caretToken, caretToken);
    }

    var selectionText = '';
    try {
      selectionText = String(window.getSelection ? window.getSelection() : '').trim();
    } catch (_) {}
    if (selectionText && selectionText.indexOf('\n') < 0 && selectionText.length <= 512 && isPathLikeString(selectionText)) {
      add('selection-text', selectionText, selectionText);
    }

    return {
      candidates: candidates,
      clickedCodeText: clickedCodeEl ? (clickedCodeEl.textContent || '').trim() : '',
      anchorText: anchorEl ? (anchorEl.textContent || '').trim() : '',
      selectionText: selectionText,
      hasExplicitAnchor: Boolean(anchorEl && /^file:/i.test(anchorEl.getAttribute('href') || '')),
    };
  }

  function findComposerEditor() {
    var visible = function (el) {
      return Boolean(el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0);
    };
    var selectors = [
      '[data-testid="agent-input-box"] [contenteditable="true"]',
      '[role="combobox"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      '[aria-label="Message input"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var list = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < list.length; j++) {
        if (visible(list[j])) return list[j];
      }
    }
    return null;
  }

  function insertIntoComposer(text) {
    var editor = findComposerEditor();
    if (!editor) return false;
    editor.focus();
    try {
      var sel = window.getSelection();
      if (sel && (!editor.contains(sel.anchorNode) || sel.rangeCount === 0)) {
        var range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      var inserted = document.execCommand && document.execCommand('insertText', false, text + ' ');
      if (!inserted) {
        editor.textContent = (editor.textContent || '') + (editor.textContent ? ' ' : '') + text + ' ';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text + ' ' }));
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function buildMenuItems(resolved, meta) {
    var zh = isZhLanguage(meta.language);
    var isMac = meta.platform === 'darwin';
    var items = [];

    if (!resolved.exists) {
      items.push({
        id: '__header',
        label: (zh ? '⚠️ 文件不存在: ' : '⚠️ Missing: ') + resolved.fileName,
        disabled: true,
      });
    } else {
      var parts = [(resolved.isDirectory ? '📁 ' : '📄 ') + resolved.fileName];
      if (!resolved.isDirectory && typeof resolved.size === 'number') {
        parts.push(formatBytes(resolved.size));
      }
      var relTime = formatRelativeTime(resolved.mtimeMs, zh);
      if (relTime) parts.push(relTime);
      items.push({ id: '__header', label: parts.join(' · '), disabled: true });
    }

    items.push({ type: 'separator' });

    items.push({
      id: 'open-default',
      label: zh ? '打开文件（默认方式）' : 'Open with Default App',
      disabled: !resolved.exists,
    });

    var revealLabel;
    if (!resolved.exists && resolved.nearestExistingDir) {
      revealLabel = zh ? '打开最近存在的上级目录' : 'Open Nearest Existing Parent Folder';
    } else if (isMac) {
      revealLabel = zh ? '在“访达”中显示' : 'Reveal in Finder';
    } else {
      revealLabel = zh ? '在资源管理器中显示' : 'Reveal in File Explorer';
    }
    items.push({
      id: 'reveal',
      label: revealLabel,
      disabled: !resolved.exists && !resolved.nearestExistingDir,
    });

    var editors = Array.isArray(meta.editors) ? meta.editors : [];
    var lineSuffix = resolved.line ? (zh ? ' (第 ' + resolved.line + ' 行)' : ' (Line ' + resolved.line + ')') : '';
    if (editors.length === 1) {
      items.push({
        id: 'open-editor:' + editors[0].id,
        label: (zh ? '在 ' + editors[0].label + ' 中打开' : 'Open in ' + editors[0].label) + lineSuffix,
        disabled: !resolved.exists,
      });
    } else if (editors.length > 1) {
      var preferred = editors.find(function (e) { return e.id === meta.preferredEditor; }) || editors[0];
      items.push({
        id: 'open-editor:' + preferred.id,
        label: (zh ? '在 ' + preferred.label + ' 中打开' : 'Open in ' + preferred.label) + lineSuffix,
        disabled: !resolved.exists,
      });
      items.push({
        id: 'open-editor-more',
        label: zh ? '选择编辑器打开' : 'Open in Other Editor',
        disabled: !resolved.exists,
        submenu: editors.map(function (ed) {
          return {
            id: 'open-editor:' + ed.id,
            label: ed.label + lineSuffix,
            disabled: !resolved.exists,
          };
        }),
      });
    }

    items.push({
      id: 'open-terminal',
      label: zh ? '在此处打开终端' : 'Open in Terminal Here',
      disabled: !resolved.exists && !resolved.nearestExistingDir,
    });

    items.push({ type: 'separator' });

    // Distinct two options as requested: Copy File Entity vs Copy File Path
    items.push({
      id: 'copy-file',
      label: zh ? '复制文件' : 'Copy File',
      disabled: !resolved.exists || resolved.isDirectory,
    });
    items.push({
      id: 'copy-path',
      label: resolved.isDirectory
        ? (zh ? '复制文件夹路径' : 'Copy Folder Path')
        : (zh ? '复制文件路径' : 'Copy File Path'),
    });

    var moreCopy = [];
    var containingDir = !resolved.isDirectory
      ? (resolved.containingDir || (resolved.parentDir && resolved.parentDir !== resolved.targetPath ? resolved.parentDir : null))
      : null;
    if (containingDir) {
      moreCopy.push({
        id: 'copy-parent-path',
        label: zh ? '复制所在文件夹路径' : 'Copy Containing Folder Path',
      });
    }
    if (resolved.relativePath) {
      moreCopy.push({
        id: 'copy-relative-path',
        label: zh ? '复制工作区相对路径' : 'Copy Relative Path',
      });
    }
    if (resolved.line) {
      moreCopy.push({
        id: 'copy-path-with-line',
        label: zh ? '复制带行号路径' : 'Copy Path with Line',
      });
    }
    moreCopy.push({
      id: 'copy-filename',
      label: zh ? '复制文件名' : 'Copy File Name',
    });
    if (meta.displayText) {
      moreCopy.push({
        id: 'copy-display-text',
        label: zh ? '复制显示文本' : 'Copy Display Text',
      });
    }
    items.push({
      id: 'copy-more',
      label: zh ? '复制更多格式' : 'Copy More Formats',
      submenu: moreCopy,
    });

    items.push({ type: 'separator' });

    items.push({
      id: 'mention-composer',
      label: zh ? '引用到聊天输入框' : 'Mention in Composer',
    });

    return items;
  }

  async function executeChosenAction(actionId, resolved, meta) {
    if (!actionId) return;
    var zh = isZhLanguage(meta.language);

    if (actionId === 'mention-composer') {
      var mentionVal = resolved.relativePath || resolved.targetPath;
      var ok = insertIntoComposer(mentionVal);
      showToast(ok ? (zh ? '已引用到输入框' : 'Inserted into composer') : (zh ? '未找到聊天输入框' : 'Composer input not found'), !ok);
      return;
    }

    if (actionId === 'reveal' && resolved.exists && resolved.fileUrl && window.electronNative && typeof window.electronNative.revealInFilePicker === 'function') {
      try {
        await window.electronNative.revealInFilePicker(resolved.fileUrl);
        return;
      } catch (_) {
        // Fallback to sidecar reveal
      }
    }

    var resolvedContainingDir = !resolved.isDirectory
      ? (resolved.containingDir || (resolved.parentDir && resolved.parentDir !== resolved.targetPath ? resolved.parentDir : ''))
      : '';
    var textMap = {
      'copy-path': resolved.targetPath,
      'copy-parent-path': resolvedContainingDir,
      'copy-relative-path': resolved.relativePath || resolved.targetPath,
      'copy-path-with-line': (resolved.relativePath || resolved.targetPath) + (resolved.line ? ':' + resolved.line : ''),
      'copy-filename': resolved.fileName,
      'copy-display-text': meta.displayText || resolved.fileName,
    };

    var res = await rpc('execute-action', {
      action: actionId.indexOf('open-editor:') === 0 ? 'open-editor' : actionId,
      editorId: actionId.indexOf('open-editor:') === 0 ? actionId.slice('open-editor:'.length) : undefined,
      targetPath: resolved.targetPath,
      exists: resolved.exists,
      isDirectory: resolved.isDirectory,
      nearestExistingDir: resolved.nearestExistingDir,
      line: resolved.line,
      col: resolved.col,
      text: textMap[actionId],
    });

    if (!res || res.ok === false) {
      showToast((res && res.error) || (zh ? '操作失败' : 'Action failed'), true);
      return;
    }

    if (actionId === 'copy-file') {
      showToast(zh ? '已复制文件实体，可直接粘贴发送' : 'Copied file to clipboard');
    } else if (actionId === 'copy-path') {
      showToast(
        resolved.isDirectory
          ? (zh ? '已复制文件夹路径' : 'Copied folder path')
          : (zh ? '已复制文件路径' : 'Copied file path')
      );
    } else if (actionId === 'copy-parent-path') {
      showToast(zh ? '已复制所在文件夹路径' : 'Copied containing folder path');
    } else if (actionId.indexOf('copy-') === 0) {
      showToast(zh ? '已复制到剪贴板' : 'Copied to clipboard');
    } else if (actionId === 'reveal' && !resolved.exists) {
      showToast(zh ? '原文件已移除，已打开最近的上级目录' : 'File missing; opened nearest parent folder');
    }
  }

  async function onContextMenu(event) {
    if (event.shiftKey) return;
    var extracted = extractCandidates(event);

    // Do not hijack editable composer inputs unless user clicked an explicit file pill
    if (isInsideEditable(event.target) && !extracted.hasExplicitAnchor) {
      return;
    }

    var hasCandidates = extracted.candidates.length > 0;
    var hasCodeWithoutSelection = Boolean(extracted.clickedCodeText && !extracted.selectionText);
    if (!hasCandidates && !hasCodeWithoutSelection) {
      return;
    }

    // Prevent Antigravity's grayed-out native Copy menu synchronously
    event.preventDefault();
    event.stopImmediatePropagation();

    var convId = getConversationId();
    var hintDirs = collectHintDirs();

    var resolved = hasCandidates
      ? await rpc('resolve-target', {
          candidates: extracted.candidates,
          conversationId: convId,
          hintDirs: hintDirs,
        })
      : { matched: false };

    if (resolved && resolved.matched) {
      var meta = {
        platform: resolved.platform || cfg.platform,
        language: resolved.language || 'auto',
        preferredEditor: resolved.preferredEditor || 'auto',
        editors: resolved.editors || [],
        displayText: extracted.selectionText || extracted.anchorText || extracted.clickedCodeText || '',
      };
      var items = buildMenuItems(resolved, meta);
      var chosen = await presentContextMenu(items, event);
      await executeChosenAction(chosen, resolved, meta);
      return;
    }

    // Fallback for non-file inline code or link labels where native Copy is grayed out
    var fallbackText = extracted.selectionText || extracted.clickedCodeText || extracted.anchorText;
    if (!fallbackText) return;
    var zh = isZhLanguage(resolved && resolved.language);
    var copyChoice = await presentContextMenu(
      [
        {
          id: 'copy-inline-text',
          label: zh ? '复制内容' : 'Copy Text',
        },
      ],
      event
    );
    if (copyChoice === 'copy-inline-text') {
      var copyRes = await rpc('execute-action', {
        action: 'copy-text',
        text: fallbackText,
      });
      if (copyRes && copyRes.ok) {
        showToast(zh ? '已复制内容到剪贴板' : 'Copied text to clipboard');
      } else {
        showToast((copyRes && copyRes.error) || (zh ? '复制失败' : 'Copy failed'), true);
      }
    }
  }

  async function onQuickClick(event) {
    if (!event.altKey || event.button !== 0) return;
    if (isInsideEditable(event.target)) return;

    var extracted = extractCandidates(event);
    if (!extracted.hasExplicitAnchor && extracted.candidates.length === 0) return;
    // Quick Alt/Option+Click only intercepts explicit links/React chips, never arbitrary inline text
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
    if (!resolved || !resolved.matched) return;

    var meta = {
      platform: resolved.platform || cfg.platform,
      language: resolved.language || 'auto',
      preferredEditor: resolved.preferredEditor || 'auto',
      editors: resolved.editors || [],
    };
    var actionId = event.ctrlKey || event.metaKey ? 'reveal' : 'open-default';
    await executeChosenAction(actionId, resolved, meta);
  }

  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('click', onQuickClick, true);
  window.__agyCtxMenuInstalled = true;

  window.__agyCtxMenuDispose = function () {
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('click', onQuickClick, true);
    closeFallbackMenu();
    if (toastHost) {
      toastHost.remove();
      toastHost = null;
    }
    for (var item of pending.values()) {
      clearTimeout(item.timer);
    }
    pending.clear();
    delete window.__agyCtxMenuInstalled;
    delete window.__agyCtxMenuResolve;
    delete window.__agyCtxMenuDispose;
  };
})();
