// Erzeugt src/data/speciesEn.json: Pokédex-Nummer -> englischer Spezies-Name.
// Quelle: offizielles PokeAPI-Datenrepo (CSV). Wird gebraucht, um für Karten
// aus japanischen/chinesischen Sets (die in TCGdex keine englischen Namen
// haben) einen englischen Namen fürs Cardmarket-Matching zu synthetisieren.
// Einmal ausführen und das JSON committen: node scripts/fetch-species-names.mjs
import { writeFileSync } from 'node:fs';

const CSV_URL = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv';
const res = await fetch(CSV_URL);
if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
const csv = await res.text();

const names = {};
for (const line of csv.split('\n').slice(1)) {
  // Format: pokemon_species_id,local_language_id,name,genus — Namen enthalten keine Kommas
  const [id, langId, name] = line.split(',');
  if (langId === '9' && id && name) names[id] = name;
}

const count = Object.keys(names).length;
if (count < 1000) throw new Error(`Nur ${count} Namen gefunden — CSV-Format geändert?`);
writeFileSync(new URL('../src/data/speciesEn.json', import.meta.url), JSON.stringify(names) + '\n');
console.log(`src/data/speciesEn.json: ${count} Namen`);
