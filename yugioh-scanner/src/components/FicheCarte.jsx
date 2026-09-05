import { euros, ABSENT } from '../lib/format.js';
import { caracteristiques, codeRetenu, coteAffichable } from '../lib/fiche.js';
import { rarityProfile, sortRarities } from '../lib/rarity.js';
import { trierParRegion } from '../lib/region.js';
import ChoixRegion from './ChoixRegion.jsx';

/**
 * Fiche d'une carte identifiée.
 *
 * Conçue comme une notice de catalogue, et non comme une carte de réseau
 * social : un en-tête d'identité, un bloc de cote, un tableau de
 * caractéristiques en « intitulé / valeur », le texte de la carte, puis les
 * actions. C'est la mise en page d'un document, et elle se lit dans cet ordre.
 *
 * CE QUI A CHANGÉ, ET POURQUOI
 *
 *  - **La hiérarchie était fausse.** Le nom était tronqué sur une ligne tandis
 *    que la cote occupait une pastille verte de la taille d'un bouton. Or on
 *    lit d'abord *quelle carte c'est*, ensuite ce qu'elle vaut. Le nom prend
 *    donc deux lignes s'il le faut, et la cote suit dans un bloc bordé.
 *  - **Les caractéristiques étaient des pastilles.** « ATTR », « NIV », « ATK »
 *    dans des rectangles gris flottants, sans alignement : impossible de
 *    comparer deux cartes, impossible de balayer du regard. Elles forment
 *    maintenant une liste de définitions alignée sur deux colonnes.
 *  - **Le choix de rareté ne disait pas ce qu'il engage.** Sept boutons colorés
 *    dans un rail coupé au bord de l'écran. C'est pourtant la décision qui
 *    fixe le prix : elle mérite une liste de sélection explicite, avec le nom
 *    de la série et la teinte de la rareté en simple repère.
 *  - **La cote ne disait pas d'où elle venait.** Un chiffre sans source n'est
 *    pas une donnée. La provenance est nommée sous le montant.
 */

/** Une ligne « intitulé / valeur » du tableau de caractéristiques. */
function Ligne({ intitule, children, valeurClasse = 'text-encre' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-trait py-2 last:border-b-0">
      <dt className="intitule shrink-0">{intitule}</dt>
      <dd className={`donnee min-w-0 text-right ${valeurClasse}`}>{children}</dd>
    </div>
  );
}

/** Pastille de rareté : un repère de couleur, jamais un fond coloré. */
function PastilleRarete({ rarete }) {
  const profil = rarityProfile(rarete);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full ring-1"
        style={{ background: profil.glow, '--tw-ring-color': `${profil.glow}66` }}
      />
      <span className="truncate">{rarete || 'rareté inconnue'}</span>
    </span>
  );
}

/**
 * Bloc de cote.
 *
 * Le montant est le seul chiffre de la fiche à cette taille : c'est la donnée
 * qu'on est venu chercher. La source est nommée juste dessous, parce qu'une
 * cote sans provenance n'engage à rien — et que les deux sources n'ont pas la
 * même valeur probante.
 */
function Cote({ montant, source, indicative }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-y border-trait py-2.5">
      <div className="min-w-0">
        <p className="intitule">{indicative ? 'Cote indicative' : 'Cote'}</p>
        <p className="mt-0.5 truncate font-mono text-micro text-tertiaire">{source}</p>
      </div>
      <p
        className={`shrink-0 font-mono text-chiffre font-medium tabular-nums ${
          typeof montant === 'number' ? 'text-positif' : 'text-tertiaire'
        }`}
      >
        {euros(montant)}
      </p>
    </div>
  );
}

export default function FicheCarte({
  fiche,
  detail,
  rarete,
  chargement,
  erreur,
  enregistree,
  region,
  onRegion,
  onRarete,
  onEnregistrer,
  onReprendre,
}) {
  if (!fiche) return null;

  const choixRequis = fiche.choixRequis && !rarete;
  // Les tirages dans la langue de l'utilisateur d'abord, puis les autres ;
  // dans chaque groupe, du plus commun au plus rare : l'ordre des
  // probabilités et des prix. Les deux tris sont stables.
  const options = trierParRegion(sortRarities(fiche.raretes), fiche.region);
  const code = codeRetenu(fiche, rarete);
  const cote = coteAffichable(fiche, rarete, detail);
  const lignes = caracteristiques(fiche);

  return (
    <section className="panneau apparait flex min-h-0 flex-col overflow-hidden">
      <div className="rail min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* --- Identité ---------------------------------------------------- */}
        <header>
          {/* Le code d'abord : c'est l'identifiant du tirage, et il tient sur
              une ligne. La mention de variante le suit sans le disputer.
              Reconnue par l'illustration, la carte n'a de code qu'une fois le
              tirage choisi. */}
          <p className="donnee font-medium tracking-[0.08em] whitespace-nowrap text-accent" data-code={code ?? ''}>
            {code ?? ABSENT}
            {fiche.regionale && (
              <span className="ml-2 font-sans text-micro font-normal tracking-normal text-tertiaire">
                variante régionale
              </span>
            )}
          </p>

          <h2 className="mt-1 text-titre leading-tight font-semibold text-encre">
            {fiche.nom ?? 'Carte inconnue'}
          </h2>
          {fiche.sousTitre && (
            <p className="mt-0.5 text-donnee text-second">{fiche.sousTitre}</p>
          )}
        </header>

        {/* --- Fiabilité de la lecture ------------------------------------- */}
        {fiche.approchee && (
          <p className="mt-3 flex gap-2 rounded-controle border border-alerte/40 bg-alerte/8 px-3 py-2 text-donnee text-alerte">
            <span aria-hidden>△</span>
            <span>
              Lecture approchée&nbsp;: «&nbsp;{fiche.lectureBrute}&nbsp;» a été rapproché de ce
              code. Vérifiez le visuel avant d’enregistrer.
            </span>
          </p>
        )}

        {fiche.parIllustration && (
          <p className="mt-3 flex gap-2 rounded-controle border border-trait bg-relief px-3 py-2 text-donnee text-second">
            <span aria-hidden>◎</span>
            <span>
              {fiche.choisie ? 'Choisie par vous parmi les propositions. ' : 'Reconnue par son illustration. '}
              Le tirage se lit sur la carte, sous l’illustration à droite : un code comme
              «&nbsp;LDK2-FR001&nbsp;».
              {fiche.confiance !== null && !fiche.choisie && (
                <span className="mt-1 block font-mono text-micro text-tertiaire">
                  {/* Les deux chiffres qui décident du verrouillage : à lire
                      dans une capture d'écran quand la carte est fausse. */}
                  confiance {fiche.confiance}&nbsp;%
                  {fiche.marge !== null ? `, marge ${fiche.marge.toFixed(2)}` : ''}
                </span>
              )}
            </span>
          </p>
        )}

        {/* --- Choix de rareté, ou cote puis caractéristiques ----------------
            Quand une rareté doit être choisie, c'est LA décision de l'écran :
            elle fixe la cote et la ligne d'inventaire. Elle passe donc avant
            tout le reste. Auparavant elle venait après la cote et le texte, et
            se retrouvait hors de l'écran sur un téléphone. */}
        {choixRequis ? (
          <fieldset className="mt-3 min-w-0">
            <legend className="intitule">
              {fiche.parIllustration ? 'Tirage de votre exemplaire' : 'Rareté de votre exemplaire'}
            </legend>
            <p className="mt-1 text-donnee text-second">
              {fiche.parIllustration
                ? `Cette carte existe en ${options.length} tirages. Le code imprimé sous l’illustration désigne le vôtre ; c’est lui qui fixe la cote.`
                : `Ce code existe en ${options.length} raretés. La caméra ne voit pas l’holographie, et c’est la rareté qui fixe la cote.`}
            </p>
            {/* La langue se règle ici aussi : c'est devant cette liste qu'on
                s'aperçoit que les codes ne sont pas ceux de sa carte. */}
            {fiche.parIllustration && onRegion && (
              <div className="mt-3">
                <ChoixRegion region={region} onRegion={onRegion} id="choix-region-fiche" aide={false} />
              </div>
            )}
            <ul className="mt-2 divide-y divide-trait border-y border-trait" data-tirages>
              {options.map((option) => (
                <li key={`${option.setCode}-${option.rarity}-${option.setName}`}>
                  <button
                    type="button"
                    onClick={() => onRarete(option)}
                    className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left transition-colors hover:bg-relief"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-donnee text-encre">
                        <PastilleRarete rarete={option.rarity} />
                      </span>
                      <span className="mt-0.5 block truncate pl-4 font-mono text-micro text-tertiaire">
                        {/* Le code d'abord quand c'est lui que l'utilisateur
                            cherche sur sa carte (identification par
                            l'illustration) ; le nom de la série suit. */}
                        {fiche.parIllustration && option.setCode ? (
                          <>
                            <span className="text-second" data-set-code={option.setCode}>
                              {option.setCode}
                            </span>
                            {' · '}
                          </>
                        ) : null}
                        {option.setName}
                      </span>
                    </span>
                    <span aria-hidden className="shrink-0 text-tertiaire">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : (
          <dl className="mt-3">
            {/* La cote en tête du tableau : c'est la donnée qu'on est venu
                chercher, et elle se lit avec les caractéristiques. */}
            <div className="mb-1">
              <Cote montant={cote.montant} source={cote.source} indicative={cote.indicative} />
            </div>
            {rarete && (
              <Ligne intitule="Rareté">
                <PastilleRarete rarete={rarete.rarity} />
              </Ligne>
            )}
            {rarete?.setName && (
              <Ligne intitule="Série">
                <span className="line-clamp-2">{rarete.setName}</span>
              </Ligne>
            )}
            {lignes.map(({ intitule, valeur }) => (
              <Ligne key={intitule} intitule={intitule}>
                {valeur}
              </Ligne>
            ))}
          </dl>
        )}

        {/* --- Texte de la carte -------------------------------------------- */}
        <div className="mt-4">
          <p className="intitule">Texte</p>
          <div className="mt-1 text-courant text-second">
            {chargement && <p className="animate-pulse text-tertiaire">Chargement de la fiche…</p>}
            {!chargement && erreur && <p className="text-alerte">{erreur}</p>}
            {!chargement && !erreur && (
              <p className="whitespace-pre-line">{fiche.texte ?? 'Texte indisponible.'}</p>
            )}
          </div>
        </div>
      </div>

      {/* --- Actions, ancrées en bas et hors du défilement ------------------- */}
      <div className="safe-bottom shrink-0 border-t border-trait bg-panneau px-4 pt-3">
        {enregistree ? (
          <div className="flex flex-col gap-2">
            <p className="text-center text-donnee text-positif">Enregistrée dans l’inventaire.</p>
            <button
              type="button"
              onClick={onReprendre}
              className="h-12 w-full rounded-controle bg-accent text-donnee font-semibold text-fond transition-colors hover:bg-accent/85"
            >
              Carte suivante
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onEnregistrer}
              disabled={!rarete}
              title={rarete ? undefined : 'Choisissez d’abord la rareté de votre exemplaire'}
              className="h-12 flex-1 rounded-controle bg-accent text-donnee font-semibold text-fond transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:bg-champ disabled:text-tertiaire"
            >
              Enregistrer
            </button>
            {/* Sortie toujours disponible, y compris pendant le choix de
                rareté : une mauvaise identification ne doit pas obliger à
                choisir une rareté pour pouvoir repartir. */}
            <button
              type="button"
              onClick={onReprendre}
              className="h-12 shrink-0 rounded-controle border border-trait-fort px-4 text-donnee font-medium text-second transition-colors hover:border-danger hover:text-danger"
            >
              Ce n’est pas ma carte
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
