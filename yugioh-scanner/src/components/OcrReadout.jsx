/**
 * Bandeau de diagnostic : ce que Tesseract a réellement lu, et sur quelles
 * images. Sans lui, un échec de reconnaissance reste une boîte noire ; avec lui,
 * on voit immédiatement si le problème vient du cadrage, de la lumière ou du
 * seuil de binarisation.
 */
export default function OcrReadout({ reading, crops, scanning }) {
  const rows = [
    { label: 'Code', value: reading.setCode?.code, raw: reading.rawCode, image: crops.setCode },
    { label: 'Titre', value: reading.title, raw: reading.rawTitle, image: crops.title },
  ];

  return (
    <div className="glass rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
          Lecture OCR
        </span>
        <span
          className={`h-1.5 w-1.5 rounded-full transition-colors ${
            scanning ? 'bg-cyan shadow-[0_0_10px_#22d3ee]' : 'bg-white/20'
          }`}
        />
      </div>

      <div className="grid gap-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="w-10 shrink-0 font-mono text-[10px] text-muted uppercase">
              {row.label}
            </span>

            <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg bg-black/40 px-2">
              <span
                className={`truncate font-mono text-xs ${
                  row.value ? 'text-cyan' : 'text-muted/60'
                }`}
                title={row.raw || undefined}
              >
                {row.value || (row.raw ? `« ${row.raw} »` : '—')}
              </span>
            </div>

            {/* L'image binarisée telle qu'elle part au moteur. */}
            <div className="h-8 w-24 shrink-0 overflow-hidden rounded-lg bg-black/60 ring-1 ring-white/10">
              {row.image && (
                <img
                  src={row.image}
                  alt={`Zone ${row.label} après prétraitement`}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
