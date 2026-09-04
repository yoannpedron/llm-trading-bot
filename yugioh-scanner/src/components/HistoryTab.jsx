import { useMemo, useState } from 'react';

import { conditionPrice } from '../lib/condition.js';
import { rarityProfile } from '../lib/rarity.js';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** Valeur affichée : celle de l'état retenu pour cet exemplaire. */
const priceOf = (entry) => conditionPrice(entry.price, entry.condition).value;

const SORTS = {
  recent: { label: 'Récentes', compare: (a, b) => b.seenAt - a.seenAt },
  value: { label: 'Valeur', compare: (a, b) => (priceOf(b) ?? -1) - (priceOf(a) ?? -1) },
  name: { label: 'Nom', compare: (a, b) => a.name.localeCompare(b.name, 'fr') },
};

function Toolbar({ collection, sort, onSort, query, onQuery }) {
  const { entries, refreshing, progress, refreshAll, exportCsv, clear, total } = collection;

  return (
    <div className="glass rounded-2xl p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
            {entries.length} carte{entries.length > 1 ? 's' : ''}
          </p>
          <p className="text-2xl font-bold tabular-nums">{EURO.format(total)}</p>
        </div>

        <button
          type="button"
          onClick={() => refreshAll()}
          disabled={refreshing || entries.length === 0}
          className="h-11 rounded-xl border border-white/10 bg-white/5 px-4 text-sm transition hover:border-cyan/50 hover:bg-cyan/10 disabled:opacity-40"
        >
          {refreshing ? `Cotes… ${progress.done}/${progress.total}` : 'Actualiser les cotes'}
        </button>

        <button
          type="button"
          onClick={exportCsv}
          disabled={entries.length === 0}
          className="h-11 rounded-xl border border-cyan/40 bg-cyan/15 px-4 text-sm text-cyan transition hover:bg-cyan/25 disabled:opacity-40"
        >
          Export CSV
        </button>

        <button
          type="button"
          onClick={() => {
            if (window.confirm('Vider tout l’historique ? Cette action est définitive.')) clear();
          }}
          disabled={entries.length === 0}
          className="h-11 rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-muted transition hover:border-amber/40 hover:text-amber disabled:opacity-40"
        >
          Vider
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filtrer par nom, code ou série…"
          className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 text-sm outline-none placeholder:text-muted/60 focus:border-cyan/50"
        />
        <div className="flex rounded-xl border border-white/10 bg-black/30 p-1">
          {Object.entries(SORTS).map(([key, option]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSort(key)}
              className={`h-9 rounded-lg px-3 text-xs transition ${
                sort === key ? 'bg-cyan/20 text-cyan' : 'text-muted hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ entry, pending, onOpen, onRemove }) {
  const profile = rarityProfile(entry.rarity);
  const price = priceOf(entry);

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 text-left transition active:scale-[0.99] hover:border-white/25 hover:bg-white/[0.06]"
      >
        <div
          className="h-[76px] w-[54px] shrink-0 overflow-hidden rounded-lg"
          style={{ boxShadow: `0 0 18px ${profile.glow}44` }}
        >
          <img
            src={entry.imageSmall ?? entry.image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{entry.name}</p>
          <p className="truncate font-mono text-[11px] text-muted">{entry.setCode}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <span
              className="inline-block rounded-full px-2 py-0.5 font-mono text-[10px]"
              style={{ color: profile.accent, background: `${profile.glow}1f` }}
            >
              {entry.rarity || 'rareté inconnue'}
            </span>
            {entry.condition && (
              <span className="inline-block rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-muted">
                {entry.condition}
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          {pending ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-cyan/30 border-t-cyan" />
          ) : (
            <>
              <p className="text-lg font-bold tabular-nums">
                {price === null ? '—' : EURO.format(price)}
              </p>
              <p className="font-mono text-[10px] text-muted">
                {entry.price?.source === 'cardmarket' ? 'Cardmarket' : 'YGOPRODeck'}
              </p>
            </>
          )}
          {entry.count > 1 && (
            <p className="font-mono text-[10px] text-muted">×{entry.count}</p>
          )}
        </div>
      </button>

      <button
        type="button"
        onClick={() => onRemove(entry.key)}
        aria-label={`Retirer ${entry.name}`}
        className="absolute top-1 right-1 grid h-8 w-8 place-items-center rounded-lg text-muted opacity-60 transition hover:bg-amber/15 hover:text-amber sm:opacity-0 sm:group-hover:opacity-100"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
          <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" />
        </svg>
      </button>
    </li>
  );
}

/**
 * Onglet historique.
 *
 * L'historique vit dans le navigateur et se recharge à chaque ouverture du
 * site, cotes comprises. Il est aussi la source du CSV : ce qui est listé ici
 * est exactement ce qui sera exporté, filtre compris.
 */
export default function HistoryTab({ collection, onOpen }) {
  const [sort, setSort] = useState('recent');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return collection.entries
      .filter((entry) =>
        needle
          ? `${entry.name} ${entry.setCode} ${entry.setName} ${entry.rarity} ${entry.condition ?? ''}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort(SORTS[sort].compare);
  }, [collection.entries, query, sort]);

  return (
    <div className="flex flex-col gap-3">
      <Toolbar
        collection={collection}
        sort={sort}
        onSort={setSort}
        query={query}
        onQuery={setQuery}
      />

      {collection.entries.length === 0 ? (
        <div className="glass grid min-h-[300px] place-items-center rounded-2xl p-8 text-center">
          <div>
            <p className="font-medium">Aucune carte pour l’instant</p>
            <p className="mt-1 text-sm text-muted">
              Les cartes scannées s’accumulent ici, avec leur cote. Rien ne quitte votre appareil.
            </p>
          </div>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {visible.map((entry) => (
            <Row
              key={entry.key}
              entry={entry}
              pending={collection.pending.has(entry.key)}
              onOpen={onOpen}
              onRemove={collection.remove}
            />
          ))}
        </ul>
      )}

      {visible.length === 0 && collection.entries.length > 0 && (
        <p className="py-6 text-center text-sm text-muted">Aucune carte ne correspond au filtre.</p>
      )}
    </div>
  );
}
