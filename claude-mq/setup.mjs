#!/usr/bin/env node
/**
 * Instalacja na nowej maszynie. Robi wszystko po kolei: sprawdza Node, dociaga
 * zaleznosci jesli ich brak, zapisuje konfiguracje magistrali, wpina serwer i
 * hooki do Claude Code i na koniec sprawdza polaczenie z brokerem.
 *
 *   node setup.mjs --peer dev-d13
 *   node setup.mjs --name laptop --peer dev-d13,serwer
 *   node setup.mjs --mode mesh
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MQ_HOME = process.env.CLAUDE_MQ_HOME || join(homedir(), '.claude', 'mq');
const CONFIG = join(MQ_HOME, 'config.json');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const step = (n, txt) => console.log(`\n[${n}/5] ${txt}`);
const die = (msg) => { console.error(`\nBLAD: ${msg}`); process.exit(1); };

if (has('help')) {
  console.log(`Instalacja claude-mq

  --url <adres>     stomp://host:port brokera
  --vhost <nazwa>   wirtualny host na brokerze
  --login <nazwa>   uzytkownik
  --passcode <...>  haslo
  --name <nazwa>    nazwa tej sesji na magistrali (domyslnie nazwa hosta: ${hostname().toLowerCase()})
  --peer <nazwy>    z kim rozmawiamy, po przecinku (tryb pair)
  --mode pair|mesh  pair = trwale kolejki dla dwoch stron, mesh = temat dla wielu
  --force           nadpisz istniejaca konfiguracje magistrali
  --no-install      nie wpinaj do Claude Code, tylko przygotuj konfiguracje

Dane brokera mozna tez wpisac raz do pliku broker.json obok tego skryptu -
wtedy wystarczy samo --peer.`);
  process.exit(0);
}

// --- 1. Node ----------------------------------------------------------------
step(1, 'Sprawdzanie Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) die(`potrzebny Node 20 lub nowszy, jest ${process.versions.node}. Pobierz z https://nodejs.org/en/download`);
console.log(`      Node ${process.versions.node} - OK`);

// --- 2. zaleznosci ----------------------------------------------------------
step(2, 'Sprawdzanie zaleznosci');
if (existsSync(join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
  console.log('      node_modules na miejscu - OK');
} else {
  console.log('      brak node_modules, uruchamiam npm install (potrzebny dostep do sieci)');
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (npm.status !== 0) die('npm install nie przeszlo. Skopiuj katalog node_modules z maszyny, na ktorej wtyczka juz dziala.');
}

// --- 3. konfiguracja magistrali ---------------------------------------------
step(3, 'Konfiguracja magistrali');
const brokerFile = join(ROOT, 'broker.json');
const broker = existsSync(brokerFile) ? JSON.parse(readFileSync(brokerFile, 'utf8')) : {};
for (const key of ['url', 'vhost', 'login', 'passcode']) {
  const given = flag(key);
  if (given) broker[key] = given;
}
const missing = ['url', 'vhost', 'login', 'passcode'].filter((k) => !broker[k] || broker[k].startsWith?.('stomp://host'));
if (missing.length) {
  die(`brak danych brokera: ${missing.join(', ')}.
Podaj je w wywolaniu:
  node setup.mjs --url stomp://host:port --vhost NAZWA --login UZYTKOWNIK --passcode HASLO --peer ${flag('peer') || 'nazwa-drugiej-maszyny'}
albo wpisz raz do pliku ${brokerFile}:
  { "url": "stomp://host:port", "vhost": "...", "login": "...", "passcode": "..." }`);
}

const name = (flag('name') || hostname()).toLowerCase();
const peers = (flag('peer') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const mode = flag('mode') || 'pair';
if (mode !== 'pair' && mode !== 'mesh') die(`--mode musi byc "pair" albo "mesh", podano "${mode}"`);

if (existsSync(CONFIG) && !has('force')) {
  console.log(`      ${CONFIG} juz istnieje - zostawiam bez zmian (--force nadpisze)`);
} else {
  mkdirSync(MQ_HOME, { recursive: true });
  if (existsSync(CONFIG)) {
    copyFileSync(CONFIG, `${CONFIG}.bak-claude-mq`);
    console.log(`      kopia zapasowa: ${CONFIG}.bak-claude-mq`);
  }
  writeFileSync(CONFIG, JSON.stringify({
    url: broker.url,
    vhost: broker.vhost,
    login: broker.login,
    passcode: broker.passcode,
    name,
    roles: [],
    mode,
    peers,
    deliverOnPrompt: true,
    deliverOnStop: true,
    waitOnStopMs: 0,
  }, null, 2) + '\n', 'utf8');
  console.log(`      zapisane: ${CONFIG}`);
  console.log(`      nazwa tej sesji: ${name}`);
  console.log(`      tryb: ${mode}${mode === 'pair' ? `, rozmowcy: ${peers.join(', ') || '(brak - uzupelnij recznie)'}` : ''}`);
}

// --- 4. wpiecie do Claude Code ----------------------------------------------
step(4, 'Wpinanie do Claude Code');
if (has('no-install')) {
  console.log('      pominiete (--no-install)');
} else {
  const res = spawnSync(process.execPath, [join(ROOT, 'install.mjs')], { stdio: 'inherit' });
  if (res.status !== 0) die('install.mjs nie przeszlo');
}

// --- 5. sprawdzenie polaczenia ----------------------------------------------
step(5, 'Sprawdzanie polaczenia z brokerem');
const check = spawnSync(process.execPath, [join(ROOT, 'bin', 'mq.mjs'), 'whoami'], { encoding: 'utf8' });
process.stdout.write((check.stdout || '').replace(/^/gm, '      '));
if (check.status !== 0) {
  console.log(`      ${(check.stderr || '').trim()}`);
  console.log('      Polaczenie nie doszlo do skutku. Sprawdz, czy z tej maszyny widac broker:');
  const u = new URL(broker.url);
  console.log(`      Test-NetConnection ${u.hostname} -Port ${u.port}`);
}

console.log(`
Gotowe. Zrestartuj Claude Code, zeby wtyczka sie zaladowala.

Na drugiej maszynie dopisz te nazwe do listy rozmowcow w ~/.claude/mq/config.json:
  "peers": ["${name}"]

Podglad z linii polecen:
  node "${join(ROOT, 'bin', 'mq.mjs')}" peers
  node "${join(ROOT, 'bin', 'mq.mjs')}" send <nazwa> "test"`);
