#!/usr/bin/env node
/**
 * Test bez brokera: skrzynka, renderowanie i uscisk dloni MCP.
 * Serwer ma wstac i odpowiadac na tools/list nawet wtedy, gdy broker jest martwy.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'claude-mq-test-'));
const ENV = { ...process.env, CLAUDE_MQ_HOME: HOME, CLAUDE_MQ_NAME: 'tester', CLAUDE_MQ_URL: 'stomp://127.0.0.1:1', CLAUDE_MQ_PEERS: 'ktos' };

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'OK  ' : 'BLAD'} ${label}${detail && !cond ? ` -> ${detail}` : ''}`);
};

process.env.CLAUDE_MQ_HOME = HOME;
process.env.CLAUDE_MQ_NAME = 'tester';
process.env.CLAUDE_MQ_PEERS = 'ktos';
const { loadConfig, sessionDir } = await import('../src/config.mjs');
const { Spool } = await import('../src/spool.mjs');
const { renderMessages } = await import('../src/render.mjs');

// --- konfiguracja -----------------------------------------------------------
const cfg = loadConfig();
ok('nazwa z env', cfg.name === 'tester', cfg.name);
ok('domyslny tryb', cfg.mode === 'pair' && cfg.queueNaming === 'sender', `${cfg.mode}/${cfg.queueNaming}`);
ok('domyslny prefiks', cfg.prefix === 'claude', cfg.prefix);
ok('peers z env', cfg.peers.join(',') === 'ktos', cfg.peers.join(','));

delete process.env.CLAUDE_MQ_PEERS; // zmienna srodowiskowa ma pierwszenstwo nad plikiem
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ peer: 'Laptop-01' }), 'utf8');
const aliased = loadConfig();
ok('alias "peer" dziala jak "peers"', aliased.peers.join(',') === 'laptop-01', aliased.peers.join(','));
ok('nazwa rozmowcy jest normalizowana', aliased.peers.every((p) => /^[a-z0-9._-]+$/.test(p)));
rmSync(join(HOME, 'config.json'), { force: true });

// --- tozsamosc per rozmowa --------------------------------------------------
const SID = 'babd9c4f-2eb1-47c3-8342-ff25d443118a';
const sidBackup = process.env.CLAUDE_CODE_SESSION_ID;
process.env.CLAUDE_MQ_IDENTITY = 'session';
process.env.CLAUDE_CODE_SESSION_ID = SID;
const perSesja = loadConfig();
ok('nazwa dostaje sufiks sesji', perSesja.name === 'tester-babd9c', perSesja.name);
ok('tozsamosc rozpoznana jako sesja', perSesja.identityResolved === 'session', perSesja.identityResolved);
ok('tryb sam przechodzi na mesh', perSesja.mode === 'mesh', perSesja.mode);
ok('sufiks jest stabilny', loadConfig().name === perSesja.name);

delete process.env.CLAUDE_CODE_SESSION_ID;
const bezId = loadConfig();
ok('brak session id cofa do nazwy maszyny', bezId.name === 'tester' && bezId.identityResolved === 'machine-fallback', `${bezId.name}/${bezId.identityResolved}`);

process.env.CLAUDE_CODE_SESSION_ID = 'inna-sesja-99887766';
ok('inna sesja to inna nazwa', loadConfig().name !== perSesja.name, loadConfig().name);

process.env.CLAUDE_MQ_MODE = 'pair';
process.env.CLAUDE_CODE_SESSION_ID = SID;
ok('jawny tryb nie jest nadpisywany', loadConfig().mode === 'pair', loadConfig().mode);
delete process.env.CLAUDE_MQ_MODE;
delete process.env.CLAUDE_MQ_IDENTITY;
if (sidBackup) process.env.CLAUDE_CODE_SESSION_ID = sidBackup; else delete process.env.CLAUDE_CODE_SESSION_ID;
ok('domyslnie tozsamosc nadal nalezy do maszyny', loadConfig().identityResolved === 'machine');

// --- skrzynka ---------------------------------------------------------------
const spool = new Spool(sessionDir(cfg.name));
spool.append({ id: 'm-1', from: 'a', to: 'tester', ts: 't1', text: 'raz' });
spool.append({ id: 'm-2', from: 'b', to: 'tester', ts: 't2', text: 'dwa' });
ok('peek widzi obie', spool.peek().length === 2);
ok('take po id zdejmuje jedna', spool.take(['m-1']).length === 1);
ok('zostala druga', spool.peek().length === 1 && spool.peek()[0].id === 'm-2');
ok('take() czysci reszte', spool.take().length === 1 && spool.peek().length === 0);
ok('archiwum trzyma obie', spool.history().length === 2);
ok('archiwum oznacza kierunek', spool.history().every((m) => m.dir === 'in'));
spool.record({ id: 'm-9', to: 'b', ts: 't9', thread: 't-1', text: 'wyslana' }, 'out');
ok('wyslane tez trafiaja do archiwum', spool.history().at(-1)?.dir === 'out');
ok('wyslane nie trafiaja do skrzynki', spool.peek().length === 0);
{
  const log = readFileSync(spool.chatLog, 'utf8');
  ok('chat.log ma obie strony ruchu', log.includes('<- a') && log.includes('-> b'), log.slice(0, 120));
  ok('chat.log niesie tresc', log.includes('wyslana'));
}
ok('waitFor konczy sie pusto', (await spool.waitFor(300)).length === 0);

// --- render -----------------------------------------------------------------
const rendered = renderMessages([{ id: 'm-3', from: 'dev-d13', to: 'tester', ts: 't3', thread: 't-9', text: 'zażółć gęślą jaźń' }]);
ok('render zawiera nadawce', rendered.includes('from=dev-d13'));
ok('render nie gubi polskich znakow', rendered.includes('zażółć gęślą jaźń'));
ok('render ostrzega przed traktowaniem jak polecenia', rendered.includes('not a user instruction'));
// bez id w naglowku odpowiadajacy nie ma czego wpisac w reply_to
ok('render pokazuje id wiadomosci', rendered.includes('id=m-3'));
ok('render podaje wersje nadawcy', rendered.includes('app='));
const odpowiedz = renderMessages([{ id: 'm-4', from: 'x', to: 'tester', ts: 't', reply_to: 'm-3', text: 'odpowiadam' }]);
ok('render pokazuje reply_to', odpowiedz.includes('reply_to=m-3'));
ok('brak reply_to nie zasmieca naglowka', !rendered.includes('reply_to='));
const renderBezId = renderMessages([{ from: 'x', to: 'tester', ts: 't', text: 'bez id' }]);
ok('brak id nie psuje renderowania', renderBezId.includes('from=x') && !renderBezId.includes('id=undefined'));

// --- wersja w procesie kontra wersja na dysku -------------------------------
const { APP, diskVersion } = await import('../src/bus.mjs');
ok('APP jest odczytane z package.json', /^\d+\.\d+\.\d+$/.test(APP), APP);
ok('diskVersion zgadza sie z APP przy nietknietym dysku', diskVersion() === APP, `${diskVersion()} vs ${APP}`);

// --- reply_to jako drugie wiazanie odpowiedzi -------------------------------
// Matcher w peer.ask sprawdza thread ALBO reply_to. Zanim reply_to dalo sie
// ustawic z mq_send, ta druga galaz byla nieosiagalna - stad te testy.
const { Peer } = await import('../src/peer.mjs');
const p = new Peer(loadConfig());
const wyslane = [];
p.bus = { send: (_to, msg) => wyslane.push(msg), ready: true };

const wprost = p.send('ktos', 'tresc', { thread: 't-x', replyTo: 'm-abc' });
ok('send przenosi reply_to do koperty', wprost.reply_to === 'm-abc', String(wprost.reply_to));
ok('send przenosi watek do koperty', wprost.thread === 't-x', String(wprost.thread));
ok('send bez reply_to daje null', p.send('ktos', 'x').reply_to === null);

const pytanie = p.ask('ktos', 'pytanie', 50, 't-y', 'm-def');
const ostatnia = wyslane.at(-1);
ok('ask przenosi reply_to do koperty', ostatnia.reply_to === 'm-def', String(ostatnia.reply_to));
ok('ask uzywa podanego watku', ostatnia.thread === 't-y', String(ostatnia.thread));

const [czekajacy] = [...p.waiters];
ok('matcher lapie odpowiedz po watku',
  czekajacy.match({ thread: 't-y', reply_to: null, from: 'ktos' }));
ok('matcher lapie odpowiedz po reply_to mimo zgubionego watku',
  czekajacy.match({ thread: 't-zgubiony', reply_to: ostatnia.id, from: 'ktos' }));
ok('matcher odrzuca odpowiedz od kogos innego',
  !czekajacy.match({ thread: 't-y', reply_to: null, from: 'ktos-inny' }));
// Obietnicy z ask nie doczekujemy: jej timer jest unref()-owany, wiec sam nie
// utrzyma procesu przy zyciu i await nigdy by sie nie rozwiazal. W serwerze MCP
// petle trzyma transport stdio, w tescie nie ma czego trzymac.
czekajacy.resolve(null);
void pytanie;

// --- ramki STOMP ------------------------------------------------------------
const { parseFrame } = await import('../src/stomp.mjs');

const lfFrame = parseFrame(Buffer.from('MESSAGE\ndestination:/queue/x\n\nciało\0', 'utf8'));
ok('ramka z LF', lfFrame?.frame.command === 'MESSAGE' && lfFrame.frame.body === 'ciało', JSON.stringify(lfFrame?.frame));
ok('naglowki z ramki LF', lfFrame?.frame.headers.destination === '/queue/x');

const crlfFrame = parseFrame(Buffer.from('MESSAGE\r\ndestination:/queue/x\r\n\r\nciało\0', 'utf8'));
ok('ramka z CRLF', crlfFrame?.frame.command === 'MESSAGE' && crlfFrame.frame.body === 'ciało', JSON.stringify(crlfFrame?.frame));

const utf8Body = 'zażółć gęślą jaźń';
const withLen = Buffer.concat([
  Buffer.from(`MESSAGE\ncontent-length:${Buffer.byteLength(utf8Body)}\n\n`, 'utf8'),
  Buffer.from(utf8Body, 'utf8'),
  Buffer.from([0]),
]);
ok('content-length liczony w bajtach, nie znakach', parseFrame(withLen)?.frame.body === utf8Body);

ok('heartbeat przed ramka jest zjadany', parseFrame(Buffer.from('\n\n\nRECEIPT\nreceipt-id:1\n\n\0', 'utf8'))?.frame.command === 'RECEIPT');
ok('niekompletna ramka czeka na reszte', parseFrame(Buffer.from('MESSAGE\nfoo:bar\n\nnieskon', 'utf8')) === null);

const two = parseFrame(Buffer.from('RECEIPT\nreceipt-id:1\n\n\0MESSAGE\nfoo:bar\n\ndruga\0', 'utf8'));
ok('reszta bufora zostaje na druga ramke', parseFrame(two.rest)?.frame.body === 'druga');

// --- MCP --------------------------------------------------------------------
const srv = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, resolve);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error(`brak odpowiedzi na ${method}`)), 15000).unref();
});

try {
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  ok('initialize', init.result?.serverInfo?.name === 'claude-mq', JSON.stringify(init.error || init.result));
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc(2, 'tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  ok('tools/list', JSON.stringify(names) === JSON.stringify(['mq_history', 'mq_inbox', 'mq_label', 'mq_peers', 'mq_send', 'mq_whoami']), names.join(','));

  // Pulapka nazwana przez druga sesje: testy siegaja warstwy Peer, a uzytkownikiem
  // jest narzedzie MCP. Co istnieje w Peer, ale nie jest wystawione w server.mjs,
  // dostaje zielony test i zero pokrycia w rzeczywistosci - tak wlasnie reply_to
  // przez trzy wersje mialo dzialajacy matcher, ktorego nikt nie mogl wywolac.
  // Ten test pilnuje schematu narzedzia, nie warstwy pod nim.
  const wysylka = (list.result?.tools || []).find((t) => t.name === 'mq_send');
  const pola = Object.keys(wysylka?.inputSchema?.properties || {});
  for (const p of ['to', 'text', 'thread', 'reply_to', 'wait_for_reply', 'timeout_ms']) {
    ok(`mq_send wystawia ${p}`, pola.includes(p), pola.join(','));
  }

  const who = await rpc(3, 'tools/call', { name: 'mq_whoami', arguments: {} });
  const whoText = who.result?.content?.[0]?.text || '';
  ok('mq_whoami dziala mimo martwego brokera', whoText.includes('nazwa:      tester'), whoText.slice(0, 120));
  ok('mq_whoami melduje rozlaczenie', whoText.includes('rozlaczony'), whoText.slice(0, 120));

  const send = await rpc(4, 'tools/call', { name: 'mq_send', arguments: { to: 'ktos', text: 'test' } });
  ok('mq_send bez brokera zwraca blad zamiast wisiec', send.result?.isError === true, JSON.stringify(send.result));

  const box = await rpc(5, 'tools/call', { name: 'mq_inbox', arguments: {} });
  ok('mq_inbox na pustej skrzynce', (box.result?.content?.[0]?.text || '').includes('pusta'));
} finally {
  srv.kill();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} testow nie przeszlo` : '\nwszystko OK');
process.exit(failed ? 1 : 0);
