import { useCallback, useEffect, useMemo, useState } from 'react';

import FicheCarte from './components/FicheCarte.jsx';
import HoloCard from './components/HoloCard.jsx';
import Inventaire from './components/Inventaire.jsx';
import Journal from './components/Journal.jsx';
import SniperView from './components/SniperView.jsx';
import { entreeDepuisScan, ficheDepuisScan } from './lib/fiche.js';
import { cardDetail, usingBackend } from './lib/scanApi.js';
import { useCollection } from './lib/useCollection.js';
import { useJournal } from './lib/useJournal.js';
import { useSniper } from './lib/useSniper.js';

/**
 * Châssis de l'application.
 *
 * Son rôle se limite à trois choses : tenir l'en-tête, aiguiller entre les deux
 * onglets, et relier le scanner à l'inventaire. Tout le reste a été déplacé —
 * la construction de l'entrée d'inventaire dans `lib/fiche.js`, les adresses de
 * visuels dans `lib/images.js`, les formateurs dans `lib/format.js`. Ce fichier
 * décrivait auparavant la forme d'une entrée de collection et fabriquait des URL
 * à la main : ce n'est pas le travail d'un composant racine.
 *
 * L'état de navigation vit ici parce qu'il ne concerne que ce niveau. L'état du
 * scanner vit dans `useSniper`, celui de l'inventaire dans `useCollection` :
 * les deux survivent au changement d'onglet, ce qui est indispensable — la
 * caméra ne doit pas se rouvrir à chaque aller-retour.
 */

const ONGLETS = [
  { id: 'scan', libelle: 'Scanner' },
  { id: 'inventaire', libelle: 'Inventaire' },
  { id: 'journal', libelle: 'Journal' },
];

export default function App() {
  const sniper = useSniper();
  const collection = useCollection();
  const journal = useJournal();

  const [onglet, setOnglet] = useState('scan');
  const [rarete, setRarete] = useState(null);
  const [detail, setDetail] = useState(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState(null);
  const [enregistree, setEnregistree] = useState(false);

  const scan = sniper.result;
  const fiche = useMemo(() => ficheDepuisScan(scan, detail), [scan, detail]);

  /* Un code vient d'être résolu : une seule rareté se retient d'office. */
  useEffect(() => {
    setEnregistree(false);
    if (!scan) {
      setRarete(null);
      setDetail(null);
      return;
    }
    setRarete(scan.rarities?.length === 1 ? scan.rarities[0] : null);
  }, [scan]);

  /* Toute identification s'inscrit au journal, enregistrée ou non. On consigne
     dès la résolution et non à la validation : une carte écartée est
     précisément ce qu'on cherche à retrouver plus tard. La fiche complète
     n'est pas attendue — le nom français arrivera, la trace compte d'abord. */
  useEffect(() => {
    if (!scan?.card) return;
    journal.consignerIdentification(ficheDepuisScan(scan, null));
    // Volontairement lié au seul scan : un rafraîchissement de la fiche
    // détaillée ne doit pas produire une seconde ligne.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  /* La fiche complète — nom, texte et caractéristiques en français — arrive
     après coup : la carte s'affiche sans l'attendre. */
  useEffect(() => {
    const identifiant = scan?.card?.id;
    if (!identifiant) return undefined;

    const controleur = new AbortController();
    setChargement(true);
    setErreur(null);

    cardDetail(identifiant, { language: 'fr' }, controleur.signal)
      .then((trouve) => !controleur.signal.aborted && setDetail(trouve))
      .catch((cause) => {
        if (cause.name !== 'AbortError') setErreur(cause.message);
      })
      .finally(() => !controleur.signal.aborted && setChargement(false));

    return () => controleur.abort();
  }, [scan?.card?.id]);

  const enregistrer = useCallback(() => {
    const entree = entreeDepuisScan(scan, detail, rarete);
    if (!entree) return;
    collection.track(entree.carte, entree.tirage);
    journal.consignerEnregistrement(entree.carte.id);
    setEnregistree(true);
  }, [scan, detail, rarete, collection, journal]);

  const reprendre = useCallback(() => {
    setEnregistree(false);
    sniper.rescan();
  }, [sniper]);

  /* Ouvrir une carte de l'inventaire ramène au scanner, prêt à viser. */
  const revenirAuScanner = useCallback(() => {
    setOnglet('scan');
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-fond">
      <header className="safe-top shrink-0 border-b border-trait bg-panneau">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-baseline gap-3">
            {/* Sur téléphone, l'espace revient aux onglets : le nom complet
                se tronquait en « SCANNER YU-GI-… », ce qui ne dit rien. */}
            <h1 className="text-donnee font-semibold tracking-[0.14em] text-encre uppercase">
              {/* Trois onglets tiennent mal à côté du nom complet sur un
                  téléphone : les onglets sont la navigation, ils priment. */}
              <span className="sm:hidden">YGO</span>
              <span className="hidden sm:inline">Scanner Yu-Gi-Oh</span>
            </h1>
            {/* D'où vient la résolution. C'est une donnée d'exploitation, pas
                une décoration : elle explique pourquoi une lecture aboutit ou
                non, et elle a sa place dans l'en-tête d'un outil. */}
            <span
              className="hidden shrink-0 rounded-controle border border-trait px-1.5 py-0.5 font-mono text-micro text-tertiaire sm:inline"
              title={
                usingBackend()
                  ? 'Résolution par l’API Python (SQLite et rapidfuzz)'
                  : 'Résolution locale sur l’index embarqué, sans serveur'
              }
            >
              {usingBackend() ? 'API' : 'LOCAL'}
            </span>
          </div>

          {/* Onglets soulignés plutôt que pastilles colorées : c'est la
              convention d'un outil, et l'onglet actif se lit sans couleur de
              fond. */}
          <nav aria-label="Sections" className="flex h-full shrink-0 items-stretch">
            {ONGLETS.map(({ id, libelle }) => {
              const actif = onglet === id;
              const compte =
                id === 'inventaire' ? collection.entries.length : id === 'journal' ? journal.compte.total : 0;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setOnglet(id)}
                  aria-current={actif ? 'page' : undefined}
                  className={`relative flex items-center gap-1.5 px-3 text-donnee font-medium transition-colors ${
                    actif ? 'text-encre' : 'text-tertiaire hover:text-second'
                  }`}
                >
                  {libelle}
                  {compte > 0 && (
                    <span className="donnee text-micro text-tertiaire">{compte}</span>
                  )}
                  <span
                    aria-hidden
                    className={`absolute inset-x-2 bottom-0 h-0.5 ${actif ? 'bg-accent' : 'bg-transparent'}`}
                  />
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {onglet === 'inventaire' || onglet === 'journal' ? (
        <main className="rail min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-4">
            {onglet === 'inventaire' ? (
              <Inventaire collection={collection} onScanner={revenirAuScanner} />
            ) : (
              <Journal journal={journal} onScanner={revenirAuScanner} />
            )}
          </div>
        </main>
      ) : scan ? (
        /* Écran de résultat : le visuel et la fiche. Empilés sur téléphone,
           côte à côte dès qu'il y a de la largeur. */
        <main className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto grid h-full w-full max-w-6xl grid-rows-[auto_minmax(0,1fr)] gap-4 px-4 py-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-1 lg:items-start">
            {/* Le visuel s'efface quand une rareté reste à choisir : à ce
                moment-là, la décision prime sur la contemplation, et sept
                options ne doivent pas se retrouver sous la ligne de flottaison. */}
            <div className="flex min-h-0 items-start justify-center">
              <HoloCard
                image={fiche?.image}
                imageSmall={fiche?.imagePetite}
                name={fiche?.nom ?? ''}
                rarity={rarete?.rarity}
                compact={Boolean(fiche?.choixRequis) && !rarete}
              />
            </div>

            <FicheCarte
              fiche={fiche}
              detail={detail}
              rarete={rarete}
              chargement={chargement}
              erreur={erreur}
              enregistree={enregistree}
              onRarete={setRarete}
              onEnregistrer={enregistrer}
              onReprendre={reprendre}
            />
          </div>
        </main>
      ) : (
        <main className="min-h-0 flex-1">
          <SniperView sniper={sniper} onRefus={journal.consignerRefus} />
        </main>
      )}
    </div>
  );
}
