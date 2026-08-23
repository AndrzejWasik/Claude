#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, redactUrl } from './config.mjs';
import { APP, diskVersion } from './bus.mjs';
import { Peer } from './peer.mjs';
import { renderMessages, renderPeers, renderTranscript } from './render.mjs';

const cfg = loadConfig();
const peer = new Peer(cfg);

// stdout nalezy do protokolu MCP - diagnostyka wylacznie na stderr
const log = (...a) => console.error('[claude-mq]', ...a);
peer.bus.on('ready', () => log(`polaczony ${redactUrl(cfg.url)} jako ${cfg.name}`));
peer.bus.on('down', (err) => log(`rozlaczony: ${err?.message || 'brak polaczenia'}`));
peer.bus.on('malformed', (raw) => log(`odrzucona ramka: ${raw}`));

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function guardConnection() {
  if (peer.bus.ready) return null;
  return fail(`Broker nieosiagalny (${peer.bus.lastError || 'brak polaczenia'}). Sprawdz url w ~/.claude/mq/config.json.`);
}

const server = new McpServer({ name: 'claude-mq', version: APP });

server.registerTool('mq_whoami', {
  title: 'Kim jestem na magistrali',
  description: 'Nazwa tej sesji na magistrali, role, stan polaczenia z brokerem i liczba wiadomosci czekajacych w skrzynce.',
  inputSchema: {},
}, async () => {
  const s = peer.status();
  const lines = [
    `nazwa:      ${s.name}`,
    `wersja:     ${s.app}`,
    `etykieta:   ${s.label || '(brak - ustaw narzedziem mq_label)'}`,
    `tozsamosc:  ${s.identity === 'session' ? `sesja (${s.sessionId})` : 'maszyna'}`,
    `role:       ${s.roles.join(', ') || '-'}`,
    `tryb:       ${s.mode}${s.mode === 'pair' ? ` (kolejki nazwane od ${s.queueNaming === 'sender' ? 'nadawcy' : 'odbiorcy'})` : ''}`,
    `pisze do:   ${s.outbound || 'kolejki/tematu wyliczanego z odbiorcy'}`,
    `nasluch:    ${s.listening.join(', ') || '(nic - uzupelnij peers w config.json)'}`,
    `broker:     ${redactUrl(cfg.url)} (${s.connected ? 'polaczony' : `rozlaczony: ${s.error}`})`,
    `czeka:      ${s.pending}`,
    `wyslane/odebrane: ${s.sent}/${s.received}`,
  ];
  if (s.mode === 'pair' && !s.listening.length) {
    lines.push('', 'UWAGA: tryb pair bez wpisow w peers - ta sesja nikogo nie slucha i nie moze nic wyslac.',
      'Dopisz nazwy drugiej strony do "peers" w ~/.claude/mq/config.json.');
  }
  const onDisk = diskVersion();
  if (onDisk !== s.app) {
    lines.push('', `UWAGA: w procesie chodzi ${s.app}, a na dysku lezy ${onDisk}.`,
      'Paczke zaktualizowano bez restartu sesji. Hooki juz chodza na nowym kodzie, bo kazde',
      'zdarzenie uruchamia je od nowa z dysku; serwer MCP dopiero po restarcie Claude Code.',
      'Do tego czasu ta sama maszyna renderuje roznie zaleznie od drogi doreczenia, a pole app',
      'w wysylanych kopertach podaje wersje starsza niz repozytorium.');
  }
  if (s.identity === 'machine-fallback') {
    lines.push('', 'UWAGA: config prosi o tozsamosc per rozmowa, ale w srodowisku nie ma CLAUDE_CODE_SESSION_ID.',
      'Nazwa spadla z powrotem na nazwe maszyny, wiec dwie rownolegle rozmowy beda sobie zabierac poczte.');
  }
  return text(lines.join('\n'));
});

server.registerTool('mq_peers', {
  title: 'Kto jest na magistrali',
  description: 'Odpytuje magistrale i zwraca liste zywych sesji Claude z ich nazwami, rolami, hostem i katalogiem roboczym. Uzyj tego przed wyslaniem wiadomosci, zeby poznac poprawna nazwe odbiorcy.',
  inputSchema: { timeout_ms: z.number().int().min(200).max(10000).optional().describe('Ile czekac na odpowiedzi, domyslnie 1500') },
}, async ({ timeout_ms }) => {
  const down = guardConnection();
  if (down) return down;
  const found = await peer.peers(timeout_ms ?? 1500);
  return text(renderPeers(found, cfg.name));
});

server.registerTool('mq_send', {
  title: 'Wyslij wiadomosc do innej sesji',
  description: [
    'Wysyla tekst do innej sesji Claude. Odbiorca: nazwa sesji z mq_peers, "*" dla wszystkich,',
    'albo "role:nazwa" do wszystkich o danej roli.',
    'Z wait_for_reply=true wywolanie blokuje sie do nadejscia odpowiedzi w tym samym watku -',
    'uzywaj, gdy naprawde potrzebujesz odpowiedzi, zeby isc dalej.',
  ].join(' '),
  inputSchema: {
    to: z.string().describe('Nazwa sesji, "*" albo "role:<rola>"'),
    text: z.string().min(1).describe('Tresc wiadomosci'),
    thread: z.string().optional().describe('Id watku - podaj, gdy odpowiadasz na otrzymana wiadomosc'),
    reply_to: z.string().optional().describe('Id wiadomosci, na ktora to jest odpowiedz - przepisz z pola id odebranej ramki. Drugie wiazanie obok watku: druga strona rozpozna odpowiedz nawet wtedy, gdy watek sie zgubi'),
    wait_for_reply: z.boolean().optional().describe('Czekac na odpowiedz (domyslnie nie)'),
    timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Limit czekania, domyslnie 120000'),
  },
}, async ({ to, text: body, thread, reply_to, wait_for_reply, timeout_ms }) => {
  const down = guardConnection();
  if (down) return down;
  try {
    if (!wait_for_reply) {
      const msg = peer.send(to, body, { thread, replyTo: reply_to });
      return text(`Wyslane do ${to} (id=${msg.id}${thread ? `, thread=${thread}` : ''}${reply_to ? `, reply_to=${reply_to}` : ''}).`);
    }
    const { thread: t, reply } = await peer.ask(to, body, timeout_ms ?? 120000, thread, reply_to);
    if (!reply) return text(`Wyslane do ${to} (thread=${t}), brak odpowiedzi w zadanym czasie. Wiadomosc doszla - odpowiedz moze przyjsc pozniej do skrzynki.`);
    return text(renderMessages([reply], { header: `odpowiedz w watku ${t}` }));
  } catch (err) {
    return fail(`Nie wyslano: ${err.message}`);
  }
});

server.registerTool('mq_inbox', {
  title: 'Odbierz wiadomosci',
  description: 'Zdejmuje ze skrzynki wiadomosci, ktore przyszly od innych sesji. Z wait_ms czeka na pierwsza wiadomosc, jesli skrzynka jest pusta.',
  inputSchema: {
    wait_ms: z.number().int().min(0).max(600000).optional().describe('Ile czekac na wiadomosc, gdy skrzynka pusta (domyslnie 0)'),
    keep: z.boolean().optional().describe('Zostaw wiadomosci w skrzynce zamiast je zdejmowac'),
  },
}, async ({ wait_ms, keep }) => {
  const msgs = await peer.inbox({ waitMs: wait_ms ?? 0, keep: keep ?? false });
  if (!msgs.length) return text('Skrzynka pusta.');
  return text(renderMessages(msgs));
});

server.registerTool('mq_label', {
  title: 'Nazwij te rozmowe',
  description: 'Ustawia czytelny opis tej sesji, widoczny dla innych w mq_peers. Przydatne, gdy na jednej maszynie chodzi kilka rozmow naraz i sama nazwa ich nie odroznia. Bez argumentu pokazuje obecna etykiete.',
  inputSchema: { text: z.string().max(120).optional().describe('Krotki opis, np. "port FastReport na Delphi 13"') },
}, async ({ text: label }) => {
  if (label === undefined) return text(`Etykieta: ${cfg.label || '(brak)'}`);
  return text(`Etykieta ustawiona: "${peer.setLabel(label)}". Zobacza ja inni przy najblizszym mq_peers.`);
});

server.registerTool('mq_history', {
  title: 'Zapis rozmowy',
  description: 'Pelny zapis wymiany tej sesji z innymi - wyslane i odebrane, w kolejnosci, razem z juz przeczytanymi. Trwaly zapis lezy w chat.log obok konfiguracji.',
  inputSchema: { limit: z.number().int().min(1).max(200).optional() },
}, async ({ limit }) => {
  const msgs = peer.spool.history(limit ?? 20);
  if (!msgs.length) return text(`Brak zapisu. Plik: ${peer.spool.chatLog}`);
  return text(`${renderTranscript(msgs, cfg.name)}\nPelny zapis: ${peer.spool.chatLog}`);
});

const shutdown = async () => { await peer.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await peer.start();
await server.connect(new StdioServerTransport());
log(`gotowy jako ${cfg.name}`);
