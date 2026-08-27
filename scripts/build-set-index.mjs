/**
 * Erzeugt src/data/setIndex.json: ein reiner Textindex aller Sets mit
 *   - aufgedrucktem Set-Code (abbreviations.official)
 *   - offizieller Kartenzahl (= der Nenner, der auf der Karte steht)
 *   - Namen je Sprache
 *   - Gesamtzahl inkl. Secret Rares (aus der Zahl der Kartendateien)
 *
 * Quelle: geklontes tcgdex/cards-database. Aufruf:
 *   node scripts/build-set-index.mjs /pfad/zu/cards-database
 *
 * Das Ergebnis wird committet, damit weder App noch Build Netz brauchen.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const repo = process.argv[2] ?? '/home/user/tcgdex/cards-database';
const SUPPORTED = ['de', 'en', 'ja', 'zh-tw', 'zh-cn'];

/** Wertet die Objektliteral-Definition einer Set-Datei aus. */
function parseSetFile(file, serieId) {
  const src = readFileSync(file, 'utf8');
  // Der Variablenname wechselt je Datei (`const set:`, `const base1:` …),
  // deshalb am Typ `: Set =` ansetzen statt am Namen.
  const decl = src.match(/const\s+\w+\s*:\s*Set\s*=\s*/);
  if (!decl) return null;
  const start = src.indexOf('{', decl.index);
  const end = src.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  const body = src.slice(start, end + 1);
  try {
    // `serie: serie` zeigt auf das importierte Serien-Modul – als Kennung ersetzen
    const fn = new Function('serie', `return (${body});`);
    return fn({ id: serieId });
  } catch {
    return null;
  }
}

function walk(root, dataDir) {
  const results = [];
  const base = join(root, dataDir);
  for (const serieEntry of readdirSync(base)) {
    const seriePath = join(base, serieEntry);
    if (!statSync(seriePath).isDirectory()) continue;
    const serieId = serieEntry;
    for (const setEntry of readdirSync(seriePath)) {
      const setPath = join(seriePath, setEntry);
      if (!setEntry.endsWith('.ts')) continue;
      if (statSync(setPath).isDirectory()) continue;
      const setName = basename(setEntry, '.ts');
      const set = parseSetFile(setPath, serieId);
      if (!set?.id) continue;
      // Kartendateien im gleichnamigen Unterordner = Gesamtzahl inkl. Secrets
      let total = 0;
      const cardsDir = join(seriePath, setName);
      try {
        if (statSync(cardsDir).isDirectory()) {
          total = readdirSync(cardsDir).filter((f) => f.endsWith('.ts')).length;
        }
      } catch {
        /* Set ohne Kartenordner */
      }
      results.push({ set, serieId, total });
    }
  }
  return results;
}

const raw = [
  ...walk(repo, 'data').map((r) => ({ ...r, asia: false })),
  ...walk(repo, 'data-asia').map((r) => ({ ...r, asia: true })),
];

const sets = [];
for (const { set, serieId, total, asia } of raw) {
  const names = {};
  for (const lang of SUPPORTED) {
    if (set.name?.[lang]) names[lang] = set.name[lang];
  }
  if (Object.keys(names).length === 0) continue; // keine unterstützte Sprache
  const official = set.cardCount?.official ?? 0;
  if (!official) continue;

  const entry = {
    id: set.id,
    serie: serieId,
    official,
    total: Math.max(total, official),
    names,
  };
  const code = set.abbreviations?.official;
  if (code) {
    entry.code = String(code);
  } else if (asia) {
    // Fuer japanische/chinesische Sets pflegt TCGdex keine abbreviations.
    // Dort IST die Set-Kennung der auf der Karte gedruckte Code (SV2a, S12a).
    entry.code = String(set.id);
    entry.codeFromId = true;
  }
  // sprachspezifische Abkürzungen (z. B. fr) mitnehmen, soweit unterstützt
  const localCodes = {};
  for (const lang of SUPPORTED) {
    if (set.abbreviations?.[lang]) localCodes[lang] = String(set.abbreviations[lang]);
  }
  if (Object.keys(localCodes).length) entry.localCodes = localCodes;

  const rd = set.releaseDate;
  entry.released = typeof rd === 'string' ? rd : (rd?.en ?? rd?.ja ?? Object.values(rd ?? {})[0] ?? '');
  sets.push(entry);
}

// Der Datensatz enthaelt vereinzelt dieselbe Set-Kennung mehrfach
// (z. B. in zwei Serienordnern) — eine Kennung darf nur einmal vorkommen.
const byId = new Map();
for (const s of sets) if (!byId.has(s.id)) byId.set(s.id, s);
sets.length = 0;
sets.push(...byId.values());

sets.sort((a, b) => String(b.released).localeCompare(String(a.released)));

const withCode = sets.filter((s) => s.code).length;
const out = { generated: new Date().toISOString().slice(0, 10), sets };
mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
const path = new URL('../src/data/setIndex.json', import.meta.url);
writeFileSync(path, JSON.stringify(out));

console.log(`Sets gesamt:            ${sets.length}`);
console.log(`davon mit Set-Code:     ${withCode} (${((withCode / sets.length) * 100).toFixed(0)} %)`);
for (const lang of SUPPORTED) {
  const n = sets.filter((s) => s.names[lang]).length;
  const c = sets.filter((s) => s.names[lang] && s.code).length;
  console.log(`  ${lang.padEnd(6)} ${String(n).padStart(4)} Sets, davon ${String(c).padStart(4)} mit Code`);
}
console.log(`Dateigröße:             ${(statSync(path).size / 1024).toFixed(0)} KB`);
