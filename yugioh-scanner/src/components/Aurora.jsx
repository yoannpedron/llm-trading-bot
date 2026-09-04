/**
 * Fond animé : trois masses de couleur qui dérivent derrière une grille fine.
 * Purement décoratif, donc `aria-hidden` et `pointer-events-none`.
 */
export default function Aurora({ enabled = true }) {
  if (!enabled) {
    return (
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-abyss" />
    );
  }

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-abyss" />

      <div
        className="absolute -top-1/3 -left-1/4 h-[70vmax] w-[70vmax] rounded-full opacity-45 blur-[120px]"
        style={{
          background: 'radial-gradient(circle, #7c3aed 0%, transparent 62%)',
          animation: 'aurora-drift 26s ease-in-out infinite',
        }}
      />
      <div
        className="absolute -right-1/4 top-1/4 h-[60vmax] w-[60vmax] rounded-full opacity-40 blur-[120px]"
        style={{
          background: 'radial-gradient(circle, #06b6d4 0%, transparent 62%)',
          animation: 'aurora-drift 32s ease-in-out infinite reverse',
        }}
      />
      <div
        className="absolute bottom-[-25%] left-1/3 h-[55vmax] w-[55vmax] rounded-full opacity-25 blur-[130px]"
        style={{
          background: 'radial-gradient(circle, #f59e0b 0%, transparent 65%)',
          animation: 'aurora-drift 38s ease-in-out infinite',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black 10%, transparent 72%)',
        }}
      />
    </div>
  );
}
