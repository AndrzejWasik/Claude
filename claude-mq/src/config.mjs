import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const MQ_HOME = process.env.CLAUDE_MQ_HOME || join(homedir(), '.claude', 'mq');
export const CONFIG_FILE = join(MQ_HOME, 'config.json');

const DEFAULTS = {
  url: 'stomp://localhost:61613',
  vhost: '/',
  login: 'guest',
  passcode: 'guest',

  name: '',            // pusta = nazwa hosta
  roles: [],
  label: '',           // czytelny opis rozmowy, do pokazania w mq_peers

  // machine - jedna nazwa na komputer; dwie rownolegle sesje wchodza sobie w droge
  // session - osobna nazwa na kazda rozmowe, wyliczana z identyfikatora sesji
  identity: 'machine',

  mode: 'pair',        // pair = trwale kolejki, mesh = temat dla wielu sesji
  peers: [],           // z kim rozmawiamy w trybie pair
  queueNaming: 'sender', // sender = kolejka nazwana od nadawcy, recipient = od odbiorcy

  prefix: 'claude',
  heartbeatMs: 10000,
  autoAck: true,       // potwierdzaj odbior natychmiast po odebraniu ramki
  ackWaitMs: 8000,     // ile mq_send czeka na to potwierdzenie, zanim odpowie
  deliverOnPrompt: true,
  deliverOnStop: true,
  waitOnStopMs: 0,
  maxDeliveredPerTurn: 20,
};

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 60);
}

/** Krotki, stabilny sufiks z identyfikatora sesji. */
export function sessionSuffix(sessionId) {
  return String(sessionId).replace(/-/g, '').slice(0, 6);
}

export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json: ${err.message}`);
  }
  const cfg = { ...DEFAULTS, ...stored };
  if (stored.peer !== undefined && stored.peers === undefined) cfg.peers = stored.peer; // wygodny alias na jednego rozmowce
  if (process.env.CLAUDE_MQ_URL) cfg.url = process.env.CLAUDE_MQ_URL;
  if (process.env.CLAUDE_MQ_NAME) cfg.name = process.env.CLAUDE_MQ_NAME;
  if (process.env.CLAUDE_MQ_ROLES) cfg.roles = process.env.CLAUDE_MQ_ROLES.split(',');
  if (process.env.CLAUDE_MQ_PEERS) cfg.peers = process.env.CLAUDE_MQ_PEERS.split(',');
  if (process.env.CLAUDE_MQ_MODE) cfg.mode = process.env.CLAUDE_MQ_MODE;
  if (process.env.CLAUDE_MQ_IDENTITY) cfg.identity = process.env.CLAUDE_MQ_IDENTITY;
  if (process.env.CLAUDE_MQ_LABEL) cfg.label = process.env.CLAUDE_MQ_LABEL;

  if (cfg.identity !== 'machine' && cfg.identity !== 'session') throw new Error(`config.json: identity musi byc "machine" albo "session", jest "${cfg.identity}"`);

  // Ten sam identyfikator widza serwer MCP i hooki - oba sa procesami potomnymi
  // Claude Code i dziedzicza jego srodowisko. Dzieki temu wyliczaja te sama
  // nazwe bez zadnego uzgadniania miedzy soba.
  cfg.sessionId = process.env.CLAUDE_CODE_SESSION_ID || '';
  const base = slug(cfg.name || hostname());
  if (cfg.identity === 'session' && cfg.sessionId) {
    cfg.name = `${base}-${sessionSuffix(cfg.sessionId)}`;
    cfg.identityResolved = 'session';
    // nazw sesji nie da sie wpisac do peers z gory, wiec adresowanie musi byc
    // wyszukiwane, a nie skonfigurowane - chyba ze ktos jawnie chce inaczej
    if (stored.mode === undefined && !process.env.CLAUDE_MQ_MODE) cfg.mode = 'mesh';
  } else {
    cfg.name = base;
    cfg.identityResolved = cfg.identity === 'session' ? 'machine-fallback' : 'machine';
  }

  cfg.label = String(cfg.label || '').trim().slice(0, 120);
  cfg.roles = asList(cfg.roles);
  cfg.peers = asList(cfg.peers).filter((p) => p !== cfg.name);
  if (cfg.mode !== 'pair' && cfg.mode !== 'mesh') throw new Error(`config.json: mode musi byc "pair" albo "mesh", jest "${cfg.mode}"`);
  if (cfg.queueNaming !== 'sender' && cfg.queueNaming !== 'recipient') throw new Error(`config.json: queueNaming musi byc "sender" albo "recipient", jest "${cfg.queueNaming}"`);
  return cfg;
}

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(slug).filter(Boolean);
}

export function peersDir() {
  const dir = join(MQ_HOME, 'peers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionDir(name) {
  const dir = join(peersDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function redactUrl(url) {
  return String(url).replace(/\/\/[^@/]*@/, '//***@');
}
