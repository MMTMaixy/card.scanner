# Pokémon-Karten-Scanner (PWA)

Karten stapelweise scannen und als CSV für das Cardmarket-Bulk-Listing
exportieren. Läuft komplett lokal im Browser (Chrome auf Android-Tablet),
offline-fähig, installierbar, ohne Backend, ohne Kosten, ohne Anmeldung.

Architektur und Entscheidungen: siehe [PLAN.md](PLAN.md).

## So funktioniert der Ablauf

1. **Batch einstellen** (feste Leiste oben): Set, Sprache, Finish, Zustand,
   optional Fixpreis. Gilt für alle folgenden Scans.
2. **Set laden**: einmalig pro Set (braucht Internet), danach offline aus
   IndexedDB. Geladen werden Kartennamen (gewählte Sprache **und** Englisch),
   Sammlernummern und die verfügbaren Finishes pro Karte (TCGdex).
3. **Scannen**: Karte in den Rahmen legen — die Sammlernummer unten
   (z. B. `136/189`) wird kontinuierlich per OCR gelesen. Der Nenner muss zur
   Kartenzahl des Sets passen und zwei Lesungen müssen übereinstimmen, erst
   dann zählt der Treffer (Beep + Vibration). Eine liegende Karte wird nicht
   doppelt gezählt; dieselbe Karte nach kurzem Wegnehmen erneut scannen
   erhöht die Menge. Alternativ: Nummer eintippen oder **Foto-Abgleich**
   (Bildvergleich per dHash) für Karten ohne lesbare Nummer.
4. **Plausibilitätsprüfung**: Steht der Batch z. B. auf „Reverse Holo“ und die
   Karte existiert laut Datenbank nicht als Reverse (Secret Rare etc.), wird
   die Zeile **gelb** markiert — mit Hinweis, welche Finishes es gibt, und
   Ein-Tap-Korrektur. Gelbe Zeilen **blockieren den Export**, bis sie
   aufgelöst sind (korrigieren oder bewusst behalten — die Datenbank kann
   auch mal irren).
5. **Export**: CSV-Dateien getrennt nach **Set + Finish**, automatisch
   gesplittet bei **100 Artikeln** (Cardmarket-Limit, Summe der Mengen).

## Auf dem Tablet testen

Die Kamera funktioniert nur in einem „sicheren Kontext“: **HTTPS oder
localhost**. Drei Wege, vom einfachsten zum flexibelsten:

### Variante A — App irgendwo statisch per HTTPS hosten (empfohlen für den Dauerbetrieb)

```bash
npm install
npm run build        # erzeugt dist/
```

Den Inhalt von `dist/` auf einen beliebigen statischen HTTPS-Host legen
(GitHub Pages, Netlify Drop, Cloudflare Pages — alle kostenlos). Im Repo
liegt ein fertiger GitHub-Actions-Workflow
(`.github/workflows/deploy-pages.yml`): in den Repo-Einstellungen unter
*Pages* → *Source* → **GitHub Actions** wählen, dann wird bei jedem Push
automatisch deployed. Auf dem Tablet die URL öffnen → Chrome-Menü →
**„App installieren“**. Danach läuft alles offline (nur Set-Downloads
brauchen Netz).

### Variante B — Entwicklungsrechner + USB-Kabel (adb)

`localhost` gilt als sicher — mit `adb reverse` zeigt das localhost des
Tablets auf den Dev-Server des Rechners:

```bash
npm run dev -- --host        # Dev-Server starten
adb reverse tcp:5173 tcp:5173
```

Auf dem Tablet `http://localhost:5173` öffnen. (USB-Debugging in den
Android-Entwickleroptionen aktivieren.)

### Variante C — WLAN ohne Kabel (Chrome-Flag)

```bash
npm run dev -- --host        # zeigt die IP des Rechners an, z. B. 192.168.1.20
```

Auf dem Tablet in Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
öffnen, dort `http://192.168.1.20:5173` eintragen, Chrome neu starten.
Damit behandelt Chrome genau diese Adresse als sicher — nur fürs Testen
gedacht.

## Export zu Cardmarket (Extension „cardmarket-bulk-import“)

Ziel ist die Browser-Extension
[cardmarket-bulk-import](https://github.com/PedroPerpetua/cardmarket-bulk-import)
(Chrome/Firefox am **PC** — auf Cardmarket selbst, nicht auf dem Tablet):

1. CSV-Dateien aus der App herunterladen und auf den PC übertragen.
2. Auf Cardmarket: *Verkaufen → Bulk-Listing* („List bulk items“), dort das
   **Set** und die **Sprache** der Datei als Filter wählen.
3. Import-Button der Extension klicken, CSV wählen, Spalten zuordnen
   (Vorschlag passt: `Name` → Name, `Language` → Sprache, `Condition` →
   Zustand, `Quantity` → Menge, `Price` → Preis). Die App exportiert den
   **englischen** Kartennamen in der `Name`-Spalte, weil Cardmarket-Produkte
   englisch heißen; die Spalte `Local Name` ist nur zur Kontrolle.
4. **Immer das befüllte Formular prüfen, bevor du es abschickst.**

### Wichtige Einschränkung: Reverse Holo

Die Extension kann für Pokémon **kein Reverse-Holo-Häkchen setzen** (das
unterstützt sie derzeit nur für Magic-Foils). Deshalb exportiert die App
strikt getrennte Dateien pro Finish: Bei einer `…_reverse.csv` nach dem
Befüllen die Reverse-Häkchen der befüllten Zeilen im Formular **von Hand**
anhaken — die Datei enthält ausschließlich Reverse-Karten. Die App zeigt
diesen Hinweis auch beim Export an.

### CSV-Werte

| App | CSV (`Condition`) |
|---|---|
| NM | `near_mint` |
| EX | `excellent` |
| GD | `good` |
| LP | `light_played` |
| PL | `played` |
| PO | `poor` |

Sprache: `de` / `en` / `ja`. Leerer Preis = Preisfeld bleibt leer.

## Japanische und chinesische Sets

Unterstützte Sprachen: Deutsch, Englisch, Japanisch, **Chinesisch
(traditionell, zh-tw)** und **Chinesisch (vereinfacht, zh-cn)** — die
asiatischen TCG-Releases laufen über dieselben TCGdex-Daten.

Damit die Set-Auswahl lesbar bleibt (TCGdex pflegt für Asien-Sets **keine**
englischen Namen — im Quell-Repo verifiziert):

- Für die Sword/Shield- (S), Scarlet/Violet- (SV) und Mega-Ära (M) zeigt die
  App **kuratierte englische Namen** („VSTAR Universe“, „Pokémon Card 151“ …)
  aus `src/data/asiaSetNamesEn.ts`; die zh-tw-Ausgaben nutzen dieselben
  Set-Codes. Suche funktioniert über englischen Namen, Originalnamen und Code.
- Sets ohne Tabelleneintrag (ältere Ären, Festlandchina-exklusive Sets)
  zeigen **Set-Code + Originalname** — der Code ist immer lateinisch lesbar.
  Neue Sets bitte einfach in der Tabelle ergänzen.
- **Englische Kartennamen** gibt es bei Asien-Sets ebenfalls nicht in TCGdex.
  Für Pokémon-Karten synthetisiert die App den Namen aus Pokédex-Nummer +
  Suffix („Pikachu ex“, Daten: `src/data/speciesEn.json`, generiert per
  `node scripts/fetch-species-names.mjs`) — das reicht fürs normalisierte
  Namens-Matching der Extension. **Trainer-/Energiekarten behalten den
  Originalnamen** und matchen im Cardmarket-Formular ggf. nicht automatisch —
  diese Zeilen nach dem Import von Hand prüfen/ausfüllen.
- Cardmarket-Sprachwerte in der CSV: `ja`, `zh-TW` (T-Chinese), `zh-CN`
  (S-Chinese). Ob Chinesisch für Pokémon-Einzelkarten wählbar ist, bestimmt
  das Cardmarket-Formular selbst; die Extension matcht gegen dessen Optionen
  und fällt sonst auf die erste Option zurück — also nach dem Befüllen die
  Sprachspalte kontrollieren.

## Debuggen auf dem Tablet (ohne Browser-Konsole)

- **Boot-Fallback**: Beim Laden zeigt die Seite „App startet …“. Verschwindet
  die Meldung nicht, ist das JavaScript nie gestartet — Fehler (auch
  fehlgeschlagene Datei-Ladevorgänge) erscheinen dann automatisch als roter
  Text unten auf der Seite (`window.onerror` + `unhandledrejection` +
  Ressourcen-Fehler sind global abgefangen; React-Abstürze fängt eine
  ErrorBoundary).
- **Echte Konsole**: Seite mit `?debug=1` öffnen, z. B.
  `https://mmtmaixy.github.io/card.scanner/?debug=1` — dann erscheint unten
  rechts der [eruda](https://github.com/liriliri/eruda)-Button mit
  vollwertiger Konsole, Netzwerk-Tab usw. (lokal gebündelt, lädt auch dann,
  wenn das App-Bundle kaputt ist).
- **Seite bleibt komplett weiß, ohne „App startet …“?** Dann liefert GitHub
  Pages nicht den Build aus, sondern etwas anderes (oder nichts): In den
  Repo-Einstellungen unter *Pages* muss als *Source* **„GitHub Actions“**
  gewählt sein — nicht „Deploy from a branch“.

## Entwicklung

```bash
npm install
npm run dev          # Dev-Server
npm test             # Unit-Tests (CSV, Nummern-Parsing, Plausibilität, dHash)
npm run build        # Typecheck + Produktions-Build nach dist/
```

Die OCR-Assets (Tesseract-Worker, WASM, Sprachdaten, ~14 MB) liegen fertig
in `public/tesseract/` und sind committet — Builds brauchen dafür kein Netz.
Neu erzeugen (z. B. nach Tesseract-Update): `node scripts/fetch-ocr-assets.mjs`.
PWA-Icons: `node scripts/gen-icons.mjs`.

## Grenzen, offen gesagt

- **TCGdex ist community-gepflegt.** Die Finish-Daten (`variants`) sind
  explizit pro Karte vorhanden — genau deshalb wurde TCGdex gewählt —, aber
  einzelne Karten können falsch erfasst sein. Darum blockt die gelbe
  Markierung nie hart: du kannst per Tap korrigieren oder bewusst
  übersteuern. (Die Alternative pokemontcg.io hat gar kein Finish-Feld und
  keine deutschen Namen.)
- **OCR braucht die Nummer im Format `x/y`.** Promos ohne diese Nummer:
  Nummer eintippen oder Foto-Abgleich nutzen.
- **Der Foto-Abgleich schlägt nur vor**, er übernimmt nie automatisch —
  bei ähnlichen Artworks (gleiche Karte in mehreren Versionen) bewusst
  den richtigen Kandidaten antippen.
- **Japanische Sets:** TCGdex führt sie, aber die Abdeckung ist dünner als
  bei DE/EN. Vor einem großen JP-Stapel kurz stichprobenartig prüfen.
