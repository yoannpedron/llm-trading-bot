import { ABSENT, dateCourte, entier, pluriel } from '../lib/format.js';

/**
 * Journal des lectures.
 *
 * Chronologique, sans dédoublonnage — c'est ce qui le distingue de
 * l'inventaire. On y lit ce qui est passé sous le viseur et ce que cela a
 * donné, y compris les recherches manuelles infructueuses, qui sont souvent la
 * seule trace exploitable quand une carte refuse de passer.
 *
 * La mise en page reprend celle de l'inventaire : mêmes indicateurs, même
 * tableau à partir de la tablette, même liste alignée sur téléphone. Deux
 * écrans qui montrent des lignes datées n'ont aucune raison de se ressembler à
 * moitié.
 */

const HEURE = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Aujourd'hui : l'heure suffit. Avant : la date, qui situe la session. */
function Quand({ at }) {
  const date = new Date(at);
  const aujourdHui = new Date().toDateString() === date.toDateString();
  return (
    <span className="donnee text-tertiaire" title={date.toLocaleString('fr-FR')}>
      {aujourdHui ? HEURE.format(date) : dateCourte(at)}
    </span>
  );
}

const RESOLUTION = {
  exact: { libelle: 'exacte', ton: 'text-positif' },
  region: { libelle: 'régionale', ton: 'text-positif' },
  fuzzy: { libelle: 'approchée', ton: 'text-alerte' },
};

function Resolution({ entree }) {
  if (entree.statut === 'illisible') {
    return <span className="donnee text-tertiaire">pas un code</span>;
  }
  if (entree.statut === 'introuvable') {
    return <span className="donnee text-alerte">introuvable</span>;
  }
  const resolution = RESOLUTION[entree.methode] ?? { libelle: entree.methode ?? ABSENT, ton: 'text-second' };
  return (
    <span className={`donnee ${resolution.ton}`}>
      {resolution.libelle}
      {entree.manuelle && <span className="ml-1.5 text-tertiaire">saisie</span>}
    </span>
  );
}

function Suite({ entree }) {
  if (entree.statut !== 'identifiee') return <span className="donnee text-tertiaire">{ABSENT}</span>;
  return entree.enregistree ? (
    <span className="donnee text-positif">inventoriée</span>
  ) : (
    <span className="donnee text-tertiaire">écartée</span>
  );
}

/** Ce qui a été lu quand rien n'a été trouvé : la seule trace utile. */
function Identite({ entree }) {
  if (entree.statut === 'identifiee') {
    return (
      <>
        <p className="truncate text-donnee text-encre">{entree.nom ?? ABSENT}</p>
        <p className="truncate font-mono text-micro text-accent">{entree.code ?? ABSENT}</p>
        {entree.lecture && entree.lecture !== entree.code && (
          <p className="truncate font-mono text-micro text-tertiaire">lu « {entree.lecture} »</p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="truncate text-donnee text-second">Aucune carte</p>
      <p className="truncate font-mono text-micro text-tertiaire">
        saisi «&nbsp;{entree.lecture || ABSENT}&nbsp;»
      </p>
    </>
  );
}

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

export default function Journal({ journal, onScanner }) {
  const { entrees, compte, vider, persiste } = journal;

  if (entrees.length === 0) {
    return (
      <section className="panneau grid min-h-[60vh] place-items-center px-6 py-12 text-center">
        <div className="max-w-sm">
          <p className="intitule">Journal</p>
          <p className="mt-2 text-titre font-semibold text-encre">Aucune lecture</p>
          <p className="mt-2 text-courant text-second">
            Chaque carte passée sous le viseur s’inscrit ici, dans l’ordre, qu’elle ait été
            inventoriée ou écartée. Les recherches manuelles infructueuses aussi&nbsp;: c’est ce qui
            permet de comprendre pourquoi une carte ne passe pas.
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
      {!persiste && (
        <p className="panneau border-alerte/40 px-3 py-2 text-donnee text-alerte">
          Ce journal n’est pas conservé&nbsp;: le navigateur refuse d’écrire sur cet appareil.
        </p>
      )}

      <div className="panneau grid grid-cols-2 divide-x divide-y divide-trait sm:grid-cols-4 sm:divide-y-0">
        <Indicateur
          intitule="Lectures"
          valeur={entier(compte.total)}
          mention={compte.total >= 300 ? '300 dernières' : 'depuis le début'}
        />
        <Indicateur
          intitule="Identifiées"
          valeur={entier(compte.identifiees)}
          mention={`${Math.round((compte.identifiees / compte.total) * 100)} %`}
        />
        <Indicateur intitule="Inventoriées" valeur={entier(compte.enregistrees)} mention="conservées" />
        <Indicateur
          intitule="Sans résultat"
          valeur={entier(compte.refusees)}
          mention="saisies manuelles"
        />
      </div>

      <div className="panneau flex items-center justify-between gap-2 p-2">
        <p className="pl-1 text-donnee text-second">{pluriel(compte.total, 'lecture')}</p>
        <button
          type="button"
          onClick={vider}
          className="h-10 rounded-controle border border-trait px-3 text-donnee text-tertiaire transition-colors hover:border-danger/50 hover:text-danger"
        >
          Vider le journal
        </button>
      </div>

      {/* Tableau à partir de la tablette. */}
      <div className="panneau hidden overflow-hidden md:block">
        <table className="w-full border-collapse">
          <caption className="sr-only">Lectures, de la plus récente à la plus ancienne</caption>
          <thead>
            <tr className="border-b border-trait-fort">
              <th scope="col" className="intitule w-20 px-3 py-2 text-left font-medium">
                Quand
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Carte
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Résolution
              </th>
              <th scope="col" className="intitule px-3 py-2 text-left font-medium">
                Suite
              </th>
            </tr>
          </thead>
          <tbody>
            {entrees.map((entree, rang) => (
              <tr
                key={`${entree.at}-${rang}`}
                className="border-b border-trait transition-colors last:border-b-0 hover:bg-relief"
              >
                <td className="px-3 py-2 align-top">
                  <Quand at={entree.at} />
                </td>
                <td className="max-w-0 px-3 py-2">
                  <Identite entree={entree} />
                </td>
                <td className="px-3 py-2 align-top">
                  <Resolution entree={entree} />
                </td>
                <td className="px-3 py-2 align-top">
                  <Suite entree={entree} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Liste sur téléphone. */}
      <ul className="panneau divide-y divide-trait md:hidden">
        {entrees.map((entree, rang) => (
          <li
            key={`${entree.at}-${rang}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-3"
          >
            <Quand at={entree.at} />
            <div className="min-w-0">
              <Identite entree={entree} />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
              <Resolution entree={entree} />
              <Suite entree={entree} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
