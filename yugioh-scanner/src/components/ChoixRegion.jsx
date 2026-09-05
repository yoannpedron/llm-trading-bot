import { REGIONS } from '../lib/region.js';

/**
 * Choix de la langue des cartes.
 *
 * Une liste native : elle s'ouvre en plein écran sur téléphone, se parcourt
 * au clavier, et ne demande aucun état. L'intitulé dit à quoi sert le réglage
 * — « Langue de vos cartes » — parce que « région » ne parle qu'aux
 * collectionneurs ; le code à deux lettres suit, c'est lui qu'on lit sur la
 * carte.
 *
 * Le même composant sert dans le viseur et sur l'écran de résultat : on
 * découvre souvent que la langue est fausse en voyant la liste des tirages.
 */
export default function ChoixRegion({ region, onRegion, id = 'choix-region', aide = true }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="intitule">
        Langue de vos cartes
      </label>
      <select
        id={id}
        value={region}
        onChange={(evenement) => onRegion(evenement.target.value)}
        className="mt-1.5 h-10 w-full rounded-controle border border-trait bg-champ px-2 font-mono text-donnee text-encre outline-none transition-colors hover:border-trait-fort focus:border-accent"
      >
        {REGIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.code} — {option.libelle}
            {option.detail ? ` (${option.detail})` : ''}
          </option>
        ))}
      </select>
      {aide && (
        <p className="mt-1.5 font-mono text-micro text-tertiaire">
          Les codes d’extension sont affichés et enregistrés dans cette langue.
        </p>
      )}
    </div>
  );
}
