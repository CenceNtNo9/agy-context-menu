import { createHash } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { openWebSocket } from './ws-client.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BASE_BINDING = '__agyCtxMenuRpcV1';
const MAX_RPC_PAYLOAD_BYTES = 16 * 1024;
const MAX_INFLIGHT_RPC = 16;

export function isValidHubPageTarget(target, port) {
  try {
    if (!target || target.type !== 'page' || !target.url || !target.webSocketDebuggerUrl) {
      return false;
    }
    const pageUrl = new URL(target.url);
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    return (
      ['http:', 'https:'].includes(pageUrl.protocol) &&
      LOOPBACK_HOSTS.has(pageUrl.hostname) &&
      wsUrl.protocol === 'ws:' &&
      LOOPBACK_HOSTS.has(wsUrl.hostname) &&
      Number(wsUrl.port) === Number(port)
    );
  } catch {
    return false;
  }
}

export function buildRendererInjectionSource({
  clientSource,
  bindingName,
  ownerToken = '',
  generation = 0,
  platform = process.platform,
}) {
  const hash = createHash('sha256')
    .update(clientSource + '|' + bindingName + '|' + ownerToken + '|' + platform)
    .digest('hex')
    .slice(0, 16);

  return `(function(){
  if (window !== window.top) return;
  var rank = ${JSON.stringify([generation, ownerToken])};
  var cur = window.__agyCtxMenuRank;
  if (cur && (cur[0] > rank[0] || (cur[0] === rank[0] && cur[1] > rank[1]))) return;
  if (window.__agyCtxMenuVersion === ${JSON.stringify(hash)} && window.__agyCtxMenuInstalled) return;
  try { window.__agyCtxMenuDispose && window.__agyCtxMenuDispose(); } catch (_) {}
  window.__agyCtxMenuRank = rank;
  window.__agyCtxMenuOwner = ${JSON.stringify(ownerToken)};
  window.__agyCtxMenuVersion = ${JSON.stringify(hash)};
  window.__agyCtxMenuConfig = {
    binding: ${JSON.stringify(bindingName)},
    platform: ${JSON.stringify(platform)}
  };
  ${clientSource}
})();`;
}

function httpGetJson(port, reqPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          req.destroy(new Error('CDP discovery response too large'));
        }
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            throw new Error(`HTTP ${res.statusCode}`);
          }
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP discovery timeout')));
    req.end();
  });
}

export class CdpSession {
  constructor(wsUrl, { connectFn = openWebSocket, onEvent = () => {}, onClose = () => {}, timeoutMs = 5000 } = {}) {
    this.wsUrl = wsUrl;
    this.connectFn = connectFn;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    this.ws = await this.connectFn(this.wsUrl, { timeoutMs: this.timeoutMs });
    this.ws.on('message', (raw) => {
      try {
        if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) return;
        const msg = JSON.parse(raw);
        if (msg.id) {
          const item = this.pending.get(msg.id);
          if (!item) return;
          this.pending.delete(msg.id);
          clearTimeout(item.timer);
          if (msg.error) {
            item.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            item.resolve(msg.result || {});
          }
        } else if (msg.method) {
          this.onEvent(msg);
        }
      } catch {
        // Ignore malformed CDP notifications
      }
    });
    this.ws.on('close', () => this.disconnect());
    this.ws.on('error', () => this.disconnect());
    return this;
  }

  command(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP session closed'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP session disconnected'));
    }
    this.pending.clear();
    this.onClose();
  }

  close() {
    this.disconnect();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

async function writeAtomicJson(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Event-driven CDP bridge watching DevToolsActivePort and attaching to Antigravity Hub pages
 * with zero steady-state polling once connected.
 */
export class RuntimeBridge {
  constructor({
    userDataDir,
    devToolsPortFile,
    stateFile,
    clientSource,
    onRpc,
    ownerToken = '',
    generation = 0,
    owns = async () => true,
    enabled = () => true,
    platform = process.platform,
    fetchJson = httpGetJson,
    connectFn = openWebSocket,
  }) {
    this.userDataDir = userDataDir;
    this.devToolsPortFile = devToolsPortFile;
    this.stateFile = stateFile;
    this.clientSource = clientSource;
    this.onRpc = onRpc;
    this.ownerToken = ownerToken;
    this.generation = generation;
    this.owns = owns;
    this.enabled = enabled;
    this.platform = platform;
    this.fetchJson = fetchJson;
    this.connectFn = connectFn;

    this.bindingName = ownerToken
      ? `${BASE_BINDING}_${ownerToken.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16)}`
      : BASE_BINDING;
    this.rendererSource = buildRendererInjectionSource({
      clientSource,
      bindingName: this.bindingName,
      ownerToken,
      generation,
      platform,
    });

    this.browserSession = null;
    this.pageSessions = new Map(); // wsUrl -> sessionState
    this.dirWatcher = null;
    this.parentWatcher = null;
    this.reconnectTimer = null;
    this.syncDebounceTimer = null;
    this.retryIndex = 0;
    this.syncing = false;
    this.syncRequested = false;
    this.stopped = false;
    this.activePort = null;
    this.health = {
      state: 'waiting',
      platform: this.platform,
      connectedWindows: 0,
      message: 'Waiting for Antigravity desktop renderer',
      updatedAt: new Date().toISOString(),
    };
  }

  async updateHealth(state, message) {
    this.health = {
      state,
      platform: this.platform,
      connectedWindows: this.pageSessions.size,
      message,
      updatedAt: new Date().toISOString(),
    };
    if (this.stateFile && (await this.owns())) {
      await writeAtomicJson(this.stateFile, this.health).catch(() => undefined);
    }
  }

  async readDevToolsPort() {
    const raw = await readFile(this.devToolsPortFile, 'utf8');
    const lines = raw.trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid DevToolsActivePort port');
    }
    const browserPath = lines[1]?.trim() || '';
    return { port, browserPath };
  }

  start() {
    this.stopped = false;
    this.#setupWatcher();
    void this.sync();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.syncDebounceTimer);
    this.reconnectTimer = null;
    this.syncDebounceTimer = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
    await this.detachAll();
  }

  #setupWatcher() {
    if (this.stopped) return;
    const watchDir = existsSync(this.userDataDir) ? this.userDataDir : dirname(this.userDataDir);
    const watchingParent = watchDir !== this.userDataDir;

    try {
      const watcher = watch(watchDir, (_eventType, filename) => {
        if (this.stopped) return;
        if (watchingParent) {
          if (existsSync(this.userDataDir)) {
            this.parentWatcher?.close();
            this.parentWatcher = null;
            this.#setupWatcher();
            this.#scheduleSync(100);
          }
          return;
        }
        if (!filename || String(filename) === 'DevToolsActivePort') {
          this.#scheduleSync(120);
        }
      });
      watcher.unref?.();
      if (watchingParent) {
        this.parentWatcher = watcher;
      } else {
        this.dirWatcher = watcher;
      }
    } catch {
      // Fallback handled by disconnected retry timer
    }
  }

  #scheduleSync(delayMs = 100) {
    if (this.stopped) return;
    clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      void this.sync();
    }, delayMs);
    this.syncDebounceTimer.unref?.();
  }

  #scheduleDisconnectedRetry() {
    if (this.stopped || this.reconnectTimer) return;
    const delays = [1500, 3000, 5000];
    const delay = delays[Math.min(this.retryIndex, delays.length - 1)];
    this.retryIndex++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.sync();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async sync() {
    if (this.stopped) return;
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }
    this.syncing = true;

    try {
      if (!(await this.owns())) {
        await this.detachAll();
        return;
      }
      if (!this.enabled()) {
        await this.detachAll();
        await this.updateHealth('disabled', 'Context Menu Plus is disabled');
        return;
      }

      let portInfo;
      try {
        portInfo = await this.readDevToolsPort();
      } catch {
        await this.detachAll();
        await this.updateHealth('waiting', 'Waiting for Antigravity DevToolsActivePort');
        this.#scheduleDisconnectedRetry();
        return;
      }

      if (this.activePort !== portInfo.port) {
        await this.detachAll();
        this.activePort = portInfo.port;
      }

      // Connect browser-level target discovery once per DevTools port (event-driven target creation)
      if (portInfo.browserPath && (!this.browserSession || this.browserSession.closed)) {
        await this.#connectBrowserSession(portInfo.port, portInfo.browserPath).catch(() => undefined);
      }

      const targets = await this.fetchJson(portInfo.port, '/json/list');
      if (this.stopped || !(await this.owns()) || !this.enabled()) return;

      const validTargets = Array.isArray(targets)
        ? targets.filter((t) => isValidHubPageTarget(t, portInfo.port))
        : [];
      const activeUrls = new Set(validTargets.map((t) => t.webSocketDebuggerUrl));

      for (const [wsUrl, state] of this.pageSessions.entries()) {
        if (!activeUrls.has(wsUrl) || state.session.closed) {
          state.session.close();
          this.pageSessions.delete(wsUrl);
        }
      }

      for (const target of validTargets) {
        if (!this.pageSessions.has(target.webSocketDebuggerUrl)) {
          await this.#attachPage(target).catch(() => undefined);
        }
      }

      if (this.pageSessions.size > 0) {
        this.retryIndex = 0;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        await this.updateHealth('mounted', 'Connected to Antigravity Hub renderer');
      } else {
        await this.updateHealth('waiting', 'Waiting for Antigravity Hub page target');
        this.#scheduleDisconnectedRetry();
      }
    } catch {
      await this.updateHealth('waiting', 'Reconnecting to Antigravity renderer');
      this.#scheduleDisconnectedRetry();
    } finally {
      this.syncing = false;
      if (this.syncRequested && !this.stopped) {
        this.syncRequested = false;
        void this.sync();
      }
    }
  }

  async #connectBrowserSession(port, browserPath) {
    const wsUrl = `ws://127.0.0.1:${port}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`;
    const session = new CdpSession(wsUrl, {
      connectFn: this.connectFn,
      onEvent: (msg) => {
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const info = msg.params?.targetInfo;
          if (info?.type === 'page' && info.url && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(info.url)) {
            this.#scheduleSync(80);
          }
        } else if (msg.method === 'Target.targetDestroyed') {
          this.#scheduleSync(80);
        }
      },
      onClose: () => {
        if (this.browserSession === session) {
          this.browserSession = null;
        }
        if (!this.stopped) {
          this.#scheduleDisconnectedRetry();
        }
      },
    });
    await session.open();
    this.browserSession = session;
    await session.command('Target.setDiscoverTargets', { discover: true });
  }

  async #attachPage(target) {
    const pageOrigin = new URL(target.url).origin;
    const state = {
      wsUrl: target.webSocketDebuggerUrl,
      origin: pageOrigin,
      frameId: null,
      contexts: new Set(),
      contextCandidates: new Map(),
      inflight: 0,
      scriptId: null,
      guardedSource: `if (location.origin === ${JSON.stringify(pageOrigin)}) {\n${this.rendererSource}\n}`,
      session: null,
    };

    const session = new CdpSession(target.webSocketDebuggerUrl, {
      connectFn: this.connectFn,
      onEvent: (msg) => {
        void this.#handlePageEvent(state, msg);
      },
      onClose: () => {
        if (this.pageSessions.get(state.wsUrl) === state) {
          this.pageSessions.delete(state.wsUrl);
          if (!this.stopped) {
            void this.updateHealth(
              this.pageSessions.size > 0 ? 'mounted' : 'waiting',
              this.pageSessions.size > 0 ? 'Connected to Antigravity Hub renderer' : 'Waiting for Antigravity Hub page'
            );
            if (this.pageSessions.size === 0) {
              this.#scheduleDisconnectedRetry();
            }
          }
        }
      },
    });
    state.session = session;

    try {
      await session.open();
      if (this.stopped || !(await this.owns()) || !this.enabled()) {
        session.close();
        return;
      }
      const tree = await session.command('Page.getFrameTree');
      state.frameId = tree?.frameTree?.frame?.id || null;
      if (!state.frameId) {
        throw new Error('Main frame unavailable');
      }

      await session.command('Page.enable');
      await session.command('Runtime.enable');
      await session.command('Runtime.addBinding', { name: this.bindingName });
      const added = await session.command('Page.addScriptToEvaluateOnNewDocument', {
        source: state.guardedSource,
      });
      state.scriptId = added?.identifier || null;
      await session.command('Runtime.evaluate', { expression: state.guardedSource });

      this.pageSessions.set(state.wsUrl, state);
    } catch (err) {
      if (state.scriptId) {
        await session.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: state.scriptId }).catch(() => undefined);
      }
      await session.command('Runtime.removeBinding', { name: this.bindingName }).catch(() => undefined);
      session.close();
      throw err;
    }
  }

  async #handlePageEvent(state, msg) {
    if (this.stopped || !(await this.owns()) || !this.enabled()) return;
    const p = msg.params || {};

    if (msg.method === 'Page.frameNavigated' && p.frame && !p.frame.parentId) {
      const replaced = state.frameId !== p.frame.id;
      state.frameId = p.frame.id;
      state.contexts.clear();
      const trusted = p.frame.url === state.origin || p.frame.url?.startsWith(state.origin + '/');
      if (replaced && trusted) {
        for (const [ctxId, ctx] of state.contextCandidates.entries()) {
          if (ctx.frameId === state.frameId && ctx.origin === state.origin) {
            state.contexts.add(ctxId);
          }
        }
      }
      return;
    }

    if (msg.method === 'Runtime.executionContextCreated') {
      if (p.context?.auxData?.isDefault) {
        state.contextCandidates.set(p.context.id, {
          frameId: p.context.auxData.frameId,
          origin: p.context.origin,
        });
        if (state.contextCandidates.size > 32) {
          const oldest = state.contextCandidates.keys().next().value;
          state.contextCandidates.delete(oldest);
        }
        if (p.context.auxData.frameId === state.frameId && p.context.origin === state.origin) {
          state.contexts.add(p.context.id);
        }
      }
      return;
    }

    if (msg.method === 'Runtime.executionContextsCleared') {
      state.contexts.clear();
      state.contextCandidates.clear();
      return;
    }

    if (msg.method === 'Runtime.executionContextDestroyed') {
      state.contexts.delete(p.executionContextId);
      state.contextCandidates.delete(p.executionContextId);
      return;
    }

    if (msg.method !== 'Runtime.bindingCalled' || p.name !== this.bindingName) {
      return;
    }
    if (state.contexts.size > 0 && !state.contexts.has(p.executionContextId)) {
      return;
    }
    if (typeof p.payload !== 'string' || p.payload.length > MAX_RPC_PAYLOAD_BYTES || state.inflight >= MAX_INFLIGHT_RPC) {
      return;
    }

    let req;
    try {
      req = JSON.parse(p.payload);
      if (!req || !Number.isSafeInteger(req.id) || req.id < 1 || typeof req.type !== 'string') {
        return;
      }
    } catch {
      return;
    }

    state.inflight++;
    try {
      const result = await this.onRpc(req.type, req.input || {});
      if (this.stopped || !(await this.owns())) return;
      const expr = `window.__agyCtxMenuResolve && window.__agyCtxMenuResolve(${req.id}, ${JSON.stringify(result)})`;
      await state.session.command('Runtime.evaluate', {
        expression: expr,
        contextId: p.executionContextId,
      });
    } catch (err) {
      if (this.stopped || !(await this.owns())) return;
      const failure = { ok: false, error: err?.message || 'RPC execution failed' };
      const expr = `window.__agyCtxMenuResolve && window.__agyCtxMenuResolve(${req.id}, ${JSON.stringify(failure)})`;
      await state.session
        .command('Runtime.evaluate', { expression: expr, contextId: p.executionContextId })
        .catch(() => undefined);
    } finally {
      state.inflight--;
    }
  }

  async detachAll() {
    if (this.browserSession) {
      this.browserSession.close();
      this.browserSession = null;
    }
    for (const state of this.pageSessions.values()) {
      try {
        if (await this.owns()) {
          await state.session.command('Runtime.evaluate', {
            expression: 'try { window.__agyCtxMenuDispose && window.__agyCtxMenuDispose(); } catch (_) {}',
          });
        }
        if (state.scriptId) {
          await state.session.command('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: state.scriptId,
          });
        }
        await state.session.command('Runtime.removeBinding', { name: this.bindingName });
      } catch {
        // Page may already be closed
      }
      state.session.close();
    }
    this.pageSessions.clear();
  }
}
