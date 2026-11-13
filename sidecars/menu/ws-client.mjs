import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class LoopbackWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragmentedOpcode = null;
    this.fragmentedChunks = [];
    this.#connect();
  }

  #connect() {
    const parsed = new URL(this.url);
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept'];
      const expected = createHash('sha1').update(key + WS_MAGIC).digest('base64');
      if (accept !== expected) {
        socket.destroy();
        this.emit('error', new Error('Invalid Sec-WebSocket-Accept header'));
        return;
      }
      this.socket = socket;
      this.readyState = 1; // OPEN
      if (head && head.length > 0) {
        this.#onData(head);
      }
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('close', () => {
        if (this.readyState !== 3) {
          this.readyState = 3;
          this.emit('close');
        }
      });
      socket.on('error', (err) => this.emit('error', err));
      this.emit('open');
    });

    req.on('response', (res) => {
      this.emit('error', new Error(`WebSocket HTTP upgrade rejected (${res.statusCode})`));
    });
    req.on('error', (err) => this.emit('error', err));
    req.end();
  }

  #sendFrame(opcode, payloadBuffer) {
    if (this.readyState !== 1 || !this.socket) return;
    const len = payloadBuffer.length;
    const mask = randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payloadBuffer[i] ^ mask[i & 3];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this.#sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      // ignore close errors
    }
    this.emit('close');
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = Boolean(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        continue;
      }

      if (opcode === 0x0) {
        this.fragmentedChunks.push(payload);
        if (fin && this.fragmentedOpcode === 0x1) {
          const text = Buffer.concat(this.fragmentedChunks).toString('utf8');
          this.fragmentedOpcode = null;
          this.fragmentedChunks = [];
          this.emit('message', text);
        }
      } else if (!fin) {
        this.fragmentedOpcode = opcode;
        this.fragmentedChunks = [payload];
      } else if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

/**
 * Opens a loopback WebSocket using global WebSocket (Node 22+) or the built-in RFC 6455 client.
 */
export function openWebSocket(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const NativeWs = globalThis.WebSocket;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      reject(new Error('WebSocket connection timeout'));
    }, timeoutMs);

    let ws;
    if (typeof NativeWs === 'function') {
      ws = new NativeWs(url);
      const adapter = new EventEmitter();
      adapter.send = (data) => ws.send(data);
      adapter.close = () => ws.close();
      Object.defineProperty(adapter, 'readyState', {
        get: () => ws.readyState,
      });

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(adapter);
      }, { once: true });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('WebSocket connection failed'));
        } else {
          adapter.emit('error', new Error('WebSocket error'));
        }
      });
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          adapter.emit('message', event.data);
        }
      });
      ws.addEventListener('close', () => {
        adapter.emit('close');
      });
      return;
    }

    ws = new LoopbackWebSocket(url);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
