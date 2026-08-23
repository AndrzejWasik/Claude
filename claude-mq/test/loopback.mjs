#!/usr/bin/env node
/**
 * Test przeciwko prawdziwemu brokerowi. Dwie sesje w jednym procesie, oba tryby.
 * Bierze dane logowania z ~/.claude/mq/config.json, wlasnych kolejek uzywa pod
 * prefiksem "claudetest", zeby nie mieszac sie do ruchu produkcyjnego.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME_BACKUP = process.env.CLAUDE_MQ_HOME;
const { loadConfig, redactUrl } = await import('../src/config.mjs');
const broker = loadConfig();

process.env.CLAUDE_MQ_HOME = mkdtempSync(join(tmpdir(), 'claude-mq-loop-'));
const { Peer } = await import('../src/peer.mjs');

const base = {
  url: process.argv[2] || broker.url,
  vhost: broker.vhost,
  login: broker.login,
  passcode: broker.passcode,
  prefix: 'claudetest',
  heartbeatMs: 10000,
};

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'OK  ' : 'BLAD'} ${label}${cond ? '' : ` -> ${detail}`}`);
};
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function scenario(mode, queueNaming = 'sender') {
  console.log(`\n=== tryb ${mode}${mode === 'pair' ? `, kolejki od ${queueNaming === 'sender' ? 'nadawcy' : 'odbiorcy'}` : ''} ===`);
  const a = new Peer({ ...base, mode, queueNaming, name: 'loop-a', roles: ['builder'], peers: mode === 'pair' ? ['loop-b'] : [] });
  const b = new Peer({ ...base, mode, queueNaming, name: 'loop-b', roles: ['builder', 'tester'], peers: mode === 'pair' ? ['loop-a'] : [] });
  try {
    await a.start();
    await b.start();
    ok('a polaczone', a.bus.ready, a.bus.lastError);
    ok('b polaczone', b.bus.ready, b.bus.lastError);
    if (!a.bus.ready || !b.bus.ready) return;

    a.send('loop-b', 'czesc z a, zażółć gęślą jaźń');
    await settle();
    let got = await b.inbox({});
    ok('wiadomosc wprost dochodzi', got.length === 1 && got[0].text === 'czesc z a, zażółć gęślą jaźń', JSON.stringify(got));
    ok('nadawca sie zgadza', got[0]?.from === 'loop-a');
    ok('nadawca nie dostaje wlasnej kopii', (await a.inbox({})).length === 0);

    const peers = await a.peers(1500);
    ok('a widzi b', peers.some((p) => p.from === 'loop-b'), JSON.stringify(peers));
    ok('a nie widzi samego siebie', !peers.some((p) => p.from === 'loop-a'));
    ok('role przychodza w pongu', !!peers.find((p) => p.from === 'loop-b')?.roles?.includes('tester'));

    a.send('*', 'do wszystkich');
    await settle();
    ok('broadcast dochodzi', (await b.inbox({})).length === 1);

    a.send('role:tester', 'tylko dla testerow');
    await settle();
    ok('routing po roli dziala', (await b.inbox({})).length === 1);

    a.send('nie-istnieje', 'nie dla b');
    await settle();
    ok('cudza poczta jest odfiltrowana', (await b.inbox({})).length === 0);

    const onAsk = (m) => { if (m.text === 'ile to 2+2?') b.send(m.from, '4', { thread: m.thread, replyTo: m.id }); };
    b.bus.on('message', onAsk);
    const { reply, thread } = await a.ask('loop-b', 'ile to 2+2?', 10000);
    ok('odpowiedz wraca do pytajacego', reply?.text === '4', JSON.stringify(reply));
    ok('watek sie zgadza', reply?.thread === thread);
    ok('odpowiedz nie zostaje w skrzynce', a.spool.peek().length === 0);
    b.bus.off('message', onAsk);
    await b.inbox({});

    // regresja: ask generowal wlasny watek i gubil ten podany przez wolajacego,
    // przez co nie dalo sie czekac na odpowiedz w toczacej sie rozmowie
    const onThread = (m) => { if (m.text === 'kontynuacja') b.send(m.from, 'ten sam watek', { thread: m.thread }); };
    b.bus.on('message', onThread);
    const cont = await a.ask('loop-b', 'kontynuacja', 10000, 't-jawny01');
    ok('ask zachowuje podany watek', cont.thread === 't-jawny01' && cont.sent.thread === 't-jawny01', String(cont.sent?.thread));
    ok('odpowiedz w podanym watku wraca', cont.reply?.text === 'ten sam watek', JSON.stringify(cont.reply));
    b.bus.off('message', onThread);
    await b.inbox({});

    // odpowiadajacy moze zamiast watku wskazac id wiadomosci - te tez ma zlapac
    const onReplyTo = (m) => { if (m.text === 'po reply_to') b.send(m.from, 'trafione', { replyTo: m.id }); };
    b.bus.on('message', onReplyTo);
    const byId = await a.ask('loop-b', 'po reply_to', 10000);
    ok('odpowiedz po samym reply_to trafia do czekajacego', byId.reply?.text === 'trafione', JSON.stringify(byId.reply));
    b.bus.off('message', onReplyTo);
    await b.inbox({});

    setTimeout(() => a.send('loop-b', 'spozniona'), 800);
    const waited = await b.inbox({ waitMs: 6000 });
    ok('inbox z wait_ms lapie spozniona wiadomosc', waited.length === 1 && waited[0].text === 'spozniona', JSON.stringify(waited));
  } catch (err) {
    failed += 1;
    console.log(`BLAD ${err.message}`);
  } finally {
    await a.close();
    await b.close();
  }
}

async function offlineDelivery() {
  console.log('\n=== pair: wiadomosc do spiacej sesji ===');
  const a = new Peer({ ...base, mode: 'pair', queueNaming: 'sender', name: 'loop-a', roles: [], peers: ['loop-b'] });
  await a.start();
  if (!a.bus.ready) { failed += 1; console.log(`BLAD brak polaczenia: ${a.bus.lastError}`); return; }
  a.send('loop-b', 'czekaj na mnie');
  await settle(500);
  await a.close();

  const b = new Peer({ ...base, mode: 'pair', queueNaming: 'sender', name: 'loop-b', roles: [], peers: ['loop-a'] });
  await b.start();
  const got = await b.inbox({ waitMs: 5000 });
  ok('trwala kolejka doreczyla po powrocie', got.length === 1 && got[0].text === 'czekaj na mnie', JSON.stringify(got));
  await b.close();
}

async function cleanup() {
  const u = new URL(base.url);
  const api = `http://${u.hostname}:15672/api/queues/${encodeURIComponent(base.vhost)}/`;
  const auth = 'Basic ' + Buffer.from(`${base.login}:${base.passcode}`).toString('base64');
  for (const q of ['claudetest.loop-a', 'claudetest.loop-b']) {
    try {
      const res = await fetch(api + encodeURIComponent(q), { method: 'DELETE', headers: { authorization: auth } });
      const hint = res.status === 401 ? ' (uzytkownik bez tagu management - skasuj kolejke recznie w panelu)' : '';
      console.log(`sprzatanie ${q}: HTTP ${res.status}${hint}`);
    } catch (err) {
      console.log(`sprzatanie ${q}: ${err.message} (usun recznie w panelu, jesli zostala)`);
    }
  }
}

console.log(`broker ${redactUrl(base.url)} vhost=${base.vhost}`);
await scenario('pair', 'sender');
await scenario('pair', 'recipient');
await scenario('mesh');
await offlineDelivery();
await cleanup();

rmSync(process.env.CLAUDE_MQ_HOME, { recursive: true, force: true });
if (HOME_BACKUP) process.env.CLAUDE_MQ_HOME = HOME_BACKUP;
console.log(failed ? `\n${failed} testow nie przeszlo` : '\nwszystko OK');
// bez process.exit - natychmiastowe wyjscie po fetch wywala asercje libuv na Windows
process.exitCode = failed ? 1 : 0;
