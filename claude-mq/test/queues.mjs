#!/usr/bin/env node
/**
 * Zaglada do kolejek przez panel zarzadzania: ile wiadomosci czeka i ilu jest
 * konsumentow. Rozstrzyga, czy wiadomosc nie wyszla, czy tylko nie zostala
 * jeszcze przeczytana po drugiej stronie. Wymaga konta z tagiem management.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const prefix = cfg.prefix || 'claude';
const names = [cfg.name, ...cfg.peers, ...process.argv.slice(2)];

const u = new URL(cfg.url);
const auth = 'Basic ' + Buffer.from(`${cfg.login}:${cfg.passcode}`).toString('base64');

for (const n of [...new Set(names)]) {
  const queue = `${prefix}.${n}`;
  const url = `http://${u.hostname}:15672/api/queues/${encodeURIComponent(cfg.vhost)}/${encodeURIComponent(queue)}`;
  try {
    const res = await fetch(url, { headers: { authorization: auth } });
    if (res.status === 401) { console.log(`${queue}: HTTP 401 - konto ${cfg.login} nie ma tagu management`); continue; }
    if (res.status === 404) { console.log(`${queue}: nie istnieje`); continue; }
    if (!res.ok) { console.log(`${queue}: HTTP ${res.status}`); continue; }
    const q = await res.json();
    console.log(`${queue}: czeka=${q.messages}  konsumentow=${q.consumers}  trwala=${q.durable}`);
  } catch (err) {
    console.log(`${queue}: ${err.message}`);
  }
}
