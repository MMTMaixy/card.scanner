import { useRef, useState } from 'react';

interface Props {
  disabled: boolean;
  onSubmit: (input: string) => Promise<boolean>;
  onUndo: () => void;
}

/** Manuelle Eingabe der Sammlernummer — der Weg aus Meilenstein 1, bleibt immer verfügbar. */
export function ManualEntry({ disabled, onSubmit, onUndo }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const v = value.trim();
    if (!v) return;
    const ok = await onSubmit(v);
    if (ok) setValue('');
    inputRef.current?.focus();
  }

  return (
    <section className="card-section manual-entry">
      <h2>Nummer eingeben</h2>
      <div className="manual-entry-row">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          placeholder={disabled ? 'Erst Set wählen …' : 'z. B. 136 oder TG12'}
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button className="primary" disabled={disabled || !value.trim()} onClick={() => void submit()}>
          Hinzufügen
        </button>
        <button onClick={onUndo} title="Letzten Scan rückgängig machen">
          ↩ Rückgängig
        </button>
      </div>
    </section>
  );
}
