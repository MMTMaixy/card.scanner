import type { BatchSettings, Condition, Finish, Language } from '../types';
import { CONDITIONS, FINISH_LABELS, LANGUAGES } from '../types';

interface Props {
  batch: BatchSettings;
  onChange: (patch: Partial<BatchSettings>) => void;
}

/**
 * Feste Leiste oben: Sprache, Finish, Zustand und Preis gelten für alle
 * folgenden Scans. Das Set wird NICHT mehr vorgewählt — es wird pro Karte
 * aus dem aufgedruckten Set-Code bzw. dem Nenner bestimmt.
 */
export function BatchBar({ batch, onChange }: Props) {
  return (
    <header className="batch-bar">
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
