import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as db from './db';
import type { BatchSettings, CardInfo, Finish, ScanRow, SetInfo, SetSource } from './types';
import { FINISH_LABELS } from './types';
import { checkFinish } from './logic/plausibility';
import { findCardByNumber } from './logic/numberParse';
import {
  identifySet,
  setName,
  setsForLang,
  type SetIndexEntry,
  type SetIndexFile,
} from './logic/setIndex';
import { cachedSet, ensureSet, onSetEnriched } from './logic/setStore';
import bundledIndex from './data/setIndex.json';
import { BatchBar } from './components/BatchBar';
import { SetPicker } from './components/SetPicker';
import { ManualEntry } from './components/ManualEntry';
import { RowList } from './components/RowList';
import { ExportPanel } from './components/ExportPanel';
import { Scanner, type Reading } from './components/Scanner';
import { hashImageSource } from './phash/dhash';
import { buildHashIndex, loadHashIndex, matchHash } from './phash/matcher';

const DEFAULT_BATCH: BatchSettings = {
  lang: 'de',
  finish: 'normal',
  condition: 'NM',
  price: '',
};

interface UndoEntry {
  rowId: number;
  wasNew: boolean;
}

/** Offene Rückfrage: Set einer gescannten Karte auswählen. */
interface PendingPick {
  title: string;
  hint: string;
  candidates: SetIndexEntry[];
  /** Sammlernummer, die nach der Auswahl eingetragen wird */
  localId: string;
  /** Beim Foto-Abgleich gehört zu jedem Set eine eigene Kartennummer */
  localIdBySet?: Record<string, string>;
  source: SetSource;
}

/** Wieviele Sets der Foto-Abgleich höchstens durchsucht. */
const PHOTO_MAX_SETS = 3;

export default function App() {
  const [batch, setBatch] = useState<BatchSettings>(DEFAULT_BATCH);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [index, setIndex] = useState<SetIndexEntry[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
  const [pending, setPending] = useState<PendingPick | null>(null);
  const [loadingSet, setLoadingSet] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const undoStack = useRef<UndoEntry[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchRef = useRef(batch);
  batchRef.current = batch;

  // --- Start: Index, Einstellungen, Liste laden ---
  useEffect(() => {
    (async () => {
      try {
        const [savedBatch, savedRows, savedRecent, storedIndex] = await Promise.all([
          db.loadBatchSettings(),
          db.getAllRows(),
          db.getRecentSets(),
          db.loadSetIndex(),
        ]);
        if (savedBatch) setBatch({ ...DEFAULT_BATCH, ...savedBatch });
        setRows(savedRows);
        setRecent(savedRecent);

        // Der Index liegt mitgeliefert im Bundle und wird in IndexedDB
        // gespiegelt, damit er offline verfügbar ist und später
        // aktualisiert werden kann.
        const bundled = bundledIndex as SetIndexFile;
        if (!storedIndex || storedIndex.generated < bundled.generated) {
          await db.saveSetIndex(bundled);
          setIndex(bundled.sets);
        } else {
          setIndex(storedIndex.sets);
        }
      } catch (err) {
        setError(`Lokale Datenbank konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`);
        setIndex((bundledIndex as SetIndexFile).sets);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const showToast = useCallback((text: string, kind: 'ok' | 'warn' | 'error') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const reportError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const updateBatch = useCallback(
    (patch: Partial<BatchSettings>) => {
      setBatch((prev) => {
        const next = { ...prev, ...patch };
        db.saveBatchSettings(next).catch(reportError);
        return next;
      });
    },
    [reportError],
  );

  // Nachgeladene Finish-Daten: Plausibilität betroffener Zeilen nachholen
  useEffect(
    () =>
      onSetEnriched((set) => {
        setRows((prev) =>
          prev.map((row) => {
            if (row.setId !== set.id || row.lang !== set.lang) return row;
            if (row.availableFinishes.length > 0) return row;
            const card = set.cards.find((c) => c.localId === row.localId);
            if (!card) return row;
            const check = checkFinish(card, row.finish);
            const updated: ScanRow = {
              ...row,
              nameEn: row.nameEn ?? card.nameEn,
              availableFinishes: check.available,
              status: check.status,
              warnReason: check.reason,
            };
            db.updateRow(updated).catch(() => {});
            return updated;
          }),
        );
      }),
    [],
  );

  const langSets = useMemo(() => setsForLang(index, batch.lang), [index, batch.lang]);

  /** Gehört der gelesene Nenner überhaupt zu einem Set dieser Sprache? */
  const isPlausibleReading = useCallback(
    (denominator: number, numerator: string) => {
      const num = Number(numerator);
      if (!Number.isFinite(num) || num < 1) return false;
      return langSets.some((s) => s.official === denominator && num <= s.total + 20);
    },
    [langSets],
  );

  /** Trägt eine Karte eines bestimmten Sets in die Liste ein. */
  const commitCard = useCallback(
    async (entry: SetIndexEntry, localId: string, source: SetSource): Promise<boolean> => {
      const lang = batchRef.current.lang;
      let set: SetInfo;
      try {
        if (!cachedSet(lang, entry.id)) setLoadingSet(setName(entry, lang));
        set = await ensureSet(lang, entry);
      } catch (err) {
        reportError(err);
        return false;
      } finally {
        setLoadingSet(null);
      }

      const card: CardInfo | undefined = findCardByNumber(set, localId);
      if (!card) {
        showToast(`Nummer ${localId} gibt es in ${set.name} nicht.`, 'error');
        return false;
      }

      const b = batchRef.current;
      const plausibility = checkFinish(card, b.finish);
      const now = Date.now();

      let created = false;
      setRows((prev) => {
        const existing = prev.find(
          (r) =>
            r.setId === set.id &&
            r.lang === set.lang &&
            r.localId === card.localId &&
            r.finish === b.finish &&
            r.condition === b.condition &&
            r.price === b.price,
        );
        if (existing && existing.id != null) {
          const updated: ScanRow = { ...existing, quantity: existing.quantity + 1, updatedAt: now };
          db.updateRow(updated).catch(reportError);
          undoStack.current.push({ rowId: existing.id, wasNew: false });
          showToast(`${set.name}: ${card.nameLocal} #${card.localId} → Menge ${updated.quantity}`, 'ok');
          return prev.map((r) => (r.id === updated.id ? updated : r));
        }
        created = true;
        return prev;
      });

      if (created) {
        const newRow: Omit<ScanRow, 'id'> = {
          setId: set.id,
          setName: set.name,
          setCode: entry.code,
          setSource: source,
          lang: set.lang,
          localId: card.localId,
          nameLocal: card.nameLocal,
          nameEn: card.nameEn,
          finish: b.finish,
          condition: b.condition,
          price: b.price,
          quantity: 1,
          status: plausibility.status,
          warnReason: plausibility.reason,
          availableFinishes: plausibility.available,
          createdAt: now,
          updatedAt: now,
        };
        try {
          const saved = await db.addRow(newRow);
          setRows((prev) => [...prev, saved]);
          if (saved.id != null) undoStack.current.push({ rowId: saved.id, wasNew: true });
          if (plausibility.status === 'warn') {
            showToast(`⚠ ${card.nameLocal} #${card.localId}: ${plausibility.reason}`, 'warn');
          } else {
            showToast(`${set.name}: ${card.nameLocal} #${card.localId}`, 'ok');
          }
        } catch (err) {
          reportError(err);
          return false;
        }
      }

      setRecent(await db.pushRecentSet(entry.id));
      if (navigator.vibrate) navigator.vibrate(40);
      return true;
    },
    [reportError, showToast],
  );

  /**
   * Kern der neuen Erkennung: Aus einer Lesung das Set bestimmen.
   *   a) Set-Code gelesen        -> Set direkt
   *   b) kein Code, aber Nenner  -> Kandidaten, ein Tap
   *   c) nichts                  -> manuelle Auswahl
   */
  const handleScan = useCallback(
    async (reading: Reading): Promise<boolean> => {
      const result = identifySet({
        sets: index,
        lang: batchRef.current.lang,
        denominator: reading.denominator,
        codeText: reading.codeText,
        recent,
      });

      if (result.set) {
        return commitCard(result.set, reading.numerator, result.mode === 'code' ? 'code' : 'denominator');
      }

      setPending({
        title: `Karte #${reading.numerator}/${reading.denominator}`,
        hint:
          result.candidates.length > 0
            ? 'Der Set-Code war nicht lesbar. Diese Sets haben diese Kartenzahl:'
            : 'Weder Set-Code noch passende Kartenzahl erkannt — Set bitte auswählen.',
        candidates: result.candidates,
        localId: reading.numerator,
        source: result.candidates.length > 0 ? 'denominator' : 'manual',
      });
      return false;
    },
    [index, recent, commitCard],
  );

  /**
   * Foto-Abgleich: bewusst NUR innerhalb der Kandidatensets — über alle Sets
   * wäre er langsam und ungenau. Kandidaten sind die zuletzt genutzten Sets.
   */
  const handlePhotoMatch = useCallback(
    async (warped: HTMLCanvasElement) => {
      const lang = batchRef.current.lang;
      const candidateEntries = recent
        .map((id) => index.find((s) => s.id === id))
        .filter((s): s is SetIndexEntry => !!s && !!s.names[lang])
        .slice(0, PHOTO_MAX_SETS);

      if (candidateEntries.length === 0) {
        showToast('Foto-Abgleich braucht mindestens ein zuletzt genutztes Set.', 'error');
        return;
      }

      try {
        const hash = hashImageSource(warped);
        const scored: { entry: SetIndexEntry; localId: string; distance: number }[] = [];
        for (const entry of candidateEntries) {
          setLoadingSet(setName(entry, lang));
          const set = await ensureSet(lang, entry);
          let hashes = await loadHashIndex(entry.id);
          if (!hashes) hashes = await buildHashIndex(set);
          for (const m of matchHash(hash, hashes, 2)) {
            scored.push({ entry, localId: m.localId, distance: m.distance });
          }
        }
        scored.sort((a, b) => a.distance - b.distance);
        const best = scored.slice(0, 3);
        if (best.length === 0) {
          showToast('Keine ähnliche Karte in den zuletzt genutzten Sets.', 'warn');
          return;
        }
        // Vorschläge als Set-Auswahl anbieten: ein Tap trägt die Karte ein.
        setPending({
          title: 'Foto-Abgleich',
          hint: `Ähnlichste Karten: ${best
            .map((b) => `#${b.localId} in ${setName(b.entry, lang)} (Abstand ${b.distance})`)
            .join(' · ')}. Passendes Set antippen.`,
          candidates: best.map((b) => b.entry),
          localId: best[0].localId,
          localIdBySet: Object.fromEntries(best.map((b) => [b.entry.id, b.localId])),
          source: 'photo',
        });
      } catch (err) {
        reportError(err);
      } finally {
        setLoadingSet(null);
      }
    },
    [index, recent, reportError, showToast],
  );

  /** Manuelle Eingabe: Nummer eintippen, Set danach bestimmen. */
  const addByNumber = useCallback(
    async (input: string): Promise<boolean> => {
      const m = input.trim().match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
      if (m) {
        return handleScan({ numerator: m[1], denominator: Number(m[2]), codeText: '' });
      }
      // Nur eine Nummer ohne Nenner -> Set manuell wählen
      setPending({
        title: `Karte #${input.trim()}`,
        hint: 'Bitte das Set wählen. Tipp: „5/84“ eingeben, dann wird das Set über die Kartenzahl gesucht.',
        candidates: [],
        localId: input.trim(),
        source: 'manual',
      });
      return false;
    },
    [handleScan],
  );

  const undoLast = useCallback(async () => {
    const entry = undoStack.current.pop();
    if (!entry) {
      showToast('Nichts zum Rückgängigmachen.', 'warn');
      return;
    }
    try {
      const row = rows.find((r) => r.id === entry.rowId);
      if (!row) return;
      if (entry.wasNew || row.quantity <= 1) {
        await db.deleteRow(entry.rowId);
        setRows((prev) => prev.filter((r) => r.id !== entry.rowId));
        showToast(`${row.nameLocal} #${row.localId} entfernt`, 'ok');
      } else {
        const updated = { ...row, quantity: row.quantity - 1, updatedAt: Date.now() };
        await db.updateRow(updated);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        showToast(`${row.nameLocal} #${row.localId} → Menge ${updated.quantity}`, 'ok');
      }
    } catch (err) {
      reportError(err);
    }
  }, [rows, reportError, showToast]);

  const changeRow = useCallback(
    async (row: ScanRow, patch: Partial<ScanRow>) => {
      try {
        let updated: ScanRow = { ...row, ...patch, updatedAt: Date.now() };
        if (patch.finish && updated.availableFinishes.length > 0) {
          if (updated.availableFinishes.includes(patch.finish)) {
            updated = { ...updated, status: 'ok', warnReason: undefined };
          } else {
            const list = updated.availableFinishes.map((f: Finish) => FINISH_LABELS[f]).join(', ');
            updated = {
              ...updated,
              status: 'warn',
              warnReason: `Gibt es laut Datenbank nicht als ${FINISH_LABELS[patch.finish]} – nur als: ${list}`,
            };
          }
        }
        await db.updateRow(updated);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      } catch (err) {
        reportError(err);
      }
    },
    [reportError],
  );

  /** Set einer bereits erfassten Zeile korrigieren. */
  const changeRowSet = useCallback(
    async (row: ScanRow, entry: SetIndexEntry) => {
      const lang = row.lang;
      try {
        setLoadingSet(setName(entry, lang));
        const set = await ensureSet(lang, entry);
        const card = findCardByNumber(set, row.localId);
        if (!card) {
          showToast(`Nummer ${row.localId} gibt es in ${set.name} nicht.`, 'error');
          return;
        }
        const check = checkFinish(card, row.finish);
        await changeRow(row, {
          setId: set.id,
          setName: set.name,
          setCode: entry.code,
          setSource: 'manual',
          nameLocal: card.nameLocal,
          nameEn: card.nameEn,
          availableFinishes: check.available,
          status: check.status,
          warnReason: check.reason,
        });
        setRecent(await db.pushRecentSet(entry.id));
      } catch (err) {
        reportError(err);
      } finally {
        setLoadingSet(null);
      }
    },
    [changeRow, reportError, showToast],
  );

  const removeRow = useCallback(
    async (row: ScanRow) => {
      if (row.id == null) return;
      try {
        await db.deleteRow(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        undoStack.current = undoStack.current.filter((e) => e.rowId !== row.id);
        showToast(`${row.nameLocal} #${row.localId} gelöscht`, 'ok');
      } catch (err) {
        reportError(err);
      }
    },
    [reportError, showToast],
  );

  const clearAllRows = useCallback(async () => {
    try {
      await db.clearRows();
      setRows([]);
      undoStack.current = [];
      showToast('Liste geleert.', 'ok');
    } catch (err) {
      reportError(err);
    }
  }, [reportError, showToast]);

  // Zeile, deren Set gerade geändert wird
  const [rowToRetarget, setRowToRetarget] = useState<ScanRow | null>(null);

  /**
   * Beim Korrigieren zuerst die Sets mit derselben Kartenzahl vorschlagen —
   * das sind genau die, die zur aufgedruckten Nummer passen können.
   */
  const retargetCandidates = useMemo(() => {
    if (!rowToRetarget) return [];
    const current = index.find((s) => s.id === rowToRetarget.setId);
    if (!current) return [];
    return setsForLang(index, rowToRetarget.lang).filter(
      (s) => s.official === current.official && s.id !== current.id,
    );
  }, [rowToRetarget, index]);

  if (!ready) {
    return <div className="loading">Lade lokale Daten …</div>;
  }

  return (
    <div className="app">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Schließen</button>
        </div>
      )}

      <BatchBar batch={batch} onChange={updateBatch} />

      {loadingSet && <div className="loading-strip">Lade Kartendaten: {loadingSet} …</div>}

      {pending && (
        <SetPicker
          title={pending.title}
          hint={pending.hint}
          lang={batch.lang}
          candidates={pending.candidates}
          allSets={index}
          recent={recent}
          onPick={(entry) => {
            const p = pending;
            setPending(null);
            void commitCard(entry, p.localIdBySet?.[entry.id] ?? p.localId, p.source);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {rowToRetarget && (
        <SetPicker
          title={`Set ändern für #${rowToRetarget.localId}`}
          hint="Das Set dieser Karte korrigieren."
          lang={rowToRetarget.lang}
          candidates={retargetCandidates}
          allSets={index}
          recent={recent}
          onPick={(entry) => {
            const row = rowToRetarget;
            setRowToRetarget(null);
            void changeRowSet(row, entry);
          }}
          onCancel={() => setRowToRetarget(null)}
        />
      )}

      <main className="main">
        <Scanner
          isPlausibleReading={isPlausibleReading}
          onScan={handleScan}
          onPhotoMatch={handlePhotoMatch}
        />
        <ManualEntry disabled={false} onSubmit={addByNumber} onUndo={undoLast} />
        <RowList rows={rows} onChange={changeRow} onRemove={removeRow} onChangeSet={setRowToRetarget} />
        <ExportPanel rows={rows} onClearAll={clearAllRows} />
      </main>

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
