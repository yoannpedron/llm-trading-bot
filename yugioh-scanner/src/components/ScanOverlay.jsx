import { ZONE_LIST, framePercent, zonePercent } from '../lib/zones.js';

const STATE_STYLE = {
  moving: { color: '#f59e0b', label: 'Stabilisez la carte' },
  settling: { color: '#22d3ee', label: 'Mise au point…' },
  idle: { color: '#64748b', label: 'Présentez une carte' },
  ready: { color: '#22d3ee', label: 'Lecture…' },
};

function Corner({ className, color }) {
  return (
    <span
      className={`absolute h-7 w-7 ${className}`}
      style={{ borderColor: color, animation: 'corner-pulse 2.4s ease-in-out infinite' }}
    />
  );
}

/**
 * Guides de visée superposés au flux vidéo.
 *
 * Les rectangles proviennent de `zones.js`, la même source que le recadrage
 * envoyé à Tesseract : ce que l'utilisateur aligne est littéralement ce qui
 * part à l'OCR.
 */
export default function ScanOverlay({ width, height, state, scanning, locked }) {
  if (!width || !height) return null;

  const frame = framePercent(width, height);
  const style = STATE_STYLE[state] ?? STATE_STYLE.idle;
  const color = locked ? '#34d399' : style.color;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Une ombre portée démesurée assombrit tout ce qui déborde du cadre :
          un seul élément, pas de masque à recalculer au redimensionnement. */}
      <div
        className="absolute rounded-[3%] shadow-[0_0_0_9999px_rgba(4,6,15,0.66)]"
        style={frame}
      />

      <div
        className="absolute rounded-[3%] transition-[box-shadow,border-color] duration-300"
        style={{
          ...frame,
          border: `1.5px solid ${color}`,
          boxShadow: `0 0 34px ${color}55, inset 0 0 34px ${color}22`,
        }}
      >
        <Corner className="-top-px -left-px border-t-2 border-l-2 rounded-tl-lg" color={color} />
        <Corner className="-top-px -right-px border-t-2 border-r-2 rounded-tr-lg" color={color} />
        <Corner
          className="-bottom-px -left-px border-b-2 border-l-2 rounded-bl-lg"
          color={color}
        />
        <Corner
          className="-bottom-px -right-px border-b-2 border-r-2 rounded-br-lg"
          color={color}
        />

        {scanning && (
          <div
            className="absolute inset-x-0 h-16"
            style={{
              background: `linear-gradient(to bottom, transparent, ${color}44 45%, ${color} 50%, ${color}44 55%, transparent)`,
              animation: 'scan-sweep 1.1s linear infinite',
            }}
          />
        )}
      </div>

      {ZONE_LIST.map((zone) => {
        const rect = zonePercent(zone, width, height);
        return (
          <div key={zone.id} className="absolute" style={rect}>
            <div
              className="h-full w-full rounded-[4px] transition-colors duration-300"
              style={{
                border: `1.5px dashed ${color}`,
                background: `${color}14`,
              }}
            />
            <span
              className="absolute -top-5 left-0 font-mono text-[10px] tracking-[0.2em] uppercase"
              style={{ color }}
            >
              {zone.label}
            </span>
            <span className="absolute -bottom-5 right-0 font-mono text-[10px] text-muted">
              {zone.hint}
            </span>
          </div>
        );
      })}

      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-full px-4 py-1.5 font-mono text-[11px] tracking-[0.18em] uppercase backdrop-blur-md"
        style={{
          top: `calc(${frame.top} - 2.75rem)`,
          color,
          background: `${color}14`,
          border: `1px solid ${color}44`,
        }}
      >
        {locked ? 'Carte verrouillée' : style.label}
      </div>
    </div>
  );
}
