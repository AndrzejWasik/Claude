import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stomp } from './stomp.mjs';

const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

const PKG = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json');

function readVersion() {
  try {
    return JSON.parse(readFileSync(PKG, 'utf8')).version;
  } catch {
    return 'nieznana';
  }
}

// wersja wtyczki jedzie w kazdej kopercie - bez tego nie da sie odroznic
// rozmowcy z poprawka od rozmowcy sprzed niej, a serwer zyje tyle co sesja.
// Czytana raz, przy starcie procesu: ma opisywac kod zaladowany do pamieci.
export const APP = readVersion();

// Wersja lezaca na dysku w tej chwili. Rozna od APP znaczy, ze paczke
// zaktualizowano bez restartu sesji - a wtedy hooki juz chodza na nowym kodzie
// (kazde zdarzenie to nowy proces), serwer MCP jeszcze na starym. Ten sam host
// potrafi wtedy renderowac roznie w zaleznosci od drogi doreczenia.
export function diskVersion() {
  return readVersion();
}

export function envelope(fields) {
  return {
    v: 1,
    app: APP,
    id: `m-${randomUUID().slice(0, 8)}`,
    ts: new Date().toISOString(),
    host: hostname(),
    ...fields,
  };
}

/**
 * Topologia na brokerze. Dwa tryby:
 *
 *   pair  - kazda sesja pisze wylacznie do wlasnej kolejki /queue/claude.<ja>,
 *           a sluchacie kolejek wymienionych w peers. Kolejka jest trwala, wiec
 *           wiadomosc wyslana do spiacej sesji czeka na jej powrot.
 *           Uwaga: kolejke moze czytac tylko jeden odbiorca - dwoch dzieli
 *           wiadomosci po rowno zamiast dostac obie kopie.
 *
 *   mesh  - ruch idzie przez amq.topic kluczami claude.mesh.<od>.<do>, a kazdy
 *           subskrybent dostaje wlasna tymczasowa kolejke. Skaluje sie na wiele
 *           sesji, ale nic nie czeka na sesje offline.
 *
 * Obecnosc (ping/pong) chodzi zawsze przez amq.topic, niezaleznie od trybu.
 */
export class Bus extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.stomp = null;
    this.ready = false;
    this.attempt = 0;
    this.lastError = null;
    this.closing = false;
  }

  get prefix() { return this.cfg.prefix || 'claude'; }

  get outbound() {
    if (this.cfg.mode !== 'pair') return null;
    if (this.cfg.queueNaming === 'recipient') return null; // rozne dla kazdego odbiorcy
    return `/queue/${this.prefix}.${this.cfg.name}`;
  }

  /** Czego sluchamy - do pokazania w mq_whoami i w CLI. */
  get subscriptions() {
    const { cfg } = this;
    if (cfg.mode === 'pair') {
      return cfg.queueNaming === 'recipient'
        ? [`/queue/${this.prefix}.${cfg.name}`]
        : cfg.peers.map((p) => `/queue/${this.prefix}.${p}`);
    }
    return [
      `/topic/${this.prefix}.mesh.*.${cfg.name}`,
      `/topic/${this.prefix}.mesh.*.all`,
      ...cfg.roles.map((r) => `/topic/${this.prefix}.mesh.*.role-${r}`),
    ];
  }

  async start() {
    try {
      await this.#open();
      this.attempt = 0;
      this.ready = true;
      this.lastError = null;
      this.emit('ready');
    } catch (err) {
      this.ready = false;
      this.lastError = err.message;
      this.emit('down', err);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry() {
    if (this.closing) return;
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.start(), delay);
    this.retryTimer.unref?.();
  }

  async #open() {
    const { cfg } = this;
    const c = new Stomp(cfg);
    c.on('error', (err) => { this.lastError = err.message; });
    c.on('close', () => {
      if (!this.ready) return;
      this.ready = false;
      this.emit('down', new Error(this.lastError || 'polaczenie zamkniete'));
      this.#scheduleRetry();
    });
    c.on('message', (frame) => this.#onFrame(frame));

    await c.connect();
    this.stomp = c;

    for (const dest of this.subscriptions) c.subscribe(dest);
    c.subscribe(`/topic/${this.prefix}.presence.ping`);
    c.subscribe(`/topic/${this.prefix}.presence.pong.${cfg.name}`);
  }

  #forMe(msg) {
    const { cfg } = this;
    if (!msg.to || msg.to === '*' || msg.to === cfg.name) return true;
    if (msg.to.startsWith('role:')) return cfg.roles.includes(msg.to.slice(5));
    return false; // adresowane do kogos innego, a wpadlo do wspolnego strumienia
  }

  #onFrame(frame) {
    let msg;
    try {
      msg = JSON.parse(frame.body);
    } catch {
      this.emit('malformed', frame.body.slice(0, 200));
      return;
    }
    if (msg.from === this.cfg.name) return;
    if (msg.type === 'ping') {
      this.#publish(`/topic/${this.prefix}.presence.pong.${msg.from}`, envelope({
        type: 'pong',
        from: this.cfg.name,
        to: msg.from,
        corr: msg.corr,
        roles: this.cfg.roles,
        mode: this.cfg.mode,
        identity: this.cfg.identityResolved,
        label: this.cfg.label, // cfg jest wspoldzielony, wiec zmiana etykiety w locie tu widac
        cwd: process.cwd(),
      }));
      return;
    }
    if (msg.type === 'pong') { this.emit('pong', msg); return; }
    // potwierdzenie odbioru nie jest tresc dla rozmowy - nie trafia ani do
    // skrzynki, ani do kontekstu; interesuje wylacznie nadawce
    if (msg.type === 'ack') { this.emit('ack', msg); return; }
    // Do rozmowy wpuszczamy wylacznie to, co jest tresc. Kazdy typ dolozony
    // w przyszlosci trafilby inaczej do skrzynki jako wiadomosc bez tekstu -
    // dokladnie to zrobilyby ramki ack stronie sprzed 0.3.0.
    if (msg.type !== 'msg') { this.emit('unknownType', msg); return; }
    if (!this.#forMe(msg)) return;
    this.emit('message', msg);
  }

  /**
   * Potwierdzenie odbioru. Nie moze wywrocic odbierania wiadomosci, wiec brak
   * konfiguracji albo brak polaczenia tylko je pomija - odebrana tresc jest
   * wazniejsza od potwierdzenia, ze dotarla.
   */
  sendAck(to, msg) {
    if (this.cfg.mode === 'pair' && !this.cfg.peers.length) return false;
    if (!this.stomp?.connected) return false;
    for (const dest of this.#routes(to)) this.#publish(dest, msg);
    return true;
  }

  #publish(destination, msg, headers = {}) {
    if (!this.stomp?.connected) throw new Error(`brak polaczenia z brokerem (${this.lastError || 'nie wystartowalo'})`);
    this.stomp.send(destination, JSON.stringify(msg), headers);
  }

  #routes(to) {
    const { cfg } = this;
    if (cfg.mode === 'mesh') {
      const slot = to === '*' ? 'all' : to.startsWith('role:') ? `role-${to.slice(5)}` : to;
      return [`/topic/${this.prefix}.mesh.${cfg.name}.${slot}`];
    }
    if (cfg.queueNaming === 'recipient') {
      // nazwa kolejki od odbiorcy - do wielu naraz trzeba wlozyc kopie do kazdej
      const targets = to === '*' || to.startsWith('role:') ? cfg.peers : [to];
      return targets.map((t) => `/queue/${this.prefix}.${t}`);
    }
    return [this.outbound];
  }

  send(to, msg) {
    if (this.cfg.mode === 'pair' && !this.cfg.peers.length) {
      throw new Error('tryb pair bez ani jednego wpisu w peers - nie ma kto tego odebrac; uzupelnij config.json');
    }
    const headers = this.cfg.mode === 'pair' ? { persistent: 'true' } : {};
    for (const dest of this.#routes(to)) this.#publish(dest, msg, headers);
  }

  broadcast(msg) { this.send('*', msg); }
  sendRole(role, msg) { this.send(`role:${role}`, msg); }

  ping(msg) {
    this.#publish(`/topic/${this.prefix}.presence.ping`, msg);
  }

  async close() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    this.stomp?.disconnect();
    this.ready = false;
  }
}
