#!/usr/bin/env node
/**
 * Dostarczanie poczty do sesji. Hooki nie dotykaja brokera - czytaja wylacznie
 * plik skrzynki, ktory zapelnia dlugozyjacy serwer MCP. Dzieki temu start
 * i koniec tury nie czekaja na siec i nigdy nie wywroca sesji.
 */
import { readFileSync } from 'node:fs';
import { loadConfig, sessionDir } from '../src/config.mjs';
import { Spool } from '../src/spool.mjs';
import { renderMessages } from '../src/render.mjs';

const STOP_WAIT_CAP_MS = 115000; // hooks.json daje temu hookowi 120 s

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function split(msgs, cap) {
  return msgs.length <= cap
    ? { shown: msgs, rest: 0 }
    : { shown: msgs.slice(0, cap), rest: msgs.length - cap };
}

function body(msgs, rest, cfg) {
  const parts = [renderMessages(msgs)];
  if (rest > 0) parts.push(`\n(${rest} dalszych wiadomosci czeka w skrzynce - zdejmij je narzedziem mq_inbox.)`);
  parts.push(`\nOdpowiadasz przez mq_send z tym samym thread. Twoja nazwa: ${cfg.name}.`);
  return parts.join('\n');
}

async function main() {
  const mode = process.argv[2];
  const input = readStdin();
  const cfg = loadConfig();

  // Nazwe wyliczamy z CLAUDE_CODE_SESSION_ID, a hook dostaje wlasny session_id
  // na wejsciu. Rozjazd oznaczalby, ze hook siega do innej skrzynki niz ta,
  // ktora zapelnia serwer - poczta przepadalaby po cichu.
  if (cfg.identityResolved === 'session' && input.session_id && input.session_id !== cfg.sessionId) {
    process.stderr.write(`claude-mq: session_id z hooka (${input.session_id}) rozni sie od CLAUDE_CODE_SESSION_ID (${cfg.sessionId})\n`);
  }

  const spool = new Spool(sessionDir(cfg.name));

  if (mode === 'session-start') {
    const pending = spool.peek().length;
    const lines = [`claude-mq: ta sesja nazywa sie "${cfg.name}"${cfg.roles.length ? ` (role: ${cfg.roles.join(', ')})` : ''}.`];
    lines.push('Inne sesje Claude moga do niej pisac. Liste zywych sesji da mq_peers, wyslanie mq_send.');
    if (pending) lines.push(`W skrzynce czeka ${pending} nieprzeczytanych wiadomosci.`);
    return emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join(' ') } });
  }

  if (mode === 'deliver') {
    if (!cfg.deliverOnPrompt) return emit(null);
    const pending = spool.peek();
    if (!pending.length) return emit(null);
    const { shown, rest } = split(pending, cfg.maxDeliveredPerTurn);
    spool.take(shown.map((m) => m.id));
    return emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: body(shown, rest, cfg),
      },
    });
  }

  if (mode === 'stop') {
    // stop_hook_active = juz raz zablokowalismy zakonczenie; drugi raz byloby petla
    if (!cfg.deliverOnStop || input.stop_hook_active) return emit(null);
    const wait = Math.min(cfg.waitOnStopMs || 0, STOP_WAIT_CAP_MS);
    let pending = spool.peek();
    if (!pending.length && wait > 0) pending = await spool.waitFor(wait);
    if (!pending.length) return emit(null);
    const { shown, rest } = split(pending, cfg.maxDeliveredPerTurn);
    spool.take(shown.map((m) => m.id));
    return emit({
      decision: 'block',
      reason: [
        'Zanim skonczysz ture: przyszly wiadomosci od innych sesji Claude.',
        'Zajmij sie nimi, a potem zakoncz normalnie.',
        '',
        body(shown, rest, cfg),
      ].join('\n'),
    });
  }

  process.stderr.write(`claude-mq: nieznany tryb hooka "${mode}"\n`);
  emit(null);
}

main().catch((err) => {
  process.stderr.write(`claude-mq hook: ${err.message}\n`);
  process.exit(0); // poczta nigdy nie moze zablokowac sesji
});
