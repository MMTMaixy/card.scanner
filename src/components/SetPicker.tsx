import { useMemo, useState } from 'react';
import { searchSets, setName, type SetIndexEntry } from '../logic/setIndex';
import type { Language } from '../types';

interface Props {
  title: string;
  /** Erklärender Hinweis, warum gefragt wird */
  hint?: string;
  lang: Language;
  /** Vorgeschlagene Sets (aus Set-Code oder Nenner) */
  candidates: SetIndexEntry[];
  /** Alle Sets für die manuelle Suche */
  allSets: SetIndexEntry[];
  recent: string[];
  onPick: (entry: SetIndexEntry) => void;
  onCancel: () => void;
}

/**
 * Auswahl des Sets: zuerst die erkannten Kandidaten (ein Tap genügt),
 * darunter die vollständige Suche. Zuletzt genutzte Sets stehen oben —
 * beim Sortieren kommen meist viele Karten aus demselben Set nacheinander.
 */
export function SetPicker({ title, hint, lang, candidates, allSets, recent, onPick, onCancel }: Props) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(candidates.length === 0);

  const results = useMemo(
    () => searchSets(allSets, lang, query, recent).slice(0, 60),
    [allSets, lang, query, recent],
  );

  const recentEntries = useMemo(
    () =>
      recent
        .map((id) => allSets.find((s) => s.id === id))
        .filter((s): s is SetIndexEntry => !!s && !!s.names[lang])
        .slice(0, 6),
    [recent, allSets, lang],
  );

  function row(entry: SetIndexEntry, badge?: string) {
    return (
      <li key={entry.id}>
        <button className="set-select" onClick={() => onPick(entry)}>
          <span className="set-name">
            {setName(entry, lang)}
            {entry.code && <span className="set-code">{entry.code}</span>}
          </span>
          <span className="set-meta">
            {entry.official} Karten
            {entry.total > entry.official ? ` (+${entry.total - entry.official} Secret)` : ''}
            {badge ? ` · ${badge}` : ''}
          </span>
        </button>
      </li>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button onClick={onCancel}>Abbrechen</button>
        </div>
        {hint && <p className="muted">{hint}</p>}

        {candidates.length > 0 && (
          <section>
            <h3>Erkannt – bitte bestätigen</h3>
            <ul className="set-list">{candidates.map((c) => row(c))}</ul>
          </section>
        )}

        {!showAll && (
          <button className="link-button" onClick={() => setShowAll(true)}>
            Anderes Set wählen …
          </button>
        )}

        {showAll && (
          <section>
            <h3>Alle Sets</h3>
            {recentEntries.length > 0 && !query && (
              <ul className="set-list">{recentEntries.map((e) => row(e, 'zuletzt genutzt'))}</ul>
            )}
            <input
              className="search"
              type="search"
              placeholder="Set suchen (Name, Kennung oder Code) …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul className="set-list">{results.map((e) => row(e))}</ul>
            {results.length === 0 && <p className="muted">Nichts gefunden.</p>}
          </section>
        )}
      </div>
    </div>
  );
}
