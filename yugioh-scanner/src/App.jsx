import { useCallback, useEffect, useState } from 'react';

import Aurora from './components/Aurora.jsx';
import DataPanel from './components/DataPanel.jsx';
import HistoryTab from './components/HistoryTab.jsx';
import HoloCard from './components/HoloCard.jsx';
import SniperView from './components/SniperView.jsx';
import { cardDetail, usingBackend } from './lib/scanApi.js';
import { useCollection } from './lib/useCollection.js';
import { useSniper } from './lib/useSniper.js';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export default function App() {
  const sniper = useSniper();
  const collection = useCollection();

  const [tab, setTab] = useState('scan');
  const [rarity, setRarity] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [savedKey, setSavedKey] = useState(null);

  const scan = sniper.result;

  /* Un code vient d'être résolu : une seule rareté se valide d'office. */
  useEffect(() => {
    if (!scan) {
      setRarity(null);
      setDetail(null);
      setSavedKey(null);
      return;
    }
    setRarity(scan.rarities?.length === 1 ? scan.rarities[0] : null);
  }, [scan]);

  /* La fiche complète — nom, texte et statistiques en français — arrive après
     coup : la carte s'affiche sans l'attendre. */
  useEffect(() => {
    const cardId = scan?.card?.id;
    if (!cardId) return undefined;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    cardDetail(cardId, { language: 'fr' }, controller.signal)
      .then((found) => !controller.signal.aborted && setDetail(found))
      .catch((cause) => {
        if (cause.name !== 'AbortError') setError(cause.message);
      })
      .finally(() => !controller.signal.aborted && setLoading(false));

    return () => controller.abort();
  }, [scan?.card?.id]);

  const validate = useCallback(() => {
    if (!scan?.card || !rarity) return;
    const key = collection.track(
      {
        id: scan.card.id,
        name: detail?.name ?? scan.card.name,
        image: detail?.image ?? `https://images.ygoprodeck.com/images/cards/${scan.card.id}.jpg`,
        images: [
          {
            small:
              detail?.image_small ??
              `https://images.ygoprodeck.com/images/cards_small/${scan.card.id}.jpg`,
          },
        ],
        type: detail?.type,
        race: detail?.race,
        attribute: detail?.attribute,
        atk: detail?.atk,
        def: detail?.def,
        level: detail?.level,
      },
      {
        setCode: scan.matchedCode,
        setName: rarity.setName,
        rarity: rarity.rarity,
        rarityCode: rarity.rarityCode,
      },
    );
    setSavedKey(key);
  }, [scan, rarity, detail, collection]);

  const cancel = useCallback(() => {
    setSavedKey(null);
    sniper.rescan();
  }, [sniper]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Aurora enabled={!scan} />

      <header className="safe-top flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] tracking-[0.3em] text-cyan uppercase">
            Sniper · code d’extension
          </p>
          <h1 className="text-base font-bold tracking-tight">
            Scanner{' '}
            <span className="bg-gradient-to-r from-cyan via-violet to-amber bg-clip-text text-transparent">
              Yu-Gi-Oh!
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-[9px] text-muted"
            title={
              usingBackend()
                ? 'Résolution par l’API Python (SQLite + rapidfuzz)'
                : 'Résolution locale sur l’index embarqué — aucun serveur requis'
            }
          >
            {usingBackend() ? 'API' : 'LOCAL'}
          </span>
          <div className="flex rounded-xl border border-white/10 bg-black/40 p-1">
            {[
              ['scan', 'Scanner'],
              ['collection', `Collection${collection.entries.length ? ` ${collection.entries.length}` : ''}`],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id}
                className={`h-9 rounded-lg px-3 text-xs font-medium transition ${
                  tab === id ? 'bg-cyan/20 text-cyan' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {tab === 'collection' ? (
        <main className="rail min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          <div className="mx-auto max-w-3xl">
            <p className="mb-3 text-sm text-muted">
              Valeur totale&nbsp;: <strong>{EURO.format(collection.total)}</strong>
            </p>
            <HistoryTab collection={collection} onOpen={() => setTab('scan')} />
          </div>
        </main>
      ) : scan ? (
        /* Deux zones : le visuel en haut, les données en bas. En paysage et sur
           écran large, elles se placent côte à côte plutôt que l'une sous l'autre. */
        <main className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 px-3 pb-3 lg:grid-cols-2 lg:grid-rows-1 lg:items-center">
          <div className="flex min-h-0 min-w-0 items-center justify-center py-2">
            <HoloCard
              image={
                detail?.image ?? `https://images.ygoprodeck.com/images/cards/${scan.card.id}.jpg`
              }
              name={detail?.name ?? scan.card.name}
              rarity={rarity?.rarity}
            />
          </div>

          <DataPanel
            scan={scan}
            detail={detail}
            loading={loading}
            error={error}
            rarity={rarity}
            onRarity={setRarity}
            onValidate={validate}
            onCancel={cancel}
            saved={Boolean(savedKey)}
          />
        </main>
      ) : (
        <main className="min-h-0 flex-1">
          <SniperView sniper={sniper} />
        </main>
      )}
    </div>
  );
}
