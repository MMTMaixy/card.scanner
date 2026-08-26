# Plan & Architektur — Pokémon-Karten-Scanner (PWA)

Dieses Dokument ist der Plan, dem die Implementierung folgt. Es hält auch die
Recherche-Ergebnisse fest, die du explizit nicht geraten haben wolltest.
Alles liegt auf dem Branch `claude/pokemon-card-scanner-pwa-tki8ry` — jeder
Meilenstein ist ein eigener Commit, damit du einzeln prüfen und zurückrollen
kannst.

---

## Recherche-Ergebnisse (verifiziert, nicht geraten)

### 1. CSV-Format der Extension `cardmarket-bulk-import`

Quelle: Quellcode des Repos (`src/utils/csv.ts`, `src/entrypoints/injectedButton.content/game-manager/managers/generic.ts` und `mtg.ts`) sowie `docs/test/test_eoe.csv`.

* Die Extension parst eine **CSV mit Header-Zeile** (Komma-getrennt, Quotes
  nach RFC — `csv-parse` mit `columns: true`). Es gibt **kein festes
  Spaltenschema**: Beim Import ordnest du im Extension-UI die Spalten den
  Feldern zu (Fuzzy-Vorschlag anhand der Header-Namen). Zusätzliche Spalten
  stören nicht — sie bleiben einfach unzugeordnet.
* Felder für **alle Spiele** (also auch Pokémon): `name` (Pflicht),
  `language`, `condition`, `isSigned`, `comment`, `quantity`, `price`.
* **Zustands-Werte** (aus der offiziellen Test-CSV): `mint`, `near_mint`,
  `excellent`, `good`, `light_played`, `played`, `poor`.
* **Sprach-Werte**: `en`, `fr`, `de`, `es`, `it`, `ja`.
* **Matching**: Die Extension füllt das "List bulk items"-Formular, indem sie
  die `name`-Spalte gegen die im Formular angezeigten Kartennamen matcht
  (normalisierter Vergleich; auch gegen den daneben angezeigten übersetzten
  Namen; sonst Substring-Fallback). **Es gibt keine Sammlernummern-Spalte.**
  Du wählst auf Cardmarket vorher das Set als Filter — genau unser
  Batch-Workflow.
* ⚠️ **Ehrliche Einschränkung**: Nur Magic hat in der Extension einen
  eigenen Manager mit Foil-Feld. Für Pokémon wird der generische Manager
  benutzt — die Extension setzt also **kein Reverse-Holo-Häkchen** im
  Formular. Konsequenz für den Workflow:
  * Die App exportiert **getrennte Dateien pro Set + Finish** (max. 100 Zeilen).
  * Bei einer Reverse-Holo-Datei musst du nach dem Befüllen die
    Reverse-Häkchen im Cardmarket-Formular von Hand setzen (die Datei enthält
    nur Reverse-Karten, also: alle Häkchen der befüllten Zeilen). Die App
    zeigt beim Export einen entsprechenden Hinweis an.
  * Alternative wäre ein Pokémon-Manager-PR an die Extension — außerhalb des
    Scopes, aber im README notiert.
* Cardmarket nimmt max. **100 Artikel pro Formular** (im README der
  Extension bestätigt) → automatischer Split in 100er-Dateien.

### 2. Kartendatenbank: TCGdex vs. Pokémon TCG API

**Entscheidung: TCGdex** (`api.tcgdex.net`). Begründung:

| Kriterium | TCGdex | pokemontcg.io |
|---|---|---|
| Kostenlos | ✅ ohne API-Key | ⚠️ API-Key nötig, Rate-Limits |
| Deutsche Kartennamen | ✅ vollwertige `de`-Lokalisierung | ❌ nur Englisch |
| Finishes pro Karte | ✅ explizites Feld `variants: { normal, reverse, holo, firstEdition }` pro Karte (überschreibt Set-Default); Sets tragen zusätzlich Zähler `cardCount.normal/reverse/holo` | ❌ kein explizites Feld — nur indirekt über TCGPlayer-Preiskategorien (US-Markt, unzuverlässig) |
| Kartenbilder | ✅ `assets.tcgdex.net`, webp in low/high | ✅ |

Das `variants`-Feld ist im TCGdex-Datenmodell verifiziert (SDK-Typdefinitionen
und Server-Quellcode von `tcgdex/cards-database`). Damit ist die
Plausibilitätsprüfung sauber möglich. Einschränkung, offen gesagt: TCGdex ist
community-gepflegt — einzelne Karten können falsche Variants-Daten haben.
Darum blockt die gelbe Markierung nie hart: du kannst per Tap korrigieren
**oder** bewusst übersteuern ("trotzdem so exportieren").

* Set-Liste: `GET /v2/{lang}/sets` (klein, wird gecacht).
* Karten eines Sets **mit** `variants`: Der REST-Listen-Endpoint
  (`/v2/{lang}/cards?set=…`) liefert nur Kurzform ohne `variants`
  (im Server-Code verifiziert). Umsetzung: **REST-Fanout** —
  `GET /v2/{lang}/cards/{id}` pro Karte, 8 parallel, mit
  Fortschrittsanzeige. Einmalig pro Set, danach offline aus IndexedDB.
  (Die TCGdex-GraphQL-API könnte das in einer Anfrage, aber ihre
  Filter-Syntax ließ sich im Servercode nicht zweifelsfrei verifizieren —
  der Fanout ist der garantiert funktionierende Weg.)
* Englische Namen werden zusätzlich zur gewählten Sprache geladen (eine
  Kurzlisten-Anfrage), weil Cardmarket-Produktnamen englisch sind — die CSV
  enthält beide Spalten (`Name` = EN fürs Matching, `Local Name` = z. B. DE).
* Sets werden **einzeln auf Anfrage** geladen und in IndexedDB gecacht.

---

## Architektur

**Stack**: Vite + React + TypeScript, schlichtes CSS, `idb` (dünner
IndexedDB-Wrapper), `vite-plugin-pwa` (Manifest + Service Worker),
Tesseract.js (OCR, Assets lokal gebündelt → offline-fähig). Kein Backend.

```
src/
  main.tsx / App.tsx        App-Shell, Fehler-Banner (Fehler sichtbar in der UI)
  types.ts                  BatchSettings, ScanRow, CardInfo, SetInfo …
  db.ts                     IndexedDB: settings, sets (Kartendaten), rows (Scanliste), hashes
  api/tcgdex.ts             Set-Liste, Set-Download (GraphQL → REST-Fanout), EN-Namen
  logic/plausibility.ts     Finish-Prüfung gegen variants  → Status ok / warn
  logic/csv.ts              Export: Mapping NM→near_mint …, Split pro Set+Finish à 100
  logic/numberParse.ts      "025/185"-Parsing + Nenner-Validierung gegen Set
  components/
    BatchBar.tsx            feste Leiste oben: Set, Sprache, Finish, Zustand, Preis
    SetManager.tsx          Sets suchen/laden/löschen, Download-Fortschritt
    ManualEntry.tsx         Nummer eintippen (M1-Weg, bleibt immer verfügbar)
    RowList.tsx             Ergebnisliste, editierbar, Wisch-Löschen der letzten Karte
    ExportPanel.tsx         CSV-Dateien erzeugen/herunterladen, Warn-Block
    Scanner.tsx             Kamera-Livebild + Overlay + Treffer-Feedback (M3)
    PhotoMatch.tsx          pHash-Fallback (M4)
  ocr/
    ocrWorker.ts            Web Worker: Tesseract, Whitelist "0123456789/"
    useScanner.ts           Frame-Loop, Crop der unteren Ecken, 2-Frame-Konsens,
                            Dedupe-Sperre (2,5 s) + sichtbarer "+1"-Zähler
  phash/
    dhash.ts                64-bit dHash + Hamming-Distanz
    hashWorker.ts           Index-Aufbau aus Set-Bildern (einmalig, IDB-Cache)
public/tesseract/           Worker/wasm/Traineddata lokal (offline, 0 €)
```

### Datenmodell (IndexedDB `card-scanner`)

* `settings`: Key-Value (aktive Batch-Einstellungen, zuletzt gewähltes Set)
* `sets`: Key `${lang}:${setId}` → Set-Metadaten + Karten
  `{ localId, nameLocal, nameEn, rarity, variants, image }`
* `rows`: auto-increment → Scan-Zeile
  `{ setId, lang, localId, finish, condition, price, quantity, status: 'ok'|'warn', createdAt }`
  — Menge wird pro identischer Kombination aggregiert.
* `hashes`: Key `${setId}` → `{ localId, hash }[]` (M4)

### Erkennungs-Pipeline (M3)

1. `getUserMedia` (Rückkamera, 1080p), Livebild mit Führungsrahmen.
2. Alle ~300 ms Frame auf Canvas, Zuschnitt **beider** unterer Ecken des
   Rahmens (Nummer sitzt je nach Ära links oder rechts), Vorverarbeitung
   (Graustufen, Kontrast, Hochskalierung).
3. Tesseract im Web Worker, Zeichen-Whitelist `0123456789/`.
4. Parsen als `Zähler/Nenner`. Akzeptiert nur, wenn der Nenner zur
   `cardCount.official` des gewählten Sets passt (Secret Rares: Zähler >
   Nenner erlaubt) **und** zwei aufeinanderfolgende Lesungen übereinstimmen.
   Das filtert Misreads fast vollständig.
5. Treffer: Beep + Vibration, Zeile in die Liste, 2,5 s Sperre gegen
   Doppelzählung; erneutes Scannen nach der Sperre erhöht sichtbar auf "+1".

Ziel < 1 s pro Karte: OCR auf ~2 kleinen Ausschnitten (je ~300×100 px) liegt
mit Tesseract deutlich unter 500 ms auf Tablet-Hardware; der Konsens aus zwei
Frames bleibt unter der Sekunde.

### Meilensteine = Commits

1. **M1**: kompletter Weg Set wählen → Nummer tippen → Liste → Plausibilität
   → CSV-Export (100er-Split). Ohne Kamera. Unit-Tests für CSV & Plausibilität.
2. **M2**: Set-Download inkl. `variants` + IndexedDB-Cache + PWA/offline.
3. **M3**: Kamera + OCR-Worker + Scan-Fluss.
4. **M4**: pHash-Fallback.

### Bewusst nicht drin

Keine Preisabfrage, kein Portfolio, kein Login, keine Cloud, keine Analytics,
keine Zustandsbewertung per Bild.
