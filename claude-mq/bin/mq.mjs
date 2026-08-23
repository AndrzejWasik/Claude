#!/usr/bin/env node
/**
 * CLI do magistrali. Robi dokladnie to samo co narzedzia MCP, tylko z powloki -
 * sluzy do sprawdzenia konfiguracji i do podgladania ruchu bez odpalania sesji.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { CONFIG_FILE, MQ_HOME, loadConfig, redactUrl, sessionDir, peersDir } from '../src/config.mjs';
import { Peer } from '../src/peer.mjs';
import { Spool } from '../src/spool.mjs';
import { renderPeers, renderTranscript } from '../src/render.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`claude-mq

  mq init [stomp://host:61613]             zapisz szkielet konfiguracji
  mq whoami                                nazwa, kolejka, stan polaczenia
  mq peers [ms]                            kto jest na magistrali
  mq send <do|*|role:x> <tresc...>         wyslij i wyjdz
  mq ask  <do> <tresc...>                  wyslij i czekaj na odpowiedz (120 s)
  mq recv [ms]                             zdejmij skrzynke, opcjonalnie poczekaj
  mq log [n]                               zapis rozmowy: wyslane i odebrane
  mq log rebuild                           zloz chat.log od nowa z archiwum
  mq log all [n]                           zapis ze wszystkich rozmow na tej maszynie
  mq listen                                nasluchuj i wypisuj na biezaco (Ctrl+C konczy)

Konfiguracja: ${CONFIG_FILE}
Nadpisania:   CLAUDE_MQ_URL, CLAUDE_MQ_NAME, CLAUDE_MQ_ROLES`);
}

function doInit(url) {
  mkdirSync(MQ_HOME, { recursive: true });
  if (existsSync(CONFIG_FILE)) {
    console.log(`Juz istnieje: ${CONFIG_FILE}`);
    return;
  }
  const skeleton = {
    url: url || 'stomp://localhost:61613',
    vhost: '/',
    login: 'guest',
    passcode: 'guest',
    name: '',
    roles: [],
    mode: 'pair',
    peers: [],
    deliverOnPrompt: true,
    deliverOnStop: true,
    waitOnStopMs: 0,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
  console.log(`Zapisane: ${CONFIG_FILE}`);
  console.log('Pusta nazwa = nazwa hosta. Na dwie sesje na jednej maszynie ustaw CLAUDE_MQ_NAME.');
}

function line(m) {
  const tag = m.to === '*' ? 'broadcast' : m.thread || 'direct';
  return `[${m.ts}] ${m.from} -> ${m.to} (${tag})\n  ${String(m.text || '').replace(/\n/g, '\n  ')}`;
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') return usage();
  if (cmd === 'init') return doInit(rest[0]);

  if (cmd === 'log') {
    // czyta z dysku, brokera nie rusza
    const local = loadConfig();
    const spool = new Spool(sessionDir(local.name));
    if (rest[0] === 'rebuild') {
      console.log(`chat.log zlozony od nowa z archiwum: ${spool.rebuildChatLog()} wpisow`);
      console.log(spool.chatLog);
      return;
    }
    if (rest[0] === 'all') {
      // przy tozsamosci per rozmowa kazda sesja ma wlasny katalog i wlasny zapis
      const sesje = readdirSync(peersDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      const merged = sesje
        .flatMap((n) => new Spool(sessionDir(n)).history(Number.MAX_SAFE_INTEGER).map((m) => ({ ...m, sesja: n })))
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      console.log(renderTranscript(merged.slice(-(Number(rest[1]) || 50)), `wszystkie sesje: ${sesje.join(', ')}`));
      return;
    }
    console.log(renderTranscript(spool.history(Number(rest[0]) || 50), local.name));
    console.log(`Pelny zapis: ${spool.chatLog}`);
    return;
  }

  const cfg = loadConfig();
  const peer = new Peer(cfg);
  peer.bus.on('down', (err) => console.error(`broker: ${err?.message || 'rozlaczony'}`));
  await peer.start();

  const bye = async (code = 0) => { await peer.close(); process.exit(code); };

  if (cmd === 'whoami') {
    const s = peer.status();
    console.log(`nazwa    ${s.name}`);
    console.log(`wersja   ${s.app}`);
    console.log(`etykieta ${s.label || '(brak)'}`);
    console.log(`tozsam.  ${s.identity === 'session' ? `sesja (${s.sessionId})` : 'maszyna'}`);
    console.log(`role     ${s.roles.join(', ') || '-'}`);
    console.log(`tryb     ${s.mode}${s.mode === 'pair' ? ` (kolejki od ${s.queueNaming === 'sender' ? 'nadawcy' : 'odbiorcy'})` : ''}`);
    console.log(`pisze do ${s.outbound || 'kolejki/tematu wyliczanego z odbiorcy'}`);
    console.log(`nasluch  ${s.listening.join(', ') || '(nic)'}`);
    console.log(`broker   ${redactUrl(cfg.url)} ${s.connected ? 'OK' : `BLAD: ${s.error}`}`);
    console.log(`czeka    ${s.pending}`);
    if (s.mode === 'pair' && !s.listening.length) console.log('UWAGA    tryb pair bez wpisow w peers');
    return bye(s.connected ? 0 : 1);
  }

  if (!peer.bus.ready) {
    console.error(`Brak polaczenia z ${redactUrl(cfg.url)}: ${peer.bus.lastError}`);
    return bye(1);
  }

  if (cmd === 'peers') {
    console.log(renderPeers(await peer.peers(Number(rest[0]) || 1500), cfg.name));
    return bye();
  }

  if (cmd === 'send') {
    const [to, ...words] = rest;
    if (!to || !words.length) { usage(); return bye(2); }
    const msg = peer.send(to, words.join(' '));
    console.log(`wyslane id=${msg.id} do ${to}`);
    await new Promise((r) => setTimeout(r, 200)); // niech ramka zdazy wyjsc
    return bye();
  }

  if (cmd === 'ask') {
    const [to, ...words] = rest;
    if (!to || !words.length) { usage(); return bye(2); }
    const { thread, reply } = await peer.ask(to, words.join(' '));
    if (!reply) { console.error(`brak odpowiedzi w watku ${thread}`); return bye(1); }
    console.log(line(reply));
    return bye();
  }

  if (cmd === 'recv') {
    const msgs = await peer.inbox({ waitMs: Number(rest[0]) || 0 });
    if (!msgs.length) console.log('skrzynka pusta');
    for (const m of msgs) console.log(line(m));
    return bye();
  }

  if (cmd === 'listen') {
    console.log(`nasluch jako ${cfg.name} na ${redactUrl(cfg.url)}, Ctrl+C konczy`);
    for (const m of await peer.inbox({})) console.log(line(m));
    peer.bus.on('message', (m) => { peer.spool.take([m.id]); console.log(line(m)); });
    process.on('SIGINT', () => bye());
    return;
  }

  usage();
  return bye(2);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
