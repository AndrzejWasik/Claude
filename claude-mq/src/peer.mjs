import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, Bus, envelope } from './bus.mjs';
import { Spool } from './spool.mjs';
import { sessionDir } from './config.mjs';

/**
 * Jedna sesja na magistrali: polaczenie + skrzynka + oczekiwania na odpowiedz.
 * Uzywane tak samo przez serwer MCP i przez CLI.
 */
export class Peer {
  constructor(cfg) {
    this.cfg = cfg;
    const dir = sessionDir(cfg.name);
    this.spool = new Spool(dir);
    this.labelFile = join(dir, 'label.txt');
    if (!process.env.CLAUDE_MQ_LABEL) {
      try {
        const stored = readFileSync(this.labelFile, 'utf8').trim();
        if (stored) cfg.label = stored.slice(0, 120);
      } catch { /* etykiety nie ustawiono */ }
    }
    this.bus = new Bus(cfg);
    this.waiters = new Set();
    this.pongBuckets = new Map();
    this.received = 0;
    this.sent = 0;
  }

  async start() {
    this.bus.on('message', (msg) => this.#onMessage(msg));
    this.bus.on('pong', (msg) => this.pongBuckets.get(msg.corr)?.push(msg));
    await this.bus.start();
    return this;
  }

  #onMessage(msg) {
    this.received += 1;
    this.spool.append(msg);
    for (const w of this.waiters) {
      if (!w.match(msg)) continue;
      this.waiters.delete(w);
      this.spool.take([msg.id]); // odpowiedz idzie do tego, kto czekal, nie do skrzynki
      w.resolve(msg);
    }
  }

  /** Czytelny opis rozmowy, do odroznienia sesji na tej samej maszynie. */
  setLabel(text) {
    const clean = String(text || '').trim().slice(0, 120);
    this.cfg.label = clean;
    writeFileSync(this.labelFile, `${clean}\n`, 'utf8');
    return clean;
  }

  status() {
    return {
      name: this.cfg.name,
      app: APP,
      label: this.cfg.label,
      identity: this.cfg.identityResolved,
      sessionId: this.cfg.sessionId,
      roles: this.cfg.roles,
      mode: this.cfg.mode,
      queueNaming: this.cfg.queueNaming,
      outbound: this.bus.outbound,
      listening: this.bus.subscriptions,
      connected: this.bus.ready,
      error: this.bus.lastError,
      pending: this.spool.peek().length,
      sent: this.sent,
      received: this.received,
    };
  }

  async peers(timeoutMs = 1500) {
    const corr = `p-${randomUUID().slice(0, 8)}`;
    const bucket = [];
    this.pongBuckets.set(corr, bucket);
    this.bus.ping(envelope({ type: 'ping', from: this.cfg.name, to: '*', corr }));
    await new Promise((r) => setTimeout(r, timeoutMs));
    this.pongBuckets.delete(corr);
    const seen = new Set();
    return bucket.filter((p) => !seen.has(p.from) && seen.add(p.from));
  }

  send(to, text, opts = {}) {
    const msg = envelope({
      type: 'msg',
      from: this.cfg.name,
      to,
      text,
      thread: opts.thread || null,
      reply_to: opts.replyTo || null,
      cwd: process.cwd(),
    });
    this.bus.send(to, msg);
    this.spool.record(msg, 'out');
    this.sent += 1;
    return msg;
  }

  /**
   * Wysyla i czeka na odpowiedz. Bez podanego watku zaklada nowy; z podanym
   * kontynuuje istniejacy, zeby dalo sie czekac na odpowiedz w toczacej sie
   * rozmowie, a nie tylko zaczynac nowa.
   */
  async ask(to, text, timeoutMs = 120000, thread = null, replyTo = null) {
    const t = thread || `t-${randomUUID().slice(0, 8)}`;
    const sent = this.send(to, text, { thread: t, replyTo });
    return new Promise((resolve) => {
      const waiter = {
        // watek albo jawne wskazanie na te wiadomosc - odpowiadajacy moze trafic
        // dowolnym z dwoch, wiec zgubiony thread po tamtej stronie nie blokuje
        match: (m) => (m.thread === t || m.reply_to === sent.id) && (to === '*' || m.from === to),
        resolve,
      };
      this.waiters.add(waiter);
      const timer = setTimeout(() => { this.waiters.delete(waiter); resolve(null); }, timeoutMs);
      timer.unref?.();
    }).then((reply) => ({ sent, thread: t, reply }));
  }

  async inbox({ waitMs = 0, keep = false } = {}) {
    let pending = this.spool.peek();
    if (!pending.length && waitMs > 0) pending = await this.spool.waitFor(waitMs);
    if (!pending.length) return [];
    return keep ? pending : this.spool.take(pending.map((m) => m.id));
  }

  async close() {
    await this.bus.close();
  }
}
