import { useMemo, useState } from 'react';

import { entryValue } from '../lib/collection.js';
import { CONDITIONS, conditionByCode, conditionPrice } from '../lib/condition.js';
import { ABSENT, dateCourte, entier, euros, eurosRonds, pluriel } from '../lib/format.js';
import { rarityProfile } from '../lib/rarity.js';

/**
 * Inventaire des cartes relevées.
 *
 * Conçu comme un état de stock : un bandeau d'indicateurs, une barre d'outils,
 * un tableau de données, une ligne de total. C'est la forme qu'attend quelqu'un
 * qui dépouille un classeur et veut savoir ce qu'il possède et ce que cela vaut.
 *
 * CE QUI A CHANGÉ, ET POURQUOI
 *
 *  - **Il n'y avait aucun tableau.** Les cartes étaient des vignettes en deux
 *    colonnes, chacune avec son propre alignement. Comparer deux cotes ou
 *    repérer la carte la plus chère demandait de lire chaque vignette. Les
 *    données sont maintenant en colonnes alignées, chiffres à droite en chasse
 *    fixe : c'est ce qui rend un tableau lisible d'un coup d'œil.
 *  - **Aucun total intermédiaire, aucun indicateur.** On avait un total en
 *    euros, sans savoir sur combien de cartes il portait ni combien de cotes
 *    manquaient. Le bandeau répond aux quatre questions qu'on se pose en
 *    ouvrant l'écran.
 *  - **L'état de conservation était inaccessible.** Sept états, leurs
 *    coefficients de décote, une colonne dans le CSV et un total qui en dépend
 *    existaient dans le code — mais `setCondition` n'était appelé par aucun
 *    composant. Toutes les cartes restaient en « Near Mint », et le total
 *    affichait la valeur d'un classeur neuf. L'état se choisit désormais sur
 *    chaque ligne.
 *  - **Le retrait d'une carte était caché.** Bouton en position absolue dans un
 *    coin, opacité nulle tant qu'on ne survolait pas — donc invisible et
 *    fortuit au doigt. Il est maintenant une colonne d'action explicite.
 *  - **« Vider » passait par `window.confirm`.** Une boîte système, non
 *    stylable, non traduite selon le navigateur, et qui ne dit pas ce qu'on
 *    perd. La confirmation est désormais dans la page et annonce le nombre de
 *    lignes et la valeur détruites.
 */

const TRIS = {
  recent: { libelle: 'Plus récentes', compare: (a, b) => b.seenAt - a.seenAt },
  valeur: { libelle: 'Cote décroissante', compare: (a, b) => (valeurDe(b) ?? -1) - (valeurDe(a) ?? -1) },
  nom: { libelle: 'Nom', compare: (a, b) => a.name.localeCompare(b.name, 'fr') },
  serie: {
    libelle: 'Série puis code',
    compare: (a, b) =>
      (a.setName ?? '').localeCompare(b.setName ?? '', 'fr') ||
      (a.setCode ?? '').localeCompare(b.setCode ?? '', 'fr'),
  },
};

/** Valeur retenue pour une ligne : celle de l'état déclaré, pas la référence. */
const valeurDe = (entree) => entryValue(entree);

/** Ce que l'utilisateur cherche en tapant : tout ce qui est visible sur la ligne. */
const texteCherchable = (entree) =>
  `${entree.name} ${entree.setCode} ${entree.setName} ${entree.rarity} ${entree.condition ?? ''}`.toLowerCase();

/* ------------------------------------------------------------------ */
/* Fragments partagés entre le tableau et la liste                      */
/* ------------------------------------------------------------------ */

function Pastille({ rarete }) {
  const profil = rarityProfile(rarete);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: profil.glow }}
      />
      <span className="truncate">{rarete || ABSENT}</span>
    </span>
  );
}

function Vignette({ entree }) {
  return (
    <img
      src={entree.imageSmall ?? entree.image}
      alt=""
      loading="lazy"
      width="36"
      height="52"
      className="h-13 w-9 shrink-0 rounded-controle border border-trait bg-fond object-cover"
    />
  );
}

/**
 * Sélecteur d'état.
 *
 * Un `<select>` natif, volontairement : sur téléphone il ouvre le sélecteur du
 * système, plus rapide et plus accessible qu'une liste déroulante réimplémentée,
 * et il reste utilisable au clavier sans code supplémentaire.
 */
function ChoixEtat({ entree, onChange }) {
  const etat = conditionByCode(entree.condition);
  return (
    <select
      value={entree.condition ?? ''}
      onChange={(evenement) => onChange(entree.key, evenement.target.value)}
      aria-label={`État de ${entree.name}`}
      title={etat ? `${etat.label} — ${etat.hint}` : 'État de conservation'}
      className="h-8 w-full max-w-[5.5rem] rounded-controle border border-trait bg-champ px-1.5 font-mono text-micro text-second outline-none transition-colors hover:border-trait-fort focus:border-accent"
    >
      {CONDITIONS.map((condition) => (
        <option key={condition.code} value={condition.code}>
          {condition.code}
        </option>
      ))}
    </select>
  );
}

/** Provenance lisible d'une cote. L'identifiant technique n'est pas un libellé. */
const PROVENANCE = {
  cardmarket: 'Cardmarket',
  ygoprodeck: 'YGOPRODeck',
};

function Cote({ entree, enCours }) {
  if (enCours) {
    return <span className="donnee text-tertiaire">…</span>;
  }
  const { value, estimated } = conditionPrice(entree.price, entree.condition);
  const exemplaires = entree.count ?? 1;
  return (
    <span className="inline-flex flex-col items-end">
      <span className={`donnee font-medium ${value === null ? 'text-tertiaire' : 'text-encre'}`}>
        {euros(entryValue(entree))}
      </span>
      {value !== null && exemplaires > 1 && (
        <span className="font-mono text-micro text-tertiaire">
          {exemplaires} × {euros(value)}
        </span>
      )}
      {value !== null && (
        <span className="font-mono text-micro text-tertiaire">
          {estimated ? 'estimée' : (PROVENANCE[entree.price?.source] ?? 'relevée')}
        </span>
      )}
    </span>
  );
}

function BoutonRetrait({ entree, onRemove }) {
  return (
    <button
      type="button"
      onClick={() => onRemove(entree.key)}
      aria-label={`Retirer ${entree.name} de l’inventaire`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-controle border border-transparent text-tertiaire transition-colors hover:border-danger/40 hover:text-danger"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
        <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Bandeau d'indicateurs                                                */
/* ------------------------------------------------------------------ */

function Indicateur({ intitule, valeur, mention }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <p className="intitule truncate">{intitule}</p>
      <p className="mt-0.5 truncate font-mono text-chiffre font-medium tabular-nums text-encre">
        {valeur}
      </p>
      {mention && <p className="truncate font-mono text-micro text-tertiaire">{mention}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Écran                                                                */
/* ------------------------------------------------------------------ */

export default function Inventaire({ collection, onScanner }) {
  const {
    entries,
    pending,
    errors,
    refreshing,
    progress,
    refreshAll,
    exportCsv,
    clear,
    remove,
    setCondition,
    total,
    persiste,
  } = collection;

  const [tri, setTri] = useState('recent');
  const [recherche, setRecherche] = useState('');
  const [confirmationVidage, setConfirmationVidage] = useState(false);

  const visibles = useMemo(() => {
    const aiguille = recherche.trim().toLowerCase();
    return entries
      .filter((entree) => (aiguille ? texteCherchable(entree).includes(aiguille) : true))
      .sort(TRIS[tri].compare);
  }, [entries, recherche, tri]);

  /* Les indicateurs portent sur l'inventaire entier, jamais sur le filtre :
     un total qui change quand on tape dans une recherche n'est plus un total. */
  const indicateurs = useMemo(() => {
    const cotees = entries.filter((entree) => valeurDe(entree) !== null);
    // La plus ANCIENNE cote, pas la plus récente : un seul relevé de l'instant
    // suffisait à afficher la date du jour pour un inventaire entier périmé.
    // Ce qu'on veut savoir, c'est jusqu'où remonte la donnée la moins fraîche.
    const datees = entries.map((entree) => entree.pricedAt).filter(Boolean);
    const derniere = datees.length ? Math.min(...datees) : 0;
    return {
      nombre: entries.length,
      total,
      moyenne: cotees.length ? total / cotees.length : null,
      sansCote: entries.length - cotees.length,
      derniere,
    };
  }, [entries, total]);

  /* Le total du sous-ensemble affiché : c'est lui qui répond à « combien vaut
     ce que je vois », par exemple après avoir filtré sur une série. */
  const totalFiltre = useMemo(
    () => visibles.reduce((somme, entree) => somme + (valeurDe(entree) ?? 0), 0),
    [visibles],
  );

  const filtreActif = recherche.trim().length > 0;

  if (entries.length === 0) {
    return (
      <section className="panneau grid min-h-[60vh] place-items-center px-6 py-12 text-center">
        <div className="max-w-sm">
          <p className="intitule">Inventaire</p>
          <p className="mt-2 text-titre font-semibold text-encre">Aucune carte relevée</p>
          <p className="mt-2 text-courant text-second">
            Les cartes identifiées s’accumulent ici avec leur cote. L’inventaire est conservé
            dans ce navigateur&nbsp;; aucune image n’est envoyée nulle part. Seuls les
            identifiants des cartes partent vers YGOPRODeck pour en relever la cote.
          </p>
          <button
            type="button"
            onClick={onScanner}
            className="mt-5 h-12 w-full rounded-controle bg-accent text-donnee font-semibold text-fond transition-colors hover:bg-accent/85"
          >
            Relever une carte
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {/* --- Indicateurs ---------------------------------------------------- */}
      <div className="panneau grid grid-cols-2 divide-x divide-y divide-trait sm:grid-cols-4 sm:divide-y-0">
        <Indicateur
          intitule="Cartes"
          valeur={entier(indicateurs.nombre)}
          mention={indicateurs.sansCote > 0 ? `${indicateurs.sansCote} sans cote` : 'toutes cotées'}
        />
        {/* Le même montant que le pied de tableau, au centime près : l'arrondi
            donnait deux chiffres différents pour une même quantité sur un
            même écran. */}
        <Indicateur
          intitule="Valeur totale"
          valeur={euros(indicateurs.total)}
          mention="états et exemplaires compris"
        />
        <Indicateur
          intitule="Cote moyenne"
          valeur={euros(indicateurs.moyenne)}
          mention="sur les cartes cotées"
        />
        <Indicateur
          intitule="Cotes remontant à"
          valeur={indicateurs.derniere ? dateCourte(indicateurs.derniere) : ABSENT}
          mention={
            refreshing ? `relevé en cours ${progress.done}/${progress.total}` : 'la plus ancienne'
          }
        />
      </div>

      {/* --- Barre d'outils -------------------------------------------------- */}
      <div className="panneau flex flex-wrap items-center gap-2 p-2">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
          <input
            type="search"
            value={recherche}
            onChange={(evenement) => setRecherche(evenement.target.value)}
            placeholder="Filtrer par nom, code, série, rareté…"
            aria-label="Filtrer l’inventaire"
            className="h-10 min-w-0 flex-1 rounded-controle border border-trait bg-champ px-3 text-donnee text-encre outline-none transition-colors placeholder:text-tertiaire hover:border-trait-fort focus:border-accent"
          />
          <label className="sr-only" htmlFor="tri-inventaire">
            Trier
          </label>
          <select
            id="tri-inventaire"
            value={tri}
            onChange={(evenement) => setTri(evenement.target.value)}
            className="h-10 shrink-0 rounded-controle border border-trait bg-champ px-2 text-donnee text-second outline-none transition-colors hover:border-trait-fort focus:border-accent"
          >
            {Object.entries(TRIS).map(([cle, option]) => (
              <option key={cle} value={cle}>
                {option.libelle}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => refreshAll(null, { force: true })}
            disabled={refreshing}
            className="h-10 rounded-controle border border-trait px-3 text-donnee text-second transition-colors hover:border-trait-fort hover:text-encre disabled:opacity-40"
          >
            {refreshing ? `Relevé ${progress.done}/${progress.total}` : 'Actualiser les cotes'}
          </button>
          {/* On exporte ce que l'utilisateur a sous les yeux. Le bouton voisine
              avec le filtre et avec un « total filtré » : lui faire produire
              autre chose serait un piège. */}
          <button
            type="button"
            onClick={() => exportCsv(visibles)}
            className="h-10 rounded-controle border border-trait px-3 text-donnee text-second transition-colors hover:border-trait-fort hover:text-encre"
          >
            {filtreActif ? `Exporter ces ${visibles.length}` : 'Exporter en CSV'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmationVidage(true)}
            className="h-10 rounded-controle border border-trait px-3 text-donnee text-tertiaire transition-colors hover:border-danger/50 hover:text-danger"
          >
            Vider
          </button>
        </div>
      </div>

      {/* --- L'inventaire est-il réellement conservé ? ------------------------
          Le stockage peut refuser : quota plein, navigation privée, cookies
          bloqués. L'application le sait — `saveCollection` rend `false` — et
          se taisait, tout en affirmant que l'inventaire est conservé sur
          l'appareil. Une donnée perdue en silence ne se découvre qu'après. */}
      {!persiste && (
        <p className="panneau border-alerte/40 px-3 py-2 text-donnee text-alerte">
          Cet inventaire n’est pas conservé : le navigateur refuse d’écrire sur cet appareil
          (navigation privée, ou espace de stockage plein). Il disparaîtra au rechargement de la
          page — exportez-le si vous voulez le garder.
        </p>
      )}

      {/* --- Confirmation d'un geste irréversible ---------------------------- */}
      {confirmationVidage && (
        <div
          role="alertdialog"
          aria-labelledby="titre-vidage"
          className="panneau apparait border-danger/40 p-3"
        >
          <p id="titre-vidage" className="text-donnee font-semibold text-encre">
            Vider l’inventaire&nbsp;?
          </p>
          <p className="mt-1 text-donnee text-second">
            {pluriel(entries.length, 'carte')} et {eurosRonds(indicateurs.total)} de cotes seront
            effacés de cet appareil. L’opération est définitive&nbsp;; exportez d’abord si vous
            voulez en garder une trace.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                clear();
                setConfirmationVidage(false);
              }}
              className="h-10 rounded-controle bg-danger px-4 text-donnee font-semibold text-fond transition-opacity hover:opacity-85"
            >
              Vider définitivement
            </button>
            <button
              type="button"
              onClick={() => setConfirmationVidage(false)}
              className="h-10 rounded-controle border border-trait px-4 text-donnee text-second transition-colors hover:border-trait-fort hover:text-encre"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* --- Tableau, à partir de la tablette -------------------------------- */}
      <div className="panneau hidden overflow-hidden md:block">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Cartes relevées, avec leur série, leur rareté, leur état et leur cote
          </caption>
          <thead>
            <tr className="border-b border-trait-fort">
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Carte
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Série
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Rareté
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                État
              </th>
              <th
                scope="col"
                className="intitule px-3 py-2 text-right font-medium"
                title="Exemplaires possédés — un rescan de la même carte en ajoute un"
              >
                Ex.
              </th>
              <th scope="col" className="intitule px-3 py-2 text-right font-medium">
                Cote
              </th>
              <th scope="col" className="w-10 px-3 py-2">
                <span className="sr-only">Retirer</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((entree) => (
              <tr key={entree.key} className="border-b border-trait transition-colors hover:bg-relief">
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <Vignette entree={entree} />
                    <div className="min-w-0">
                      <p className="truncate text-donnee text-encre">{entree.name}</p>
                      <p className="truncate font-mono text-micro text-accent">{entree.setCode}</p>
                      {errors.get(entree.key) && (
                        <p className="truncate font-mono text-micro text-alerte">
                          {errors.get(entree.key)}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="max-w-[14rem] px-3 py-2">
                  <span className="donnee block truncate text-second">
                    {entree.setName || ABSENT}
                  </span>
                </td>
                <td className="max-w-[11rem] px-3 py-2">
                  <span className="donnee block truncate text-second">
                    <Pastille rarete={entree.rarity} />
                  </span>
                </td>
                <td className="px-3 py-2">
                  <ChoixEtat entree={entree} onChange={setCondition} />
                </td>
                <td className="donnee px-3 py-2 text-right text-tertiaire">{entree.count ?? 1}</td>
                <td className="px-3 py-2 text-right">
                  <Cote entree={entree} enCours={pending.has(entree.key)} />
                </td>
                <td className="px-3 py-2">
                  <BoutonRetrait entree={entree} onRemove={remove} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-trait-fort">
              <td colSpan={5} className="intitule px-3 py-2.5">
                {filtreActif ? `Total filtré — ${pluriel(visibles.length, 'carte')}` : 'Total'}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-donnee font-semibold tabular-nums text-positif">
                {euros(filtreActif ? totalFiltre : total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* --- Liste, sur téléphone --------------------------------------------
          Les mêmes données, dans une grille fixe : vignette, identité, cote à
          droite. On évite le défilement horizontal d'un tableau, sans perdre
          l'alignement des chiffres qui rend la comparaison possible. */}
      <ul className="panneau divide-y divide-trait md:hidden">
        {visibles.map((entree) => (
          <li key={entree.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-3">
            <Vignette entree={entree} />
            <div className="min-w-0">
              <p className="truncate text-donnee text-encre">{entree.name}</p>
              <p className="truncate font-mono text-micro text-accent">{entree.setCode}</p>
              <p className="donnee mt-0.5 truncate text-micro text-tertiaire">
                <Pastille rarete={entree.rarity} />
              </p>
              {errors.get(entree.key) && (
                <p className="truncate font-mono text-micro text-alerte">{errors.get(entree.key)}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Cote entree={entree} enCours={pending.has(entree.key)} />
              <div className="flex items-center gap-1">
                <ChoixEtat entree={entree} onChange={setCondition} />
                <BoutonRetrait entree={entree} onRemove={remove} />
              </div>
            </div>
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 border-t border-trait-fort p-3">
          <span className="intitule">
            {filtreActif ? `Total filtré — ${pluriel(visibles.length, 'carte')}` : 'Total'}
          </span>
          <span className="font-mono text-donnee font-semibold tabular-nums text-positif">
            {euros(filtreActif ? totalFiltre : total)}
          </span>
        </li>
      </ul>

      {visibles.length === 0 && (
        <p className="panneau px-4 py-8 text-center text-donnee text-tertiaire">
          Aucune carte ne correspond à «&nbsp;{recherche.trim()}&nbsp;».
        </p>
      )}
    </section>
  );
}
