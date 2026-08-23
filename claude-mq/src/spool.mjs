import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 3000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Jedna pozycja czytelnego zapisu rozmowy. */
function chatLine(entry) {
  const out = entry.dir === 'out';
  const head = `${entry.ts}  ${out ? '->' : '<-'} ${out ? entry.to : entry.from}` +
    `${entry.thread ? `  [${entry.thread}]` : ''}${entry.id ? `  ${entry.id}` : ''}` +
    `${entry.app ? `  v${entry.app}` : ''}${entry.reconstructed ? '  (odtworzone)' : ''}`;
  const body = String(entry.text ?? '').replace(/\r?\n/g, '\n    ');
  return `${head}\n    ${body}\n\n`;
}

/**
 * Skrzynka na dysku. Jedyne miejsce prawdy o tym, co przyszlo i nie zostalo
 * jeszcze pokazane sesji - proces MCP dopisuje, hooki i narzedzia zdejmuja.
 */
export class Spool {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.inbox = join(dir, 'inbox.jsonl');
    this.archive = join(dir, 'archive.jsonl');
    this.chatLog = join(dir, 'chat.log');
    this.lock = join(dir, 'inbox.lock');
  }

  withLock(fn) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.lock, 'wx'));
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let age = Infinity;
        try {
          age = Date.now() - statSync(this.lock).mtimeMs;
        } catch { /* zniknal miedzy stat a proba */ }
        if (age > LOCK_STALE_MS) {
          try { unlinkSync(this.lock); } catch { /* ktos byl szybszy */ }
          continue;
        }
        if (Date.now() > deadline) throw new Error(`inbox.lock zajety od ${Math.round(age)} ms`);
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      try { unlinkSync(this.lock); } catch { /* juz zdjety */ }
    }
  }

  #readRaw() {
    if (!existsSync(this.inbox)) return [];
    const out = [];
    for (const line of readFileSync(this.inbox, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* obcieta linia po crashu */ }
    }
    return out;
  }

  /**
   * Dopisuje do trwalego zapisu rozmowy - i maszynowego, i czytelnego dla
   * czlowieka. Obie strony ruchu, bo log tylko z przychodzacych klamie.
   */
  record(msg, dir) {
    const entry = { dir, ...msg };
    this.withLock(() => {
      appendFileSync(this.archive, JSON.stringify(entry) + '\n', 'utf8');
      appendFileSync(this.chatLog, chatLine(entry), 'utf8');
    });
  }

  /**
   * Odtwarza chat.log z archiwum. Archiwum jest zapisem zrodlowym, wiec log
   * czytelny da sie zawsze zlozyc od nowa - po luce, po zmianie formatu albo
   * gdy ktos go skasuje.
   */
  rebuildChatLog() {
    const all = this.history(Number.MAX_SAFE_INTEGER);
    this.withLock(() => {
      writeFileSync(this.chatLog, all.map(chatLine).join(''), 'utf8');
    });
    return all.length;
  }

  append(msg) {
    this.withLock(() => {
      appendFileSync(this.inbox, JSON.stringify(msg) + '\n', 'utf8');
    });
    this.record(msg, 'in');
  }

  peek() {
    return this.withLock(() => this.#readRaw());
  }

  /** Zdejmuje wskazane id (albo wszystko) i zwraca to, co zdjeto. */
  take(ids = null) {
    return this.withLock(() => {
      const all = this.#readRaw();
      if (ids === null) {
        if (all.length) writeFileSync(this.inbox, '', 'utf8');
        return all;
      }
      const wanted = new Set(ids);
      const taken = all.filter((m) => wanted.has(m.id));
      if (taken.length) {
        const rest = all.filter((m) => !wanted.has(m.id));
        writeFileSync(this.inbox, rest.map((m) => JSON.stringify(m) + '\n').join(''), 'utf8');
      }
      return taken;
    });
  }

  history(limit = 50) {
    if (!existsSync(this.archive)) return [];
    // po czasie, nie po kolejnosci dopisania - wpisy uzupelnione wstecz
    // trafiaja na koniec pliku, a naleza w srodek rozmowy
    const all = readFileSync(this.archive, 'utf8').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return all.slice(-limit);
  }

  /** Czeka az cokolwiek wpadnie. Zwraca [] po uplywie czasu. */
  async waitFor(timeoutMs, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = this.peek();
      if (pending.length) return pending;
      if (Date.now() >= deadline) return [];
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
  }
}
