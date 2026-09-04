import { useEffect } from 'react';

import { SCHEMA } from '../lib/settings.js';

function Toggle({ item, value, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(item.key, !value)}
      className="flex w-full items-start gap-3 rounded-xl p-2 text-left transition hover:bg-white/5"
    >
      <span
        className={`mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
          value ? 'bg-cyan/70' : 'bg-white/15'
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white transition-transform ${
            value ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{item.label}</span>
        <span className="block text-xs leading-relaxed text-muted">{item.hint}</span>
      </span>
    </button>
  );
}

function Choice({ item, value, onChange }) {
  return (
    <div className="rounded-xl p-2">
      <p className="text-sm font-medium">{item.label}</p>
      <p className="mb-2 text-xs leading-relaxed text-muted">{item.hint}</p>
      <div className="flex flex-wrap gap-2">
        {item.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(item.key, option.value)}
            className={`h-10 rounded-lg border px-3 text-xs transition ${
              value === option.value
                ? 'border-cyan bg-cyan/20 text-cyan'
                : 'border-white/10 bg-white/[0.04] text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Panneau de réglages.
 *
 * Entièrement dessiné à partir du schéma de `settings.js` : ajouter une option
 * là-bas la fait apparaître ici, avec son libellé et son explication. Rien à
 * synchroniser entre les deux.
 */
export default function SettingsPanel({ open, onClose, settings, onChange, onReset }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        type="button"
        aria-label="Fermer les réglages"
        onClick={onClose}
        className="absolute inset-0 bg-abyss/70 backdrop-blur-sm"
      />

      <aside
        role="dialog"
        aria-label="Réglages"
        className="safe-top safe-bottom relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-abyss-soft/95 backdrop-blur-2xl"
        style={{ animation: 'rise-in 0.28s cubic-bezier(0.22,1,0.36,1) both' }}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-lg font-semibold">Réglages</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5 transition hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" />
            </svg>
          </button>
        </header>

        <div className="rail flex-1 overflow-y-auto px-3 py-4">
          {SCHEMA.map((group) => (
            <section key={group.section} className="mb-5">
              <h3 className="mb-1 px-2 font-mono text-[10px] tracking-[0.22em] text-cyan uppercase">
                {group.section}
              </h3>
              <div className="grid gap-1">
                {group.items.map((item) =>
                  item.type === 'toggle' ? (
                    <Toggle
                      key={item.key}
                      item={item}
                      value={settings[item.key]}
                      onChange={onChange}
                    />
                  ) : (
                    <Choice
                      key={item.key}
                      item={item}
                      value={settings[item.key]}
                      onChange={onChange}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>

        <footer className="border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onReset}
            className="h-11 w-full rounded-xl border border-white/10 bg-white/5 text-sm transition hover:border-amber/40 hover:text-amber"
          >
            Rétablir les valeurs par défaut
          </button>
        </footer>
      </aside>
    </div>
  );
}
