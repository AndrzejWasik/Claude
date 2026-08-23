#!/usr/bin/env node
/**
 * Wpina wtyczke do Claude Code bez systemu wtyczek: serwer MCP do ~/.claude.json,
 * hooki do ~/.claude/settings.json. Oba pliki dostaja kopie zapasowa.
 *
 *   node install.mjs             wpina
 *   node install.mjs --remove    wypina
 *   node install.mjs --dry-run   pokazuje, co by zrobil
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const KEY = 'claude-mq';
const MCP_FILE = join(homedir(), '.claude.json');
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');

const remove = process.argv.includes('--remove');
const dryRun = process.argv.includes('--dry-run');

const HOOK_MODES = { SessionStart: 'session-start', UserPromptSubmit: 'deliver', Stop: 'stop' };
const TIMEOUTS = { SessionStart: 15, UserPromptSubmit: 15, Stop: 120 };
const hookCommand = (mode) => `node "${join(ROOT, 'hooks', 'mq-hook.mjs').replace(/\\/g, '/')}" ${mode}`;
const isOurs = (entry) => JSON.stringify(entry).includes('mq-hook.mjs');

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: nie da sie odczytac jako JSON (${err.message}). Napraw plik i sprobuj ponownie.`);
  }
}

function writeJson(file, data, preview) {
  if (dryRun) {
    console.log(`\n--- ${file} (na sucho, nie zapisane) ---`);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  if (existsSync(file)) {
    const backup = `${file}.bak-claude-mq`;
    copyFileSync(file, backup);
    console.log(`kopia zapasowa: ${backup}`);
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`zapisane: ${file}`);
}

// --- serwer MCP -------------------------------------------------------------
const mcp = readJson(MCP_FILE);
mcp.mcpServers = mcp.mcpServers || {};
if (remove) {
  if (!mcp.mcpServers[KEY]) console.log('serwer MCP: nie byl wpiety');
  delete mcp.mcpServers[KEY];
} else {
  mcp.mcpServers[KEY] = {
    type: 'stdio',
    command: 'node',
    args: [join(ROOT, 'src', 'server.mjs').replace(/\\/g, '/')],
  };
}
writeJson(MCP_FILE, mcp, { mcpServers: mcp.mcpServers });

// --- hooki ------------------------------------------------------------------
const settings = readJson(SETTINGS_FILE);
settings.hooks = settings.hooks || {};
for (const [event, mode] of Object.entries(HOOK_MODES)) {
  const kept = (settings.hooks[event] || []).filter((entry) => !isOurs(entry));
  if (remove) {
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
    continue;
  }
  settings.hooks[event] = [
    ...kept,
    { hooks: [{ type: 'command', command: hookCommand(mode), timeout: TIMEOUTS[event] }] },
  ];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
writeJson(SETTINGS_FILE, settings, { hooks: settings.hooks ?? null });

console.log(remove
  ? '\nWypiete. Zrestartuj Claude Code, zeby zmiana weszla.'
  : `\nWpiete. Zrestartuj Claude Code, zeby zmiana weszla.
Konfiguracja magistrali: ${join(homedir(), '.claude', 'mq', 'config.json')}
Sprawdzenie polaczenia:  node ${join(ROOT, 'bin', 'mq.mjs').replace(/\\/g, '/')} whoami`);

if (!remove) {
  console.log(`
Kto ma CLI "claude" w PATH, moze zamiast tego uzyc systemu wtyczek:
  claude plugin marketplace add ${ROOT.replace(/\\/g, '/')}
  claude plugin install claude-mq@miramar-local`);
}
