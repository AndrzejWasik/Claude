#!/usr/bin/env node
/**
 * Buduje paczke do przeniesienia na inna maszyne. Wklada zaleznosci do srodka,
 * zeby instalacja nie wymagala dostepu do npm, i dokleja broker.json z danymi
 * logowania wyjetymi z lokalnej konfiguracji.
 *
 *   node pack.mjs                    paczka bez hasla - podaje sie je przy instalacji
 *   node pack.mjs --with-credentials wklada dane z ~/.claude/mq/config.json do srodka
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DIST = join(ROOT, 'dist');
// staging poza drzewem projektu - cpSync odmawia kopiowania katalogu w glab
// samego siebie
const STAGE = mkdtempSync(join(tmpdir(), 'claude-mq-pack-'));
const PKG = join(STAGE, 'claude-mq');
const ZIP = join(DIST, `claude-mq-${version}.zip`);

// domyslnie bez hasla - paczka wedruje przez udzialy sieciowe i nosniki
const withCredentials = process.argv.includes('--with-credentials');

// katalogi i pliki, ktore nie maja prawa trafic do paczki
const SKIP = new Set(['dist', '.git', '.gitignore']);
const skipFile = (name) => name.endsWith('.bak-claude-mq') || name === 'broker.json';

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
mkdirSync(PKG, { recursive: true });

cpSync(ROOT, PKG, {
  recursive: true,
  filter: (src) => {
    const rel = relative(ROOT, src);
    if (!rel) return true;
    const [head] = rel.split(sep);
    if (SKIP.has(head)) return false;
    return !skipFile(rel.split(sep).pop());
  },
});

// --- dane brokera -----------------------------------------------------------
const localConfig = join(homedir(), '.claude', 'mq', 'config.json');
// puste pola, zeby setup.mjs upomnial sie o kazde z nich zamiast po cichu
// przyjac domyslny vhost
let broker = { url: '', vhost: '', login: '', passcode: '' };
if (withCredentials && existsSync(localConfig)) {
  const c = JSON.parse(readFileSync(localConfig, 'utf8'));
  broker = { url: c.url, vhost: c.vhost, login: c.login, passcode: c.passcode };
  console.log(`dane brokera wziete z ${localConfig}`);
} else {
  console.log('paczka bez danych logowania - podaje sie je flagami przy setup.mjs');
}
writeFileSync(join(PKG, 'broker.json'), JSON.stringify(broker, null, 2) + '\n', 'utf8');

// --- zip --------------------------------------------------------------------
const ps = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${PKG}' -DestinationPath '${ZIP}' -CompressionLevel Optimal -Force`,
], { encoding: 'utf8' });
if (ps.status !== 0) {
  console.error(ps.stderr || ps.stdout);
  process.exit(1);
}
rmSync(STAGE, { recursive: true, force: true });

const mb = (statSync(ZIP).size / 1024 / 1024).toFixed(1);
console.log(`\ngotowe: ${ZIP} (${mb} MB)`);
console.log(withCredentials
  ? 'Paczka zawiera haslo do brokera otwartym tekstem - przenies ja kanalem, ktoremu ufasz.'
  : 'Paczka nie zawiera hasla.');
