import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Aurora from './components/Aurora.jsx';
import CardStage from './components/CardStage.jsx';
import HistoryTab from './components/HistoryTab.jsx';
import PricePanel from './components/PricePanel.jsx';
import RarityPicker from './components/RarityPicker.jsx';
import Scanner from './components/Scanner.jsx';
import { useCardScanner } from './lib/useCardScanner.js';
import { useCollection } from './lib/useCollection.js';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

const TABS = [
  { id: 'scan', label: 'Scanner' },
  { id: 'history', label: 'Historique' },
];

function Tabs({ tab, onTab, count, className = '' }) {
  return (
    <div className={`flex rounded-2xl border border-white/10 bg-black/40 p-1 ${className}`}>
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onTab(item.id)}
          aria-current={tab === item.id}
          className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition ${
            tab === item.id ? 'bg-cyan/20 text-cyan' : 'text-muted hover:text-ink'
          }`}
        >
          {item.label}
          {item.id === 'history' && count > 0 && (
            <span className="rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
              {count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Placeholder({ misses, modelReady }) {
  return (
    <div className="glass flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-3xl p-8 text-center lg:min-h-[420px]">
      <div className="relative">
        <div
          className="h-28 w-20 rounded-lg border border-dashed border-white/25"
          style={{ animation: 'halo-breathe 3.4s ease-in-out infinite' }}
        />
        <div className="absolute inset-0 rounded-lg bg-cyan/10 blur-xl" />
      </div>

      <div>
        <p className="font-medium">En attente d’une carte</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
          {modelReady
            ? 'Alignez le titre dans le cadre du haut et le code d’extension dans celui de droite.'
            : 'Chargement du modèle de reconnaissance…'}
        </p>
      </div>

      {misses >= 2 && (
        <p className="max-w-xs rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          Lecture difficile : rapprochez la carte, évitez les reflets directs et posez-la à plat.
        </p>
      )}
    </div>
  );
}

/** Une ligne d'historique redevient une sélection affichable. */
const entryToSelection = (entry) => ({
  key: entry.key,
  card: {
    id: entry.cardId,
    name: entry.name,
    image: entry.image,
    images: [{ small: entry.imageSmall }],
    rarities: [],
  },
  printing: {
    setCode: entry.setCode,
    setName: entry.setName,
    rarity: entry.rarity,
    rarityCode: entry.rarityCode,
  },
  via: null,
});

export default function App() {
  const [tab, setTab] = useState('scan');
  const scanner = useCardScanner({ active: tab === 'scan' });
  const collection = useCollection();

  const [selection, setSelection] = useState(null);
  const [trackedKey, setTrackedKey] = useState(null);
  const revealRef = useRef(null);

  /* Une identification arrive : elle remplace immédiatement l'affichage. */
  useEffect(() => {
    const found = scanner.result;
    if (!found) return;

    const printings = found.card.rarities ?? [];
    setSelection({
      key: `${found.card.id}-${found.setCode?.code ?? found.card.name}`,
      card: found.card,
      via: found.via,
      setCode: found.setCode,
      // Une seule rareté possible : on valide sans rien demander. Plusieurs :
      // c'est à l'utilisateur de trancher, la caméra ne voit pas l'holographie.
      printing: printings.length === 1 ? printings[0] : null,
    });
  }, [scanner.result]);

  /* Carte + rareté connues : on l'enregistre et sa cote suit. */
  useEffect(() => {
    if (!selection?.card || !selection.printing) {
      setTrackedKey(null);
      return;
    }
    setTrackedKey(collection.track(selection.card, selection.printing));
  }, [
    selection?.card?.id,
    selection?.printing?.setCode,
    selection?.printing?.rarity,
    collection.track,
  ]);

  /* Sur téléphone, la révélation est sous la caméra : on l'amène à l'écran. */
  useEffect(() => {
    if (!selection || tab !== 'scan') return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    revealRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selection?.key, tab]);

  const openFromHistory = useCallback((entry) => {
    setSelection(entryToSelection(entry));
    setTab('scan');
  }, []);

  const entry = trackedKey ? collection.entryFor(trackedKey) : null;
  const printings = useMemo(() => selection?.card?.rarities ?? [], [selection]);
  const rarity = selection?.printing?.rarity ?? null;

  return (
    <div className="min-h-full">
      <Aurora />

      <main className="safe-top mx-auto w-full max-w-6xl px-3 pt-6 pb-28 sm:px-6 sm:pb-12 lg:py-12">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] tracking-[0.3em] text-cyan uppercase">
              OCR · Tesseract.js
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-4xl">
              Scanner&nbsp;
              <span className="bg-gradient-to-r from-cyan via-violet to-amber bg-clip-text text-transparent">
                Yu-Gi-Oh!
              </span>
            </h1>
            <p className="mt-1 hidden max-w-xl text-sm text-muted sm:block">
              Présentez une carte : le titre et le code d’extension sont lus à la volée, la carte
              apparaît en haute définition et sa cote suit.
            </p>
          </div>

          <div className="glass rounded-2xl px-4 py-2 text-right">
            <p className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase">
              Collection
            </p>
            <p className="text-xl font-bold tabular-nums sm:text-2xl">
              {EURO.format(collection.total)}
            </p>
          </div>
        </header>

        <Tabs
          tab={tab}
          onTab={setTab}
          count={collection.entries.length}
          className="mb-5 hidden sm:flex"
        />

        {tab === 'scan' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Scanner scanner={scanner} locked={Boolean(selection)} compact={Boolean(selection)} />

            <div ref={revealRef} className="flex flex-col gap-4 scroll-mt-4">
              {selection ? (
                <>
                  <CardStage
                    key={selection.key}
                    card={selection.card}
                    rarity={rarity}
                    via={selection.via}
                  />

                  <RarityPicker
                    printings={printings}
                    selected={selection.printing}
                    onSelect={(printing) =>
                      setSelection((current) => ({ ...current, printing }))
                    }
                  />

                  {selection.printing ? (
                    <PricePanel
                      price={entry?.price ?? null}
                      loading={collection.pending.has(trackedKey)}
                      error={collection.errors.get(trackedKey) ?? null}
                      card={selection.card}
                      printing={selection.printing}
                    />
                  ) : (
                    <p className="glass rounded-2xl px-4 py-3 text-sm text-muted">
                      Choisissez la rareté ci-dessus pour afficher la cote.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setSelection(null);
                      scanner.clear();
                    }}
                    className="h-11 self-start rounded-xl border border-white/10 bg-white/5 px-4 text-sm transition hover:border-white/25 hover:bg-white/10"
                  >
                    Scanner une autre carte
                  </button>
                </>
              ) : (
                <Placeholder misses={scanner.misses} modelReady={scanner.modelReady} />
              )}
            </div>
          </div>
        ) : (
          <HistoryTab collection={collection} onOpen={openFromHistory} />
        )}

        <footer className="mt-10 text-center font-mono text-[11px] leading-relaxed text-muted/70">
          Données cartes&nbsp;: YGOPRODeck · Cotes&nbsp;: Cardmarket, avec repli YGOPRODeck
          <br />
          OCR exécuté dans le navigateur — aucune image n’est envoyée à un serveur.
        </footer>
      </main>

      {/* Sur téléphone, les onglets se posent sous le pouce. */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-abyss/85 px-3 pt-3 backdrop-blur-xl sm:hidden">
        <Tabs tab={tab} onTab={setTab} count={collection.entries.length} />
      </nav>
    </div>
  );
}
