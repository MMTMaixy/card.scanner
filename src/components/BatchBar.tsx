import type { BatchSettings, Condition, Finish, Language, SetInfo } from '../types';
import { CONDITIONS, FINISH_LABELS, LANGUAGES } from '../types';

interface Props {
  batch: BatchSettings;
  activeSet: SetInfo | undefined;
  onChange: (patch: Partial<BatchSettings>) => void;
  onOpenSetManager: () => void;
}

/**
 * Feste Leiste oben: die Batch-Einstellungen gelten für alle folgenden Scans
 * und müssen jederzeit sichtbar sein, damit nicht 80 Karten mit falscher
 * Einstellung gescannt werden.
 */
export function BatchBar({ batch, activeSet, onChange, onOpenSetManager }: Props) {
  return (
    <header className="batch-bar">
      <button
        className={`set-button ${activeSet ? '' : 'set-button-missing'}`}
        onClick={onOpenSetManager}
        title="Set wählen oder laden"
      >
        {activeSet ? (
          <>
            <span className="set-name">{activeSet.name}</span>
            <span className="set-meta">
              {activeSet.officialCount} Karten{activeSet.totalCount > activeSet.officialCount ? ` (+${activeSet.totalCount - activeSet.officialCount} Secret)` : ''}
            </span>
          </>
        ) : (
          <span className="set-name">Set wählen …</span>
        )}
      </button>

      <label className="batch-field">
        <span>Sprache</span>
        <select value={batch.lang} onChange={(e) => onChange({ lang: e.target.value as Language })}>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label className="batch-field">
        <span>Finish</span>
        <select value={batch.finish} onChange={(e) => onChange({ finish: e.target.value as Finish })}>
          {(Object.keys(FINISH_LABELS) as Finish[]).map((f) => (
            <option key={f} value={f}>
              {FINISH_LABELS[f]}
            </option>
          ))}
        </select>
      </label>

      <label className="batch-field">
        <span>Zustand</span>
        <select value={batch.condition} onChange={(e) => onChange({ condition: e.target.value as Condition })}>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="batch-field">
        <span>Preis €</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="leer"
          value={batch.price}
          onChange={(e) => onChange({ price: e.target.value.replace(',', '.') })}
        />
      </label>
    </header>
  );
}
