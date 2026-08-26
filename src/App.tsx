import { useCallback, useEffect, useRef, useState } from 'react';
import * as db from './db';
import type { BatchSettings, CardInfo, Finish, ScanRow, SetInfo } from './types';
import { FINISH_LABELS } from './types';
import { checkFinish } from './logic/plausibility';
import { findCardByNumber } from './logic/numberParse';
import { BatchBar } from './components/BatchBar';
import { SetManager } from './components/SetManager';
import { ManualEntry } from './components/ManualEntry';
import { Scanner } from './components/Scanner';
import { RowList } from './components/RowList';
import { ExportPanel } from './components/ExportPanel';

const DEFAULT_BATCH: BatchSettings = {
  setId: null,
  lang: 'de',
  finish: 'normal',
  condition: 'NM',
  price: '',
};

interface UndoEntry {
  rowId: number;
  wasNew: boolean;
}

export default function App() {
  const [batch, setBatch] = useState<BatchSettings>(DEFAULT_BATCH);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [storedSets, setStoredSets] = useState<SetInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
  const [setManagerOpen, setSetManagerOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const undoStack = useRef<UndoEntry[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSet = storedSets.find((s) => s.id === batch.setId && s.lang === batch.lang);

  // Initial aus IndexedDB laden
  useEffect(() => {
    (async () => {
      try {
        const [savedBatch, savedRows, savedSets] = await Promise.all([
          db.loadBatchSettings(),
          db.getAllRows(),
          db.listStoredSets(),
        ]);
        if (savedBatch) setBatch({ ...DEFAULT_BATCH, ...savedBatch });
        setRows(savedRows);
        setStoredSets(savedSets);
      } catch (err) {
        setError(`Lokale Datenbank konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`);
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

  const reportError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    },
    [],
  );

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

  /** Kern-Aktion: Karte (per Nummer oder Scanner gefunden) in die Liste übernehmen. */
  const addCard = useCallback(
    async (card: CardInfo, set: SetInfo) => {
      try {
        const plausibility = checkFinish(card, batch.finish);
        const now = Date.now();

        const existing = rows.find(
          (r) =>
            r.setId === set.id &&
            r.lang === set.lang &&
            r.localId === card.localId &&
            r.finish === batch.finish &&
            r.condition === batch.condition &&
            r.price === batch.price,
        );

        if (existing && existing.id != null) {
          const updated: ScanRow = { ...existing, quantity: existing.quantity + 1, updatedAt: now };
          await db.updateRow(updated);
          setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
          undoStack.current.push({ rowId: existing.id, wasNew: false });
          showToast(`${card.nameLocal} ${card.localId} → Menge ${updated.quantity}`, 'ok');
        } else {
          const newRow: Omit<ScanRow, 'id'> = {
            setId: set.id,
            setName: set.name,
            lang: set.lang,
            localId: card.localId,
            nameLocal: card.nameLocal,
            nameEn: card.nameEn,
            finish: batch.finish,
            condition: batch.condition,
            price: batch.price,
            quantity: 1,
            status: plausibility.status,
            warnReason: plausibility.reason,
            availableFinishes: plausibility.available,
            createdAt: now,
            updatedAt: now,
          };
          const saved = await db.addRow(newRow);
          setRows((prev) => [...prev, saved]);
          if (saved.id != null) undoStack.current.push({ rowId: saved.id, wasNew: true });
          if (plausibility.status === 'warn') {
            showToast(`⚠ ${card.nameLocal} ${card.localId}: ${plausibility.reason}`, 'warn');
          } else {
            showToast(`${card.nameLocal} ${card.localId} hinzugefügt`, 'ok');
          }
        }
        if (navigator.vibrate) navigator.vibrate(40);
      } catch (err) {
        reportError(err);
      }
    },
    [batch, rows, reportError, showToast],
  );

  const addByNumber = useCallback(
    async (input: string): Promise<boolean> => {
      if (!activeSet) {
        showToast('Kein Set geladen – erst oben ein Set wählen.', 'error');
        return false;
      }
      const card = findCardByNumber(activeSet, input);
      if (!card) {
        showToast(
          `Nummer „${input}“ nicht in ${activeSet.name} (${activeSet.officialCount} Karten, gesamt ${activeSet.totalCount}).`,
          'error',
        );
        return false;
      }
      await addCard(card, activeSet);
      return true;
    },
    [activeSet, addCard, showToast],
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
        showToast(`${row.nameLocal} ${row.localId} entfernt`, 'ok');
      } else {
        const updated = { ...row, quantity: row.quantity - 1, updatedAt: Date.now() };
        await db.updateRow(updated);
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        showToast(`${row.nameLocal} ${row.localId} → Menge ${updated.quantity}`, 'ok');
      }
    } catch (err) {
      reportError(err);
    }
  }, [rows, reportError, showToast]);

  const changeRow = useCallback(
    async (row: ScanRow, patch: Partial<ScanRow>) => {
      try {
        let updated: ScanRow = { ...row, ...patch, updatedAt: Date.now() };
        // Finish geändert -> Plausibilität neu bewerten (anhand gespeicherter verfügbarer Finishes)
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

  const removeRow = useCallback(
    async (row: ScanRow) => {
      if (row.id == null) return;
      try {
        await db.deleteRow(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        undoStack.current = undoStack.current.filter((e) => e.rowId !== row.id);
        showToast(`${row.nameLocal} ${row.localId} gelöscht`, 'ok');
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

  const onSetStored = useCallback((set: SetInfo) => {
    setStoredSets((prev) => {
      const rest = prev.filter((s) => !(s.id === set.id && s.lang === set.lang));
      return [...rest, set];
    });
  }, []);

  const onSetDeleted = useCallback((set: SetInfo) => {
    setStoredSets((prev) => prev.filter((s) => !(s.id === set.id && s.lang === set.lang)));
  }, []);

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

      <BatchBar
        batch={batch}
        activeSet={activeSet}
        onChange={updateBatch}
        onOpenSetManager={() => setSetManagerOpen(true)}
      />

      {setManagerOpen && (
        <SetManager
          lang={batch.lang}
          storedSets={storedSets}
          activeSetId={batch.setId}
          onSelect={(setId) => {
            updateBatch({ setId });
            setSetManagerOpen(false);
          }}
          onStored={onSetStored}
          onDeleted={onSetDeleted}
          onClose={() => setSetManagerOpen(false)}
          onError={reportError}
        />
      )}

      <main className="main">
        <Scanner activeSet={activeSet} onHit={addByNumber} />
        <ManualEntry disabled={!activeSet} onSubmit={addByNumber} onUndo={undoLast} />
        <RowList rows={rows} onChange={changeRow} onRemove={removeRow} />
        <ExportPanel rows={rows} onClearAll={clearAllRows} />
      </main>

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
