import { useMemo, useState } from 'react';
import { buildExportFiles } from '../logic/csv';
import type { ScanRow } from '../types';
import { FINISH_LABELS } from '../types';

interface Props {
  rows: ScanRow[];
  onClearAll: () => void;
}

export function ExportPanel({ rows, onClearAll }: Props) {
  const [generated, setGenerated] = useState<{ filename: string; url: string; label: string }[] | null>(null);

  const result = useMemo(() => buildExportFiles(rows), [rows]);
  const blocked = result.blockedRows.length;

  function jumpToFirstWarn() {
    const first = rows
      .filter((r) => r.status === 'warn')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (first?.id != null) {
      document.getElementById(`row-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function generate() {
    // Alte Object-URLs freigeben
    generated?.forEach((g) => URL.revokeObjectURL(g.url));
    const files = result.files.map((f) => {
      const blob = new Blob([f.content], { type: 'text/csv;charset=utf-8' });
      return {
        filename: f.filename,
        url: URL.createObjectURL(blob),
        label: `${f.setName} · ${FINISH_LABELS[f.finish]}${f.chunkTotal > 1 ? ` · Teil ${f.chunkIndex}/${f.chunkTotal}` : ''} — ${f.rowCount} Zeilen, ${f.articleCount} Artikel`,
      };
    });
    setGenerated(files);
  }

  const hasReverse = result.files.some((f) => f.finish === 'reverse');

  return (
    <section className="card-section">
      <h2>CSV-Export</h2>

      {rows.length === 0 && <p className="muted">Noch nichts zu exportieren.</p>}

      {blocked > 0 && (
        <div className="export-blocked">
          <p>
            ⚠ {blocked} gelbe {blocked === 1 ? 'Position' : 'Positionen'} in der Liste. Der Export ist blockiert,
            bis alle aufgelöst sind (Finish korrigieren oder bewusst behalten).
          </p>
          <button onClick={jumpToFirstWarn}>Zur ersten gelben Karte</button>
        </div>
      )}

      {rows.length > 0 && blocked === 0 && (
        <>
          <p className="muted">
            {result.files.length} {result.files.length === 1 ? 'Datei' : 'Dateien'} (getrennt nach Set und Finish,
            max. 100 Artikel pro Datei — Cardmarket-Limit).
          </p>
          <button className="primary" onClick={generate}>
            CSV-Dateien erzeugen
          </button>
        </>
      )}

      {generated && blocked === 0 && (
        <ul className="file-list">
          {generated.map((g) => (
            <li key={g.filename}>
              <a href={g.url} download={g.filename}>
                ⬇ {g.filename}
              </a>
              <span className="muted">{g.label}</span>
            </li>
          ))}
        </ul>
      )}

      {generated && hasReverse && blocked === 0 && (
        <p className="hint">
          Hinweis: Die Import-Extension kann für Pokémon das Reverse-Holo-Häkchen nicht setzen. Bei
          Reverse-Dateien nach dem Befüllen des Formulars die Reverse-Häkchen der befüllten Zeilen von Hand
          anhaken (die Datei enthält ausschließlich Reverse-Karten).
        </p>
      )}

      {rows.length > 0 && (
        <button
          className="danger clear-all"
          onClick={() => {
            if (confirm(`Wirklich alle ${rows.length} Positionen löschen? (Nach erfolgreichem Export sinnvoll.)`)) {
              onClearAll();
              setGenerated(null);
            }
          }}
        >
          Liste leeren
        </button>
      )}
    </section>
  );
}
