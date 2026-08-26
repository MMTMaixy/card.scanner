import { useEffect, useMemo, useState } from 'react';
import { downloadSet, fetchSetList, type SetDownloadProgress } from '../api/tcgdex';
import * as db from '../db';
import type { Language, SetInfo, SetListEntry } from '../types';

interface Props {
  lang: Language;
  storedSets: SetInfo[];
  activeSetId: string | null;
  onSelect: (setId: string) => void;
  onStored: (set: SetInfo) => void;
  onDeleted: (set: SetInfo) => void;
  onClose: () => void;
  onError: (err: unknown) => void;
}

export function SetManager({ lang, storedSets, activeSetId, onSelect, onStored, onDeleted, onClose, onError }: Props) {
  const [setList, setSetList] = useState<SetListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<SetDownloadProgress | null>(null);

  const storedForLang = useMemo(
    () => storedSets.filter((s) => s.lang === lang).sort((a, b) => b.fetchedAt - a.fetchedAt),
    [storedSets, lang],
  );
  const storedIds = useMemo(() => new Set(storedForLang.map((s) => s.id)), [storedForLang]);

  useEffect(() => {
    let cancelled = false;
    setSetList(null);
    setListError(null);
    fetchSetList(lang)
      .then((list) => {
        if (!cancelled) setSetList(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(
            `Set-Liste konnte nicht geladen werden (offline?). Bereits geladene Sets unten sind trotzdem nutzbar. – ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const filtered = useMemo(() => {
    if (!setList) return [];
    const q = search.trim().toLowerCase();
    if (!q) return setList;
    return setList.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }, [setList, search]);

  async function handleDownload(entry: SetListEntry) {
    setDownloading(entry.id);
    setProgress(null);
    try {
      const set = await downloadSet(lang, entry.id, setProgress);
      await db.putStoredSet(set);
      onStored(set);
      if (!set.variantsComplete) {
        onError(
          new Error(
            `Set „${set.name}“ wurde geladen, aber für einige Karten fehlen die Finish-Daten (Netzwerkprobleme beim Laden). Du kannst das Set später erneut laden.`,
          ),
        );
      }
      onSelect(set.id);
    } catch (err) {
      onError(err);
    } finally {
      setDownloading(null);
      setProgress(null);
    }
  }

  async function handleDelete(set: SetInfo) {
    if (!confirm(`Set „${set.name}“ (${set.lang.toUpperCase()}) aus dem lokalen Speicher löschen?`)) return;
    try {
      await db.deleteStoredSet(set.lang, set.id);
      await db.deleteHashIndex(set.id);
      onDeleted(set);
    } catch (err) {
      onError(err);
    }
  }

  function progressText(p: SetDownloadProgress | null): string {
    if (!p) return 'Starte …';
    if (p.step === 'meta') return 'Lade Set-Infos …';
    if (p.step === 'names-en') return 'Lade englische Namen …';
    return `Lade Karten ${p.done}/${p.total} …`;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Sets ({lang.toUpperCase()})</h2>
          <button onClick={onClose}>Schließen</button>
        </div>

        {storedForLang.length > 0 && (
          <section>
            <h3>Geladen (offline verfügbar)</h3>
            <ul className="set-list">
              {storedForLang.map((s) => (
                <li key={s.id} className={s.id === activeSetId ? 'active' : ''}>
                  <button className="set-select" onClick={() => onSelect(s.id)}>
                    <span className="set-name">{s.name}</span>
                    <span className="set-meta">
                      {s.cards.length} Karten · geladen {new Date(s.fetchedAt).toLocaleDateString('de-DE')}
                      {s.variantsComplete ? '' : ' · ⚠ Finish-Daten unvollständig'}
                    </span>
                  </button>
                  <button className="danger" onClick={() => handleDelete(s)}>
                    Löschen
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3>Alle Sets</h3>
          <input
            className="search"
            type="search"
            placeholder="Set suchen (Name oder Kürzel) …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {listError && <p className="inline-error">{listError}</p>}
          {!setList && !listError && <p className="muted">Lade Set-Liste …</p>}
          <ul className="set-list">
            {filtered.slice(0, 60).map((entry) => (
              <li key={entry.id}>
                <div className="set-select">
                  <span className="set-name">{entry.name}</span>
                  <span className="set-meta">
                    {entry.id} · {entry.officialCount} Karten
                    {entry.totalCount > entry.officialCount ? ` (+${entry.totalCount - entry.officialCount} Secret)` : ''}
                  </span>
                </div>
                {downloading === entry.id ? (
                  <span className="progress">{progressText(progress)}</span>
                ) : storedIds.has(entry.id) ? (
                  <button onClick={() => handleDownload(entry)} disabled={downloading != null}>
                    Neu laden
                  </button>
                ) : (
                  <button onClick={() => handleDownload(entry)} disabled={downloading != null}>
                    Laden
                  </button>
                )}
              </li>
            ))}
          </ul>
          {setList && filtered.length > 60 && (
            <p className="muted">{filtered.length - 60} weitere – Suche verfeinern.</p>
          )}
        </section>
      </div>
    </div>
  );
}
