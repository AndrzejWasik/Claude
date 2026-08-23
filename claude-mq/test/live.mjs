#!/usr/bin/env node
/**
 * Diagnostyka na miejscu: czy serwer MCP wstanie z ta konfiguracja, ktora
 * naprawde lezy na dysku, i czy Claude Code ma go wpietego. Nie dotyka
 * niczego - tylko czyta i pyta.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const say = (label, state, detail = '') => console.log(`${state ? 'TAK ' : 'NIE '} ${label}${detail ? `  ${detail}` : ''}`);

// --- co lezy w konfiguracji Claude Code -------------------------------------
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const mcp = readJson(join(homedir(), '.claude.json'));
const settings = readJson(join(homedir(), '.claude', 'settings.json'));
const entry = mcp?.mcpServers?.['claude-mq'];
say('serwer MCP wpiety w ~/.claude.json', !!entry, entry ? entry.args?.[0] : '');

const hookEvents = Object.entries(settings?.hooks || {})
  .filter(([, arr]) => JSON.stringify(arr).includes('mq-hook.mjs'))
  .map(([e]) => e);
say('hooki wpiete w settings.json', hookEvents.length === 3, hookEvents.join(', ') || 'brak');

const cfgFile = join(homedir(), '.claude', 'mq', 'config.json');
const cfg = readJson(cfgFile);
say('konfiguracja magistrali istnieje', !!cfg, cfgFile);
if (cfg) {
  say('ma z kim rozmawiac', (cfg.peers || []).length > 0 || cfg.mode === 'mesh',
    cfg.mode === 'mesh' ? 'tryb mesh - lista niepotrzebna' : `peers: [${(cfg.peers || []).join(', ')}]`);
}

// --- czy serwer wstanie z ta konfiguracja -----------------------------------
const srv = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let stderr = '';
const pending = new Map();
srv.stderr.on('data', (d) => { stderr += d; });
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
  setTimeout(() => reject(new Error(`brak odpowiedzi na ${method}`)), 20000).unref();
});

try {
  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live', version: '0' } });
  say('serwer MCP startuje', init.result?.serverInfo?.name === 'claude-mq');
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc(2, 'tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  say('narzedzia zgloszone', names.length >= 5 && names.includes('mq_send') && names.includes('mq_inbox'), names.join(', '));

  const who = await rpc(3, 'tools/call', { name: 'mq_whoami', arguments: {} });
  const txt = who.result?.content?.[0]?.text || '';
  say('polaczenie z brokerem', txt.includes('polaczony') && !txt.includes('rozlaczony'));
  console.log('\n' + txt.replace(/^/gm, '     '));

  const peers = await rpc(4, 'tools/call', { name: 'mq_peers', arguments: { timeout_ms: 2000 } });
  console.log('\n' + (peers.result?.content?.[0]?.text || '').replace(/^/gm, '     '));
} finally {
  srv.kill();
}
if (stderr.trim()) console.log(`\nstderr serwera:\n${stderr.trim().replace(/^/gm, '     ')}`);
