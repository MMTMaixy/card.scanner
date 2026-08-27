# Pokémon-Karten-Scanner (PWA)

Karten stapelweise scannen und als CSV für das Cardmarket-Bulk-Listing
exportieren. Läuft komplett lokal im Browser (Chrome auf Android-Tablet),
offline-fähig, installierbar, ohne Backend, ohne Kosten, ohne Anmeldung.

Architektur und Entscheidungen: siehe [PLAN.md](PLAN.md).

## So funktioniert der Ablauf

1. **Batch einstellen** (feste Leiste oben): Sprache, Finish, Zustand,
   optional Fixpreis. **Kein Set mehr vorwählen** — das Set wird pro Karte
   erkannt.
2. **Scannen**: Karte flach ins Bild halten, kein fester Rahmen nötig.
   OpenCV.js findet die Kartenkontur, markiert sie gelb und entzerrt sie
   perspektivisch. Aus der unteren Infozeile werden zwei Dinge gelesen:
   die **Sammlernummer** (`005/084`) und der **Set-Code** im kleinen
   Kästchen (`PBL`, `SVI`, `SV2a`).
3. **Set bestimmen** — in dieser Reihenfolge:
   - **(a) Set-Code gelesen** → Set steht sofort fest.
   - **(b) kein Code, aber Nenner** → die Sets mit dieser Kartenzahl werden
     vorgeschlagen; bei nur einem Treffer wird er direkt übernommen, sonst
     genügt ein Tippen. (Auf Deutsch führen 60 % der Kartenzahlen auf genau
     ein Set, im Schnitt sind es 1,7 Kandidaten.)
   - **(c) nichts erkannt** → manuelle Auswahl mit Suche über Name,
     Kennung und Code.
   Zuletzt genutzte Sets stehen in allen Listen oben — beim Sortieren
   kommen meist viele Karten desselben Sets hintereinander.
4. **Erkanntes Set prüfen**: Jede Zeile zeigt das Set und woran es erkannt
   wurde (grün = Set-Code gelesen). Ein Tippen darauf korrigiert es.
5. **Plausibilitätsprüfung**: Steht der Batch z. B. auf „Reverse Holo“ und
   die Karte existiert laut Datenbank nicht als Reverse, wird die Zeile
   **gelb** markiert — mit Hinweis, welche Finishes es gibt, und
   Ein-Tap-Korrektur. Gelbe Zeilen **blockieren den Export**, bis sie
   aufgelöst sind.
6. **Export**: CSV-Dateien getrennt nach **Set + Finish**, automatisch
   gesplittet bei **100 Artikeln** (Cardmarket-Limit).

### Wie die Karte gefunden wird

Zwei unabhängige Quellen liefern Kandidaten, gewählt wird der mit dem
**kartenähnlichsten Seitenverhältnis** (88:63 ≈ 1,40) — nicht der größte:

1. **Kanten** (Canny) — funktioniert bei klarem Kontrast zur Unterlage.
2. **Farbsättigung** — Karten sind bunt bedruckt, Tisch und Stoff nicht.

Beide Punkte stammen aus Fehlern an echten Fotos: Zuerst gewann ein 31 %
zu breites Rechteck der Unterlage (Verhältnis 1,13), weil unter mehreren
Treffern der größte genommen wurde. Danach fand Canny an einer hellblauen
Kartenunterkante nur die kräftige Linie darüber — die entzerrte Karte
verlor genau die Zeile mit der Sammlernummer. Über die Sättigung wird
dieselbe Karte mit Verhältnis 1,40 gefunden und die Nummer korrekt gelesen.
Das Foto liegt als Regressionstest in `src/fixtures/`.

### Karte groß genug ins Bild halten

Füllt die Karte weniger als **35 % der Bildbreite**, liest die App die
Nummer bewusst **nicht** — die Diagnose zeigt dann „Karte zu klein“. Grund:
An dieser Grenze liefert die OCR nicht bloß nichts, sondern gelegentlich
eine *falsche* Nummer (im Test gemessen: `5/55` statt `5/84`). Ohne
vorgewähltes Set würde die Karte dadurch still im falschen Set landen —
lieber einmal näher herangehen.

### Der globale Set-Index

`src/data/setIndex.json` (77 KB, reine Textdaten) enthält für **515 Sets**
den aufgedruckten Set-Code, die offizielle Kartenzahl, die Gesamtzahl und
die Namen je Sprache. Er wird mitgeliefert und beim Start in IndexedDB
gespiegelt — die Set-Erkennung funktioniert damit **vollständig offline**.
Nur die Kartendaten des erkannten Sets werden bei Bedarf nachgeladen
(einmalig pro Set, danach offline).

Erzeugt wird er aus dem TCGdex-Datenbestand:

```bash
git clone --depth 1 https://github.com/tcgdex/cards-database /pfad/dazu
node scripts/build-set-index.mjs /pfad/dazu
```

**Wie gut wird der Code wirklich gelesen?** Auf sauberen, formatfüllenden
Aufnahmen zuverlässig; auf einem freihändigen Foto mit kleinem, dunklem
Kästchen (getestet an einer japanischen Karte) nicht. Dann greift Weg (b):
Die Kartenzahl liefert die Kandidaten, ein Tipp genügt. Erwarte also nicht,
dass jede Karte ohne Rückfrage durchläuft.

Code-Abdeckung: 94 % aller Sets. Deutsch 152 von 170 Sets, Englisch 187 von
216. Für japanische und chinesische Sets pflegt TCGdex keine Abkürzungen —
dort ist die Set-Kennung selbst der aufgedruckte Code (`SV2a`), was die App
nutzt.

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

Sprache: `de` / `en` / `ja` / `zh-TW` / `zh-CN`. Leerer Preis = Preisfeld bleibt leer.

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

## Offline-Verhalten und Downloadgröße

Die Installation lädt nur **~2,2 MB** (App + Sprachdaten fürs OCR). Die beiden
großen Rechenkerne kommen erst beim **ersten Kamerastart** dazu und bleiben
danach dauerhaft gecacht:

| Was | Größe | Wann |
|---|---|---|
| App-Shell, Icons, OCR-Sprachdaten | ~2,2 MB | bei der Installation |
| OpenCV.js (Kartenerkennung) | ~15 MB | beim ersten Kamerastart |
| Tesseract-Rechenkern | ~4 MB | beim ersten Kamerastart |

Vom Tesseract-Kern gibt es drei Varianten (je nach Prozessor-Fähigkeiten);
geladen und gecacht wird nur die eine, die dein Gerät braucht. Vorher wurden
bei der Installation alle drei plus OpenCV geholt — 29 MB, davon rund 20 MB
unnötig.

**Konsequenz:** Der erste Kamerastart braucht Internet. Danach funktioniert
auch das Scannen offline. Listen führen, Nummern eintippen und CSV
exportieren geht von Anfang an offline.

## Entwicklung

```bash
npm install
npm run dev          # Dev-Server
npm test             # Unit-Tests (CSV, Nummern-Parsing, Plausibilität, Geometrie, dHash)
npm run test:vision       # Vision-Pipeline im Browser, gegen den Dev-Server
npm run build             # Typecheck + Produktions-Build nach dist/
npm run test:vision:prod  # dieselbe Prüfung gegen den gebauten Stand
npm run check:sw          # prüft nach dem Build, was offline gecacht wird
```

**Beide Vision-Varianten laufen lassen.** Dev-Server und Bundler behandeln
Module unterschiedlich: OpenCV.js ist ein Emscripten-Modul, das ein `then`
exportiert — beim dynamischen Import hält JavaScript den Modul-Namensraum
deshalb für ein Promise und bricht ab. Im Dev-Server fiel das nicht auf, im
Produktions-Build stürzte der Kamerastart ab. Deshalb wird OpenCV.js jetzt
als klassisches `<script>` aus `public/opencv/` geladen (kopiert automatisch
vor `dev` und `build`) und der Test läuft in beiden Modi.

Die gebaute `selftest.html` liegt auch auf der Website (nirgends verlinkt) —
`…/card.scanner/selftest.html` lässt sich direkt **auf dem Tablet** öffnen,
um dort zu prüfen, ob Kartenerkennung und OCR funktionieren.

`npm run test:vision` ist der wichtigste Test für alles rund um die Kamera:
Er projiziert eine synthetische Karte mit bekannter Nummer per bekannter
Perspektivtransformation in eine Szene und prüft dann, ob die Erkennung die
Ecken trifft (Toleranz 8 px, real erreicht: ~1,5 px) und ob die Nummer aus
der entzerrten Karte gelesen wird — inklusive des Falls „Karte ragt aus dem
Bild“, der sauber abgelehnt werden muss. OpenCV, Canvas und Tesseract
brauchen dafür einen echten Browser; die Kernlogik ohne Bildverarbeitung
deckt `npm test` ab.

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
- **Der Foto-Abgleich sucht nur in den zuletzt genutzten Sets** (höchstens
  drei) und schlägt nur vor, statt automatisch zu übernehmen —
  bei ähnlichen Artworks (gleiche Karte in mehreren Versionen) bewusst
  den richtigen Kandidaten antippen.
- **Japanische Sets:** TCGdex führt sie, aber die Abdeckung ist dünner als
  bei DE/EN. Vor einem großen JP-Stapel kurz stichprobenartig prüfen.
