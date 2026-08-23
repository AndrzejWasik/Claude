#!/usr/bin/env node
/**
 * Czy ktokolwiek czyta moja kolejke wyjsciowa?
 *
 * Podglada ja z ack:client i nigdy nie potwierdza odbioru - po rozlaczeniu
 * broker wklada wszystko z powrotem, wiec nic nie ginie. Co znajdzie, to
 * dowod, ze druga strona kolejki nie slucha: gdyby sluchala, byloby pusto.
 */
import { Stomp } from '../src/stomp.mjs';
import { loadConfig, redactUrl } from '../src/config.mjs';

const cfg = loadConfig();
const queue = `/queue/${cfg.prefix || 'claude'}.${cfg.name}`;
const waitMs = Number(process.argv[2]) || 3000;

const c = new Stomp(cfg);
c.on('error', (err) => console.error(`blad: ${err.message}`));

console.log(`${redactUrl(cfg.url)} vhost=${cfg.vhost}`);
console.log(`podglad ${queue} przez ${waitMs} ms, bez potwierdzania odbioru\n`);
await c.connect();

const found = [];
c.on('message', (frame) => {
  try {
    const m = JSON.parse(frame.body);
    found.push(m);
    console.log(`[${m.ts}] ${m.from} -> ${m.to}${m.thread ? ` (${m.thread})` : ''}`);
    console.log(`  ${String(m.text || '').split('\n')[0].slice(0, 100)}`);
  } catch {
    console.log(`  ramka nie-JSON: ${frame.body.slice(0, 80)}`);
  }
});

c.subscribe(queue, { ack: 'client' });
await new Promise((r) => setTimeout(r, waitMs));
c.disconnect(); // bez ACK - broker requeue'uje

console.log(found.length
  ? `\n${found.length} wiadomosci lezy nieodebranych - druga strona NIE slucha tej kolejki.
Sprawdz u niej "nasluch" w mq_whoami: ma tam byc ${queue}.
Wiadomosci wrocily do kolejki, nic nie przepadlo.`
  : `\nKolejka pusta - wszystko, co wyslano, zostalo juz zdjete przez druga strone.
Jesli mimo to nie ma odpowiedzi, wiadomosc lezy w skrzynce tamtej sesji
i czeka, az ta sesja wykona ture.`);

setTimeout(() => process.exit(0), 300).unref();
