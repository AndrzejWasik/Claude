import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

const NUL = 0x00;
const LF = 0x0a;
const CR = 0x0d;

const ESC = [['\\', '\\\\'], ['\r', '\\r'], ['\n', '\\n'], [':', '\\c']];

function encodeHeader(s) {
  let out = String(s);
  for (const [raw, esc] of ESC) out = out.split(raw).join(esc);
  return out;
}

function decodeHeader(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const next = s[i + 1];
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 'c') out += ':';
    else if (next === '\\') out += '\\';
    else out += next; // niedozwolona sekwencja - przepuszczamy zamiast zrywac polaczenie
  }
  return out;
}

/**
 * Zdejmuje pierwsza kompletna ramke z bufora. Zwraca null, gdy jeszcze nie ma
 * calosci - wolajacy dokleja kolejny kawalek i probuje znowu.
 */
export function parseFrame(input) {
  // heartbeaty to gole EOL-e miedzy ramkami
  let start = 0;
  while (start < input.length && (input[start] === LF || input[start] === CR)) start += 1;
  const buf = start ? input.subarray(start) : input;
  if (!buf.length) return null;

  // naglowki konczy pusta linia - wg 1.2 zarowno LF LF, jak i CRLF CRLF
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  let sep;
  let gap;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) { sep = crlf; gap = 4; } else if (lf >= 0) { sep = lf; gap = 2; } else return null;

  const headLines = buf.subarray(0, sep).toString('utf8').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const command = headLines.shift();
  const headers = {};
  for (const line of headLines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = decodeHeader(line.slice(0, i));
    if (!(key in headers)) headers[key] = decodeHeader(line.slice(i + 1)); // wg 1.2 wygrywa pierwszy
  }

  const bodyStart = sep + gap;
  let bodyEnd;
  if (headers['content-length'] !== undefined) {
    bodyEnd = bodyStart + Number(headers['content-length']);
    if (buf.length < bodyEnd + 1) return null;
  } else {
    bodyEnd = buf.indexOf(NUL, bodyStart);
    if (bodyEnd < 0) return null;
  }
  return {
    frame: { command, headers, body: buf.subarray(bodyStart, bodyEnd).toString('utf8') },
    rest: buf.subarray(bodyEnd + 1),
  };
}

/**
 * Klient STOMP 1.2 po golym TCP/TLS. Wlasny, bo jedyny utrzymywany klient dla
 * Node ma ostatnie wydanie z 2019, a caly protokol to okolo stu linii.
 * Parsowanie idzie po buforach, nie po stringach - content-length jest w bajtach,
 * a tresci sa po polsku.
 */
export class Stomp extends EventEmitter {
  constructor({ url, vhost, login, passcode, heartbeatMs = 10000 }) {
    super();
    const u = new URL(url);
    this.secure = u.protocol === 'stomp+ssl:' || u.protocol === 'stomps:';
    this.host = u.hostname;
    this.port = Number(u.port) || (this.secure ? 61614 : 61613);
    this.vhost = vhost || u.pathname.replace(/^\//, '') || '/';
    this.login = login;
    this.passcode = passcode;
    this.heartbeatMs = heartbeatMs;
    this.buf = Buffer.alloc(0);
    this.sock = null;
    this.subId = 0;
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      this.sock = this.secure ? tls.connect({ ...opts, servername: this.host }) : net.createConnection(opts);
      this.sock.setNoDelay(true);

      const onFail = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        this.sock.off('error', onFail);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => onFail(new Error(`timeout polaczenia z ${this.host}:${this.port}`)), 15000);

      this.sock.once('error', onFail);
      this.sock.on('data', (chunk) => this.#feed(chunk));
      this.sock.on('close', () => {
        this.connected = false;
        this.#stopHeartbeat();
        this.emit('close');
      });

      this.once('__connected', (frame) => {
        cleanup();
        this.connected = true;
        this.sock.on('error', (err) => this.emit('error', err));
        this.#startHeartbeat(frame.headers['heart-beat']);
        resolve(frame);
      });
      this.once('__error', (frame) => onFail(new Error(frame.headers.message || frame.body || 'ERROR z brokera')));

      this.sock.once(this.secure ? 'secureConnect' : 'connect', () => {
        this.#write('CONNECT', {
          'accept-version': '1.2',
          host: this.vhost,
          login: this.login,
          passcode: this.passcode,
          'heart-beat': `${this.heartbeatMs},${this.heartbeatMs}`,
        }, null, { escape: false });
      });
    });
  }

  #startHeartbeat(header) {
    const [sx, sy] = String(header || '0,0').split(',').map((n) => Number(n) || 0);
    const outMs = sy > 0 ? Math.max(this.heartbeatMs, sy) : 0;
    const inMs = sx > 0 ? Math.max(this.heartbeatMs, sx) : 0;
    if (outMs > 0) {
      this.hbOut = setInterval(() => { try { this.sock.write('\n'); } catch { /* close i tak przyjdzie */ } }, outMs);
      this.hbOut.unref?.();
    }
    if (inMs > 0) {
      this.lastRx = Date.now();
      this.hbIn = setInterval(() => {
        if (Date.now() - this.lastRx > inMs * 2.5) {
          this.emit('error', new Error('broker milczy dluzej niz heartbeat'));
          this.sock.destroy();
        }
      }, inMs);
      this.hbIn.unref?.();
    }
  }

  #stopHeartbeat() {
    clearInterval(this.hbOut);
    clearInterval(this.hbIn);
  }

  #write(command, headers, body, { escape = true } = {}) {
    const enc = escape ? encodeHeader : (s) => String(s);
    const lines = [command];
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      lines.push(`${enc(k)}:${enc(v)}`);
    }
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    if (payload) lines.push(`content-length:${payload.length}`);
    const head = Buffer.from(lines.join('\n') + '\n\n', 'utf8');
    this.sock.write(payload ? Buffer.concat([head, payload, Buffer.from([NUL])]) : Buffer.concat([head, Buffer.from([NUL])]));
  }

  #feed(chunk) {
    this.lastRx = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this.#takeFrame();
      if (!frame) return;
      if (frame.command === 'CONNECTED') this.emit('__connected', frame);
      else if (frame.command === 'MESSAGE') this.emit('message', frame);
      else if (frame.command === 'ERROR') { this.emit('__error', frame); this.emit('error', new Error(frame.headers.message || 'ERROR z brokera')); }
      else if (frame.command === 'RECEIPT') this.emit('receipt', frame);
    }
  }

  #takeFrame() {
    const taken = parseFrame(this.buf);
    if (!taken) return null;
    this.buf = taken.rest;
    return taken.frame;
  }

  send(destination, body, headers = {}) {
    if (!this.connected) throw new Error('STOMP: brak polaczenia');
    this.#write('SEND', { destination, 'content-type': 'application/json;charset=utf-8', ...headers }, body);
  }

  subscribe(destination, headers = {}) {
    if (!this.connected) throw new Error('STOMP: brak polaczenia');
    const id = `sub-${this.subId += 1}`;
    this.#write('SUBSCRIBE', { id, destination, ack: 'auto', ...headers });
    return id;
  }

  disconnect() {
    this.#stopHeartbeat();
    try {
      if (this.connected) this.#write('DISCONNECT', { receipt: 'bye' });
      this.sock?.end();
    } catch { /* i tak konczymy */ }
    this.connected = false;
  }
}
