import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeBridge } from '../runtime-bridge.mjs';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer, onMessage) {
  let buf = buffer;
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const b1 = buf[1];
    const masked = Boolean(b1 & 0x80);
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const key = buf.subarray(offset, offset + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
      payload = out;
    }
    buf = buf.subarray(offset + maskLen + len);
    if (opcode === 0x1) {
      onMessage(payload.toString('utf8'));
    }
  }
  return buf;
}

test('RuntimeBridge attaches to mock CDP page, handles RPC, and detaches cleanly on stop()', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agy-cdp-mock-'));
  const portFile = path.join(tempDir, 'DevToolsActivePort');
  const stateFile = path.join(tempDir, 'integration-state.json');

  const cdpCalls = [];
  const sockets = new Set();
  let pageSocket = null;
  let serverPort = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'page-1',
            type: 'page',
            url: 'http://127.0.0.1:5387/',
            webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/devtools/page/page-1`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    if (req.url === '/devtools/page/page-1') {
      pageSocket = socket;
    }

    let rx = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      rx = decodeWsFrames(Buffer.concat([rx, chunk]), (raw) => {
        const msg = JSON.parse(raw);
        cdpCalls.push(msg);
        let result = {};
        if (msg.method === 'Page.getFrameTree') {
          result = { frameTree: { frame: { id: 'frame-main' } } };
        } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
          result = { identifier: 'script-1' };
        }
        socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
  writeFileSync(portFile, `${serverPort}\n/devtools/browser/mock-browser\n`, 'utf8');

  let rpcSeen = null;
  const bridge = new RuntimeBridge({
    userDataDir: tempDir,
    devToolsPortFile: portFile,
    stateFile,
    clientSource: 'window.__mockClientRan = true;',
    ownerToken: 'owner1',
    generation: 1,
    onRpc: async (type, input) => {
      rpcSeen = { type, input };
      return { ok: true, matched: true, fileName: 'demo.ts' };
    },
  });

  try {
    await bridge.sync();
    assert.equal(bridge.health.state, 'mounted');
    assert.equal(bridge.health.connectedWindows, 1);

    const methods = cdpCalls.map((c) => c.method);
    assert.ok(methods.includes('Target.setDiscoverTargets'));
    assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(methods.includes('Runtime.addBinding'));

    // Simulate executionContextCreated + Runtime.bindingCalled from renderer
    pageSocket.write(
      encodeWsTextFrame(
        JSON.stringify({
          method: 'Runtime.executionContextCreated',
          params: {
            context: {
              id: 7,
              origin: 'http://127.0.0.1:5387',
              auxData: { isDefault: true, frameId: 'frame-main' },
            },
          },
        })
      )
    );
    pageSocket.write(
      encodeWsTextFrame(
        JSON.stringify({
          method: 'Runtime.bindingCalled',
          params: {
            name: bridge.bindingName,
            executionContextId: 7,
            payload: JSON.stringify({ id: 99, type: 'resolve-target', input: { candidates: [] } }),
          },
        })
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(rpcSeen, { type: 'resolve-target', input: { candidates: [] } });
    const evalReply = cdpCalls.find(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        typeof c.params?.expression === 'string' &&
        c.params.expression.includes('__agyCtxMenuResolve(99,')
    );
    assert.ok(evalReply, 'Expected Runtime.evaluate RPC resolution');

    await bridge.stop();
    const afterStopMethods = cdpCalls.map((c) => c.method);
    assert.ok(afterStopMethods.includes('Page.removeScriptToEvaluateOnNewDocument'));
    assert.ok(afterStopMethods.includes('Runtime.removeBinding'));
  } finally {
    await bridge.stop();
    for (const s of sockets) s.destroy();
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
