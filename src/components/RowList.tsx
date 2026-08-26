import { useRef, useState } from 'react';
import type { Condition, Finish, ScanRow } from '../types';
import { CONDITIONS, FINISH_LABELS } from '../types';

interface Props {
  rows: ScanRow[];
  onChange: (row: ScanRow, patch: Partial<ScanRow>) => void;
  onRemove: (row: ScanRow) => void;
}

/** Ergebnisliste: neueste zuerst, jede Zeile editierbar, Wisch nach links löscht. */
export function RowList({ rows, onChange, onRemove }: Props) {
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const totalArticles = rows.reduce((sum, r) => sum + r.quantity, 0);
  const warnCount = rows.filter((r) => r.status === 'warn').length;

  return (
    <section className="card-section">
      <h2>
        Liste{' '}
        <span className="muted">
          ({rows.length} Positionen, {totalArticles} Artikel
          {warnCount > 0 ? `, ${warnCount} zu prüfen` : ''})
        </span>
      </h2>
      {sorted.length === 0 && <p className="muted">Noch keine Karten gescannt.</p>}
      <ul className="row-list">
        {sorted.map((row) => (
          <RowItem key={row.id} row={row} onChange={onChange} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}

function RowItem({ row, onChange, onRemove }: { row: ScanRow; onChange: Props['onChange']; onRemove: Props['onRemove'] }) {
  const [dragX, setDragX] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (Math.abs(dy) > Math.abs(dx)) return; // vertikal scrollen lassen
    if (dx < 0) setDragX(Math.max(dx, -140));
  }
  function onTouchEnd() {
    if (dragX < -90) {
      onRemove(row);
    }
    setDragX(0);
    touchStart.current = null;
  }

  return (
    <li
      id={`row-${row.id}`}
      className={`row-item ${row.status === 'warn' ? 'row-warn' : ''}`}
      style={dragX !== 0 ? { transform: `translateX(${dragX}px)` } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="row-main">
        <div className="row-title">
          <span className="row-number">#{row.localId}</span>
          <span className="row-name">{row.nameLocal}</span>
          {row.nameEn && row.nameEn !== row.nameLocal && <span className="row-name-en">({row.nameEn})</span>}
          <span className="row-set muted">
            {row.setName} · {row.lang.toUpperCase()}
            {row.price.trim() ? ` · ${row.price.trim()} €` : ''}
          </span>
        </div>

        <div className="row-controls">
          <select
            value={row.finish}
            onChange={(e) => onChange(row, { finish: e.target.value as Finish })}
            title="Finish"
          >
            {(Object.keys(FINISH_LABELS) as Finish[]).map((f) => (
              <option key={f} value={f}>
                {FINISH_LABELS[f]}
              </option>
            ))}
          </select>
          <select
            value={row.condition}
            onChange={(e) => onChange(row, { condition: e.target.value as Condition })}
            title="Zustand"
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="qty">
            <button
              onClick={() =>
                row.quantity > 1 ? onChange(row, { quantity: row.quantity - 1 }) : onRemove(row)
              }
            >
              −
            </button>
            <span>{row.quantity}</span>
            <button onClick={() => onChange(row, { quantity: row.quantity + 1 })}>+</button>
          </div>
          <button className="danger" onClick={() => onRemove(row)} title="Zeile löschen">
            ✕
          </button>
        </div>
      </div>

      {row.status === 'warn' && (
        <div className="row-warn-box">
          <p>⚠ {row.warnReason}</p>
          <div className="row-warn-actions">
            {row.availableFinishes.map((f) => (
              <button key={f} className="chip" onClick={() => onChange(row, { finish: f })}>
                Auf {FINISH_LABELS[f]} ändern
              </button>
            ))}
            <button
              className="chip chip-outline"
              onClick={() => onChange(row, { status: 'ok', warnReason: undefined })}
              title="Datenbank kann irren – Finish bewusst so lassen"
            >
              Trotzdem als {FINISH_LABELS[row.finish]} behalten
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
