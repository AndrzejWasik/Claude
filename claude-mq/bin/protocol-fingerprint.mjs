#!/usr/bin/env node
/**
 * Odcisk PROTOCOL.md, punkt po punkcie. Punkt 16 czyni plik zrodlem prawdy
 * i kaze rozstrzygac rozbieznosci przez porownanie plikow - a pliki po obu
 * stronach nie musza byc identyczne co do bajtu, bo kazda strona moze dopisac
 * wlasne notatki. Porownuje sie wiec tresc normatywna, nie caly plik.
 *
 * Normalizacja, do odtworzenia w dowolnym jezyku:
 *   1. podziel plik na sekcje zaczynajace sie od "## <numer>. <tytul>",
 *   2. wez tresc sekcji do nastepnego naglowka "## " albo linii "---",
 *   3. zloz znaki diakrytyczne: NFD, usun U+0300-U+036F, dodatkowo l/L za l/L
 *      (kreslone L nie rozklada sie w NFD), potem NFC,
 *   4. male litery, kazdy ciag bialych znakow na jedna spacje, obetnij,
 *   5. sha256, pierwsze 8 znakow szesnastkowych,
 *   6. skrot calosci: sha256 z linii "<numer>:<odcisk>" zlaczonych "\n",
 *      w kolejnosci rosnacych numerow, znowu pierwsze 8 znakow.
 *
 * Uwaga na to, czego ten pomiar NIE rozstrzyga. Zgodne odciski dowodza, ze
 * tresc jest identyczna. Rozbiezne nie dowodza niczego o zgodnosci zasad, bo
 * ta sama regula napisana niezaleznie dwoma zdaniami da dwa rozne skroty.
 * Do rownowaznosci sluzy porownanie zdan normatywnych, nie skrotow.
 *
 *   node bin/protocol-fingerprint.mjs [sciezka]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), 'PROTOCOL.md');
const text = readFileSync(file, 'utf8');

// "naglowek" i "nagłówek" maja znaczyc to samo: jedna strona moze pisac bez
// ogonkow. NFD rozklada o z kreska, ale nie l - to trzeba podmienic wprost.
const fold = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ł/g, 'l').replace(/Ł/g, 'L')
  .normalize('NFC');

const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const digest = (s) => sha8(fold(s).toLowerCase().replace(/\s+/g, ' ').trim());

const lines = text.split(/\r?\n/);
const points = [];
let current = null;
for (const line of lines) {
  const head = /^## (\d+)\.\s+(.+)$/.exec(line);
  if (head) {
    current = { nr: Number(head[1]), title: head[2].trim(), body: [] };
    points.push(current);
    continue;
  }
  if (!current) continue;
  if (/^## /.test(line) || /^---\s*$/.test(line)) { current = null; continue; }
  current.body.push(line);
}

const version = (/^#\s*(CMQ\/\d+)/m.exec(text) || [])[1] || 'brak';
console.log(`plik     ${file}`);
console.log(`wersja   ${version}`);
console.log(`punktow  ${points.length}`);
console.log('');
for (const p of points) {
  console.log(`${String(p.nr).padStart(2)}. ${digest(p.body.join('\n'))}  ${p.title}`);
}
console.log('');
const skladnik = points.map((p) => `${p.nr}:${digest(p.body.join('\n'))}`).join('\n');
console.log(`calosc normatywna: ${sha8(skladnik)}`);
console.log('');
console.log('Zgodne odciski dowodza identycznosci tresci. Rozbiezne nie dowodza roznicy zasad -');
console.log('ta sama regula napisana niezaleznie da inny skrot. Do rownowaznosci porownuje sie zdania.');
