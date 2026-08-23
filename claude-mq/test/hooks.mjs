#!/usr/bin/env node
/** Test hookow: co dokladnie trafia na stdout w kazdym z trzech trybow. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'claude-mq-hooks-'));
process.env.CLAUDE_MQ_HOME = HOME;
process.env.CLAUDE_MQ_NAME = 'tester';

const { loadConfig, sessionDir } = await import('../src/config.mjs');
const { Spool } = await import('../src/spool.mjs');
const spool = new Spool(sessionDir(loadConfig().name));

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'OK  ' : 'BLAD'} ${label}${cond ? '' : ` -> ${detail}`}`);
};

function runHook(mode, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'hooks', 'mq-hook.mjs'), mode], {
      env: { ...process.env, CLAUDE_MQ_HOME: HOME, CLAUDE_MQ_NAME: 'tester' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(input));
  });
}

const msg = (id, text) => ({ id, type: 'msg', from: 'dev-d13', to: 'tester', ts: '2026-08-23T09:00:00Z', thread: 't-1', text });

// session-start na pustej skrzynce
let r = await runHook('session-start', { hook_event_name: 'SessionStart', session_id: 's1' });
ok('session-start konczy sie zerem', r.code === 0, `code=${r.code} ${r.err}`);
ok('session-start podaje nazwe', JSON.parse(r.out).hookSpecificOutput.additionalContext.includes('"tester"'), r.out);

// deliver na pustej skrzynce - cisza
r = await runHook('deliver', { hook_event_name: 'UserPromptSubmit', prompt: 'czesc' });
ok('deliver bez poczty nic nie wypisuje', r.out === '', r.out);

// deliver z poczta
spool.append(msg('m-1', 'skonczylem frx.inc'));
r = await runHook('deliver', { hook_event_name: 'UserPromptSubmit', prompt: 'czesc' });
const delivered = JSON.parse(r.out);
ok('deliver zwraca additionalContext', delivered.hookSpecificOutput.hookEventName === 'UserPromptSubmit', r.out);
ok('deliver niesie tresc', delivered.hookSpecificOutput.additionalContext.includes('skonczylem frx.inc'));
ok('deliver oproznia skrzynke', spool.peek().length === 0);

// stop z poczta -> blokada
spool.append(msg('m-2', 'mam lecieć dalej?'));
r = await runHook('stop', { hook_event_name: 'Stop', stop_hook_active: false });
const stopped = JSON.parse(r.out);
ok('stop blokuje zakonczenie tury', stopped.decision === 'block', r.out);
ok('stop niesie tresc', stopped.reason.includes('mam lecieć dalej?'));
ok('stop oproznia skrzynke', spool.peek().length === 0);

// stop przy stop_hook_active -> zadnej blokady, inaczej petla
spool.append(msg('m-3', 'i jeszcze jedno'));
r = await runHook('stop', { hook_event_name: 'Stop', stop_hook_active: true });
ok('stop_hook_active nie blokuje drugi raz', r.out === '', r.out);
ok('wiadomosc zostaje na nastepna ture', spool.peek().length === 1);

// smieci na wejsciu nie moga wywrocic hooka
r = await runHook('deliver', { });
ok('brak pol na wejsciu nie jest bledem', r.code === 0, `code=${r.code} ${r.err}`);

// --- tozsamosc per rozmowa --------------------------------------------------
// Hook i serwer musza trafic do tej samej skrzynki, licząc nazwe niezaleznie
// od siebie. Inaczej poczta przepada po cichu.
const SID = 'babd9c4f-2eb1-47c3-8342-ff25d443118a';
process.env.CLAUDE_MQ_IDENTITY = 'session';
process.env.CLAUDE_CODE_SESSION_ID = SID;
const perSesja = loadConfig();
const spoolSesji = new Spool(sessionDir(perSesja.name));
ok('nazwa sesyjna wyliczona', perSesja.name === 'tester-babd9c', perSesja.name);

spoolSesji.append(msg('m-s1', 'poczta do rozmowy, nie do maszyny'));
r = await runHook('deliver', { hook_event_name: 'UserPromptSubmit', session_id: SID });
ok('hook trafia do skrzynki tej rozmowy', (r.out || '').includes('poczta do rozmowy'), r.out || r.err);
ok('skrzynka rozmowy oprozniona', spoolSesji.peek().length === 0);
ok('zgodny session_id nie wywoluje ostrzezenia', !r.err.includes('rozni sie'), r.err);

spoolSesji.append(msg('m-s2', 'druga'));
r = await runHook('deliver', { hook_event_name: 'UserPromptSubmit', session_id: 'zupelnie-inny-id' });
ok('rozjazd session_id jest zglaszany na stderr', r.err.includes('rozni sie'), r.err);
ok('mimo ostrzezenia poczta jest doreczona', (r.out || '').includes('druga'), r.out);

delete process.env.CLAUDE_MQ_IDENTITY;

rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n${failed} testow nie przeszlo` : '\nwszystko OK');
process.exit(failed ? 1 : 0);
