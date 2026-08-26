# -*- coding: utf-8 -*-
"""Génère les livrables de l'enquête Propreté Audika (vague 2) à partir d'une source unique.

Sorties (dans le même dossier) :
  01-enquete-menage-audika.md      contenu intégral du formulaire
  02-import-microsoft-forms.txt    version collable dans l'import rapide de Forms
  05-formulaire-a-importer.docx    fichier Word à charger dans « Import your file » de Forms
                                   (généré par generate_docx.js à partir de form.json)
  03-parametrage-microsoft-forms.md mode opératoire Forms (sections, branchements, réglages)
  04-apercu-formulaire.html        maquette de rendu pour validation interne

Usage : python3 generate.py
"""
import html, io, json, os

HERE = os.path.dirname(os.path.abspath(__file__))

SHORT, LONG, DROPDOWN, RADIO, CHECK, LIKERT, SCALE = (
    "short", "long", "dropdown", "radio", "check", "likert", "scale")

SAT = ["Très satisfait(e)", "Plutôt satisfait(e)", "Plutôt insatisfait(e)", "Très insatisfait(e)"]
EVOL = ["Nettement améliorée", "Plutôt améliorée", "Inchangée", "Plutôt dégradée",
        "Nettement dégradée", "Je ne peux pas comparer"]
FREQ = ["Oui, tout à fait adaptée", "Plutôt adaptée", "Plutôt insuffisante",
        "Nettement insuffisante", "Je ne sais pas"]
DELAI_OK = ["Oui, tout à fait", "Plutôt oui", "Plutôt non", "Non, beaucoup trop long"]

LIKERT_ROWS = ["Accueil / espace d'attente", "Cabines audio / salles de soin",
               "Bureaux et espaces de travail", "Sanitaires", "Sols (aspiration, lavage)",
               "Dépoussiérage des surfaces et mobilier", "Évacuation des poubelles",
               "Espace de pause / cuisine"]
LIKERT_COLS = ["Très satisfait(e)", "Plutôt satisfait(e)", "Plutôt insatisfait(e)",
               "Très insatisfait(e)", "Non concerné"]


def q(key, typ, text, options=None, required=False, help=None, branch=None, note=None, doc=None):
    """doc : libellé alternatif utilisé dans les fichiers d'import Word/PDF, où les
    consignes internes n'ont pas leur place et où le type de question se devine du libellé."""
    return dict(key=key, typ=typ, text=text, options=options or [], required=required,
                help=help, branch=branch or [], note=note, doc=doc)


SECTIONS = [
 dict(key="centre", title="Votre centre", desc="", questions=[
   q("nom", SHORT, "Nom / ville du centre Audika", required=True),
   q("code", SHORT, "Code centre", help="Si vous ne le connaissez pas, laissez vide.",
      doc="Code centre (réponse libre — laissez vide si vous ne le connaissez pas)"),
   q("region", DROPDOWN, "Région / secteur", [
      "Île-de-France", "Nord / Hauts-de-France", "Grand Est", "Bretagne / Pays de la Loire",
      "Normandie", "Centre-Val de Loire / Bourgogne-Franche-Comté", "Nouvelle-Aquitaine",
      "Occitanie", "Auvergne-Rhône-Alpes", "PACA / Corse", "Autre / Je ne sais pas"], True),
   q("fonction", RADIO, "Votre fonction", [
      "Audioprothésiste", "Assistant(e) / Coordinateur(trice) de centre",
      "Responsable de secteur / Manager régional", "Autre"], True),
   q("vague1", RADIO, "Aviez-vous répondu à la première enquête ?",
      ["Oui", "Non", "Je ne me souviens pas"]),
 ]),

 dict(key="menage", title="Le ménage",
      desc="Il s'agit du nettoyage courant de vos locaux : sols, surfaces, sanitaires, poubelles.",
      questions=[
   q("men_glob", RADIO, "De manière générale, êtes-vous satisfait(e) de la qualité du ménage dans votre centre ?", SAT, True),
   q("men_zones", LIKERT, "Pour chacune des zones suivantes, quel est votre niveau de satisfaction ?", required=True),
   q("men_freq", RADIO, "La fréquence de passage pour le ménage est-elle adaptée aux besoins de votre centre ?", [
      "Oui, tout à fait adaptée", "Plutôt adaptée", "Plutôt insuffisante",
      "Nettement insuffisante", "Excessive par rapport à nos besoins"], True),
   q("men_horaires", RADIO, "Les passages ont-ils lieu aux jours et horaires prévus au contrat ?", [
      "Toujours", "Le plus souvent", "Rarement", "Jamais", "Je ne connais pas les horaires prévus"], True),
   q("men_evol", RADIO, "Depuis la première enquête, comment a évolué la qualité du ménage dans votre centre ?",
      EVOL[:-1] + ["Je ne peux pas comparer (arrivé(e) récemment)"], True),
   q("men_com", LONG, "Un commentaire sur le ménage ? (points positifs, points à corriger)"),
 ]),

 dict(key="vitrerie", title="La vitrerie",
      desc="Il s'agit du nettoyage des vitrines, baies vitrées et portes vitrées.",
      questions=[
   q("vit_glob", RADIO, "Êtes-vous satisfait(e) de la qualité de la prestation de vitrerie (vitrines, baies, portes vitrées) ?",
      SAT + ["Non concerné / pas de vitrerie dans mon centre"], True),
   q("vit_freq", RADIO, "La fréquence de passage pour la vitrerie est-elle adaptée ?", FREQ, True),
   q("vit_dernier", RADIO, "À quand remonte le dernier passage vitrerie dans votre centre ?", [
      "Moins d'un mois", "1 à 3 mois", "3 à 6 mois", "Plus de 6 mois", "Je ne sais pas"]),
   q("vit_delai", RADIO, "Le délai entre deux passages de vitrerie vous permet-il de maintenir une vitrine présentable pour les patients ?", [
      "Oui, sans difficulté", "Oui, mais tout juste",
      "Non, la vitrine est régulièrement sale entre deux passages", "Je ne sais pas"], True),
   q("vit_evol", RADIO, "Depuis la première enquête, comment a évolué la qualité de la vitrerie ?", EVOL, True),
   q("vit_com", LONG, "Un commentaire sur la vitrerie ?"),
 ]),

 dict(key="dechets", title="L'enlèvement des déchets",
      desc="Sortie et rentrée des conteneurs, évacuation des sacs et des cartons, gestion du tri.",
      questions=[
   q("dec_glob", RADIO, "Êtes-vous satisfait(e) de la prestation d'enlèvement des déchets dans votre centre ?",
      SAT + ["Je ne suis pas concerné(e) par cette prestation"], True,
      branch=[("Je ne suis pas concerné(e) par cette prestation", "SEC:desencombrement")]),
   q("dec_freq", RADIO, "La fréquence d'enlèvement est-elle adaptée au volume de déchets de votre centre ?", FREQ, True),
   q("dec_debord", RADIO, "Arrive-t-il que les conteneurs ou les sacs débordent faute de passage ?", [
      "Jamais", "Rarement", "Souvent", "En permanence"], True),
   q("dec_delai", RADIO, "Le délai entre deux enlèvements vous paraît-il acceptable au quotidien ?", DELAI_OK, True),
   q("dec_types", RADIO, "Les déchets spécifiques (cartons, papier confidentiel, piles et DEEE) sont-ils correctement pris en charge ?", [
      "Oui, pour tous les types de déchets", "Partiellement", "Non", "Je ne sais pas"]),
   q("dec_evol", RADIO, "Depuis la première enquête, comment a évolué la prestation d'enlèvement des déchets ?", EVOL),
   q("dec_com", LONG, "Un commentaire sur l'enlèvement des déchets ?"),
 ]),

 dict(key="desencombrement", title="Le désencombrement",
      desc="Débarras et enlèvements d'encombrants : mobilier, matériel, cartons volumineux, DEEE.",
      questions=[
   q("des_besoin", RADIO, "Votre centre a-t-il eu besoin d'une prestation de désencombrement (débarras, enlèvement d'encombrants, évacuation de matériel ou de mobilier) au cours des 12 derniers mois ?",
      ["Oui", "Non", "Je ne sais pas"], True,
      branch=[("Non", "SEC:espaces_verts"), ("Je ne sais pas", "SEC:espaces_verts")]),
   q("des_qualite", RADIO, "Êtes-vous satisfait(e) de la qualité de la prestation de désencombrement ?", SAT, True),
   q("des_delai", RADIO, "Quel a été le délai entre votre demande (ticket) et l'intervention ?", [
      "Moins d'une semaine", "1 à 2 semaines", "2 à 4 semaines", "Plus d'un mois",
      "L'intervention n'a jamais eu lieu", "Je ne sais plus"], True),
   q("des_delai_ok", RADIO, "Ce délai d'intervention vous paraît-il acceptable ?", DELAI_OK, True),
   q("des_complet", RADIO, "L'enlèvement a-t-il été complet (rien n'est resté sur place) ?", [
      "Oui, totalement", "Partiellement", "Non", "Je ne sais pas"]),
   q("des_evol", RADIO, "Depuis la première enquête, comment a évolué la prestation de désencombrement ?", EVOL),
   q("des_com", LONG, "Un commentaire sur le désencombrement ?"),
 ]),

 dict(key="espaces_verts", title="Les espaces verts",
      desc="Tonte, taille des haies, désherbage, jardinières, entretien des abords et de la terrasse.",
      questions=[
   q("ev_concerne", RADIO, "Votre centre est-il concerné par l'entretien d'espaces verts ?", [
      "Oui, un prestataire intervient",
      "Oui, mais aucun prestataire n'intervient à ma connaissance",
      "Je ne suis pas concerné(e) par la maintenance des espaces verts"], True,
      branch=[("Oui, mais aucun prestataire n'intervient à ma connaissance", "SEC:prestataire"),
              ("Je ne suis pas concerné(e) par la maintenance des espaces verts", "SEC:prestataire")]),
   q("ev_qualite", RADIO, "Êtes-vous satisfait(e) de la qualité de l'entretien des espaces verts ?", SAT, True),
   q("ev_freq", RADIO, "La fréquence de passage pour les espaces verts est-elle adaptée ?", FREQ, True),
   q("ev_saison", RADIO, "Les passages sont-ils bien répartis sur l'année (tonte, taille, désherbage aux bonnes saisons) ?", [
      "Oui, tout à fait", "Plutôt oui", "Plutôt non, il y a des périodes sans passage",
      "Non, les passages sont trop irréguliers", "Je ne sais pas"], True),
   q("ev_abords", RADIO, "Les abords immédiats du centre (entrée, trottoir, parking, jardinières) sont-ils présentables pour les patients ?", [
      "Oui, toujours", "Le plus souvent", "Rarement", "Jamais"]),
   q("ev_evol", RADIO, "Depuis la première enquête, comment a évolué l'entretien des espaces verts ?", EVOL),
   q("ev_com", LONG, "Un commentaire sur les espaces verts ?"),
 ]),

 dict(key="prestataire", title="Changement de prestataire", desc="", questions=[
   q("pre_change", RADIO, "Y a-t-il eu un changement de prestataire dans votre centre au cours des 12 derniers mois ?",
      ["Oui", "Non", "Je ne sais pas"], True,
      branch=[("Non", "SEC:process"), ("Je ne sais pas", "SEC:process")]),
   q("pre_juge", RADIO, "Depuis ce changement, comment jugez-vous la prestation par rapport à l'ancien prestataire ?", [
      "Bien meilleure", "Meilleure", "Équivalente", "Moins bonne", "Bien moins bonne"], True),
   q("pre_points", CHECK, "Sur quels points l'amélioration est-elle la plus visible ?", [
      "Qualité du nettoyage", "Régularité et respect des passages", "Respect des horaires convenus",
      "Qualité de la vitrerie", "Enlèvement des déchets", "Traitement des encombrants",
      "Entretien des espaces verts", "Réactivité sur les demandes ponctuelles",
      "Communication / relation avec les intervenants", "Stabilité des équipes (mêmes intervenants)",
      "Aucune amélioration visible"]),
   q("pre_reste", LONG, "Quels points restent à améliorer avec le nouveau prestataire ?"),
 ]),

 dict(key="process", title="Rappel du process Services Généraux", desc="__PROCESS__", questions=[
   q("pro_connu", RADIO, "Connaissiez-vous ce process (ticket auprès des Services Généraux) avant cette enquête ?", [
      "Oui, et je l'utilise systématiquement", "Oui, mais je ne l'utilise pas toujours",
      "Non, je ne le connaissais pas"], True),
   q("pro_ticket", RADIO, "Au cours des 6 derniers mois, avez-vous créé au moins un ticket concernant ces prestations ?",
      ["Oui", "Non"], True, branch=[("Oui", "Q:pro_satis"), ("Non", "Q:pro_raisons")]),
   q("pro_satis", RADIO, "Êtes-vous satisfait(e) du traitement de vos tickets par les Services Généraux ?", SAT),
   q("pro_delai", RADIO, "Le délai de traitement de vos tickets vous paraît-il acceptable ?", DELAI_OK,
      branch=[(o, "Q:pro_confirm") for o in DELAI_OK]),
   q("pro_raisons", CHECK, "Si vous n'avez pas créé de ticket, pour quelle raison ?", [
      "Je n'en ai pas eu besoin, tout va bien", "Je ne connaissais pas le process",
      "Je ne sais pas comment/où créer un ticket",
      "Je contacte directement le prestataire ou l'intervenant",
      "J'en parle à mon responsable de secteur", "Je n'ai pas le temps",
      "Les tickets précédents n'ont pas abouti", "Autre"]),
   q("pro_confirm", CHECK, "Je confirme avoir pris connaissance du process : toute demande d'intervention ou signalement passe par un ticket auprès des Services Généraux.",
      ["Oui, j'ai bien noté"], True),
 ]),

 dict(key="synthese", title="Synthèse et remarques", desc="", questions=[
   q("syn_note", SCALE, "Globalement, quelle note donnez-vous aujourd'hui à l'ensemble des prestations de propreté et d'entretien de votre centre ?",
      required=True, help="1 = très insatisfaisant • 10 = excellent"),
   q("syn_prio", LONG, "Si vous aviez une seule chose à améliorer en priorité, quelle serait-elle ?"),
   q("syn_recontact", RADIO, "Souhaitez-vous être recontacté(e) par les Services Généraux au sujet de votre centre ?",
      ["Oui", "Non"], branch=[("Oui", "Q:syn_mail"), ("Non", "Fin du formulaire")]),
   q("syn_mail", SHORT, "Votre email professionnel",
      help="Validation « adresse e-mail » à activer dans Forms.",
      doc="Votre email professionnel (réponse libre)"),
 ]),
]

# --- numérotation ---------------------------------------------------------
NUM, QBY = {}, {}
_i = 0
for si, s in enumerate(SECTIONS, 1):
    s["num"] = si
    for qq in s["questions"]:
        _i += 1
        qq["id"] = "Q%d" % _i
        qq["section"] = s
        NUM[qq["key"]] = qq["id"]
        QBY[qq["key"]] = qq
NQ = _i
SEC_BY = {s["key"]: s for s in SECTIONS}
ALL_Q = [qq for s in SECTIONS for qq in s["questions"]]


def target(ref):
    if ref.startswith("SEC:"):
        s = SEC_BY[ref[4:]]
        return "Section %d — %s" % (s["num"], s["title"])
    if ref.startswith("Q:"):
        k = ref[2:]
        return "%s (%s)" % (NUM[k], QBY[k]["text"][:48].rstrip() + ("…" if len(QBY[k]["text"]) > 48 else ""))
    return ref


def uniform(qq):
    """Toutes les options de la question mènent-elles à la même destination ?"""
    return (qq["branch"] and qq["options"]
            and len(qq["branch"]) == len(qq["options"])
            and len({t for _, t in qq["branch"]}) == 1)


def branch_short(qq):
    if uniform(qq):
        return "quelle que soit la réponse → %s" % target(qq["branch"][0][1]).split(" (")[0]
    return " · ".join("« %s » → %s" % (a, target(t).split(" (")[0]) for a, t in qq["branch"])


TITLE = "Enquête Propreté – Centres Audika – Vague 2"

INTRO_MD = """Bonjour,

Il y a quelques mois, vous avez été nombreux à répondre à notre première enquête sur les
prestations de propreté et d'entretien de votre centre. Merci encore pour vos retours : ils ont
été analysés centre par centre et ont donné lieu à des **plans d'actions avec nos prestataires**
ainsi qu'à des **ajustements contractuels** (fréquences de passage, périmètre des prestations,
changement de prestataire sur certains sites).

Cette seconde enquête a un objectif simple : **mesurer ce qui a réellement changé sur le terrain.**
Elle porte sur cinq prestations — le **ménage**, la **vitrerie**, l'**enlèvement des déchets**,
le **désencombrement** et l'**entretien des espaces verts** — ainsi que sur les **délais et
fréquences de passage** de chacune d'entre elles.

⏱️ **Durée : environ 5 minutes** (les prestations qui ne concernent pas votre centre sont
automatiquement ignorées).
📅 **Merci de répondre avant le [DATE LIMITE].**
🔒 Vos réponses sont traitées par le service Services Généraux et analysées par centre."""

PROCESS_MD = """📌 **Rappel important du process** : toute demande d'intervention ou tout signalement
(problème de propreté, prestation non réalisée, besoin ponctuel, dégradation…) doit
**obligatoirement faire l'objet d'un ticket auprès des Services Généraux**.
Merci de ne pas solliciter directement le prestataire : sans ticket, la demande n'est ni tracée,
ni suivie, ni opposable au prestataire lors des revues de contrat."""

PROCESS_BLOCK_MD = """> ### 📌 Le process à retenir
>
> **Toute demande d'intervention ou tout signalement doit faire l'objet d'un ticket
> auprès des Services Généraux.**
>
> Cela concerne notamment :
> - une prestation non réalisée ou réalisée partiellement ;
> - un problème de qualité constaté (ménage, vitrerie, déchets, encombrants, espaces verts) ;
> - un besoin ponctuel ou exceptionnel (remise en état, débarras, intervention supplémentaire) ;
> - une dégradation, un dysfonctionnement ou une demande d'ajustement de prestation.
>
> **Merci de ne pas contacter directement le prestataire.**
> Un signalement sans ticket n'est ni tracé, ni suivi, ni opposable au prestataire lors des
> revues de contrat : c'est le volume et l'historique des tickets qui nous permettent
> d'obtenir des corrections et de renégocier les prestations.
>
> ➡️ **Créer un ticket : [LIEN / OUTIL DE TICKETING] — [ADRESSE MAIL SERVICES GÉNÉRAUX]**"""

FIN_MD = """Merci pour le temps que vous nous avez consacré.

Vos réponses seront analysées centre par centre et comparées à celles de la première enquête.
Une synthèse des résultats et des actions engagées vous sera communiquée par les Services Généraux.

📌 **Et d'ici là, un réflexe : un besoin, un problème, un signalement → un ticket Services Généraux.**"""

TYPE_MD = {SHORT: "réponse courte", LONG: "texte long", DROPDOWN: "liste déroulante",
           RADIO: "choix unique", CHECK: "choix multiple", LIKERT: "Likert / grille",
           SCALE: "échelle de notation 1 à 10"}


# --- 01 : contenu du formulaire ------------------------------------------
def build_md():
    o = io.StringIO(); w = o.write
    w("# %s\n\n" % TITLE)
    w("> **Document de référence** : contenu intégral du formulaire Microsoft Forms.\n"
      "> Pour la saisie rapide dans Forms, utiliser `02-import-microsoft-forms.txt`.\n"
      "> Pour la logique de branchement et les réglages, voir `03-parametrage-microsoft-forms.md`.\n"
      "> Ce fichier est généré par `generate.py` — modifier la source, pas le rendu.\n\n---\n\n")
    w("## Titre du formulaire\n\n**%s**\n\n" % TITLE)
    w("## Description (texte d'introduction)\n\n%s\n\n%s\n\n---\n\n" % (INTRO_MD, PROCESS_MD))
    for s in SECTIONS:
        w("# SECTION %d — %s\n\n" % (s["num"], s["title"]))
        if s["desc"] == "__PROCESS__":
            w(PROCESS_BLOCK_MD + "\n\n")
        elif s["desc"]:
            w("*%s*\n\n" % s["desc"])
        for qq in s["questions"]:
            flags = TYPE_MD[qq["typ"]]
            if qq["required"]: flags += " — obligatoire"
            if qq["branch"]: flags += " — déclenche un branchement"
            w("**%s. %s**\n*(%s)*\n\n" % (qq["id"], qq["text"], flags))
            if qq["help"]: w("> %s\n\n" % qq["help"])
            if qq["typ"] == LIKERT:
                w("| Zone | " + " | ".join(LIKERT_COLS) + " |\n")
                w("|" + "---|" * (len(LIKERT_COLS) + 1) + "\n")
                for r in LIKERT_ROWS:
                    w("| %s |%s\n" % (r, " |" * len(LIKERT_COLS)))
                w("\n")
            elif qq["typ"] == SCALE:
                w("`1` `2` `3` `4` `5` `6` `7` `8` `9` `10`\n\n")
            else:
                bmap = dict(qq["branch"])
                if uniform(qq):
                    for opt in qq["options"]:
                        w("- %s\n" % opt)
                    w("\n> ℹ️ Quelle que soit la réponse, ramification vers **%s**.\n\n"
                      % target(qq["branch"][0][1]).split(" (")[0])
                    if qq["note"]: w("> ℹ️ %s\n\n" % qq["note"])
                    continue
                for opt in qq["options"]:
                    arrow = ""
                    if opt in bmap:
                        arrow = " → **%s**" % target(bmap[opt]).split(" (")[0]
                    elif qq["branch"]:
                        nxt = ALL_Q[ALL_Q.index(qq) + 1]
                        arrow = " → %s" % nxt["id"]
                    w("- %s%s\n" % (opt, arrow))
                if qq["options"]: w("\n")
            if qq["note"]: w("> ℹ️ %s\n\n" % qq["note"])
        w("---\n\n")
    w("## Message de fin (page de remerciement)\n\n%s\n" % FIN_MD)
    return o.getvalue()


# --- 02 : import rapide ---------------------------------------------------
def build_txt():
    o = io.StringIO(); w = o.write
    flat = INTRO_MD.replace("**", "").replace("\n\n", " ").replace("\n", " ")
    w("%s\n\n%s %s\n\n" % (TITLE, flat, PROCESS_MD.replace("**", "").replace("\n", " ")))
    for s in SECTIONS:
        w("=== SECTION %d — %s ===\n" % (s["num"], s["title"]))
        if s["desc"] and s["desc"] != "__PROCESS__":
            w("[Description de section : %s]\n" % s["desc"])
        if s["desc"] == "__PROCESS__":
            w("[Description de section — coller le bloc « Le process à retenir » "
              "avec le lien de ticketing et le mail Services Généraux]\n")
        w("\n")
        for qq in s["questions"]:
            w(qq["text"] + "\n")
            if qq["typ"] == LIKERT:
                w("[Likert — Lignes : %s]\n" % " ; ".join(LIKERT_ROWS))
                w("[Likert — Colonnes : %s]\n" % " ; ".join(LIKERT_COLS))
            elif qq["typ"] == SCALE:
                w("[Notation 1 à 10]\n")
            elif qq["typ"] == LONG:
                w("[Réponse longue]\n")
            elif qq["typ"] == SHORT:
                w("[Réponse courte%s]\n" % (" - obligatoire" if qq["required"] else ""))
            else:
                for opt in qq["options"]:
                    w(opt + "\n")
                if qq["typ"] == CHECK: w("[Choix multiple]\n")
                if qq["typ"] == DROPDOWN: w("[Liste déroulante]\n")
            w("\n")
    w("=== MESSAGE DE FIN ===\n%s\n" % FIN_MD.replace("**", ""))
    return o.getvalue()


# --- 03 : paramétrage -----------------------------------------------------
def build_setup():
    o = io.StringIO(); w = o.write
    req = [qq["id"] for qq in ALL_Q if qq["required"]]
    w("""# Paramétrage Microsoft Forms — %s

Pas-à-pas pour construire le formulaire, poser les branchements et le diffuser.
*(Fichier généré par `generate.py`.)*

---

## 1. Créer le formulaire

1. Aller sur **forms.office.com** → **Nouveau formulaire**.
2. Titre : `%s`
3. Description : coller le texte d'introduction de `01-enquete-menage-audika.md`.
4. Saisie des questions — par ordre de préférence :

   **a. Import du fichier Word (recommandé)** — c'est la voie disponible dans la plupart des
   locataires : *Nouveau formulaire* → **Importer un fichier / Import your file** →
   **Upload from this device** → choisir **`05-formulaire-a-importer.docx`** (15 Ko, très en
   dessous de la limite de 10 Mo). Forms lit le document et crée les questions avec leurs
   propositions de réponses. `06-formulaire-a-importer.pdf` contient exactement la même chose
   au format PDF, si l'import du .docx donne un résultat imparfait.

   **b. Importation rapide (collage de texte)** — si votre locataire propose ce bouton :
   coller `02-import-microsoft-forms.txt`, puis supprimer les lignes entre crochets `[...]`
   et les séparateurs `=== ... ===`, qui sont des consignes. Beaucoup de locataires n'offrent
   que l'import de fichier : dans ce cas, utiliser la voie **a**.

   **c. Manuel** — recréer les %d questions à partir de `01-enquete-menage-audika.md`.

### À vérifier systématiquement après l'import

L'import est une reconnaissance automatique : il fait gagner la saisie, pas la relecture.

- **Les %d questions sont-elles toutes là**, dans l'ordre, sans question fantôme créée à partir
  de l'introduction, du rappel de process ou du message de fin ? Supprimer les intrus : ces
  textes doivent être respectivement la **description du formulaire**, la **description de la
  section 8** et le **message de confirmation** (voir §6), pas des questions.
- **Les titres de section** (« Section 1 — … ») sont probablement importés comme du texte ou
  ignorés : recréer les vraies sections à l'étape 2, elles conditionnent les branchements.
- **La grille Likert** (question %s) est le point le plus fragile de l'import : si elle arrive
  sous forme de tableau cassé ou de questions séparées, la supprimer et la recréer à la main
  en type **Likert** (%d lignes / %d colonnes, voir §4).
- **Les types de questions** : tout arrive généralement en « Choix » ou « Texte ». Appliquer
  les corrections du §4, puis cocher les %d questions obligatoires listées plus bas.

---

## 2. Découper en sections

Forms → **+ Ajouter nouveau** → **Section**. Créer %d sections :

| # | Titre de section | Questions |
|---|---|---|
""" % (TITLE, TITLE, NQ, NQ, NUM["men_zones"], len(LIKERT_ROWS), len(LIKERT_COLS),
       sum(1 for _q in ALL_Q if _q["required"]), len(SECTIONS)))
    for s in SECTIONS:
        qs = s["questions"]
        w("| %d | %s | %s → %s |\n" % (s["num"], s["title"], qs[0]["id"], qs[-1]["id"]))
    w("""
> ⚠️ Le découpage en sections est **indispensable** : sans sections, Microsoft Forms ne permet pas
> les branchements de type « passer à la section suivante ».

**Descriptions de section à renseigner** (`...` de la section → *Ajouter une description*) :

""")
    for s in SECTIONS:
        if s["desc"] == "__PROCESS__":
            w("- **Section %d** : coller le bloc « Le process à retenir » de "
              "`01-enquete-menage-audika.md`, avec le lien vers l'outil de ticketing et "
              "l'adresse mail des Services Généraux.\n" % s["num"])
        elif s["desc"]:
            w("- **Section %d** : « %s »\n" % (s["num"], s["desc"]))
    w("""
---

## 3. Branchements (Ramification)

`...` en haut à droite du formulaire → **Ramification** (*Branching*).

| Question | Réponse | Aller à |
|---|---|---|
""")
    for qq in ALL_Q:
        if not qq["branch"]: continue
        bmap = dict(qq["branch"])
        if uniform(qq):
            w("| **%s** %s… | (toutes réponses) | %s |\n"
              % (qq["id"], qq["text"][:44], target(qq["branch"][0][1])))
            continue
        nxt = ALL_Q[ALL_Q.index(qq) + 1] if ALL_Q.index(qq) + 1 < NQ else None
        first = True
        for opt in (qq["options"] or [a for a, _ in qq["branch"]]):
            dest = target(bmap[opt]) if opt in bmap else (
                "%s (suite de la section)" % nxt["id"] if nxt else "Fin du formulaire")
            w("| %s | %s | %s |\n" % ("**%s** %s" % (qq["id"], qq["text"][:44] + "…") if first else "",
                                      opt, dest))
            first = False
    w("""
---

## 4. Types de questions à corriger après import

| Question | Type Forms à appliquer |
|---|---|
""")
    forms_type = {SHORT: "Texte → réponse courte", LONG: "Texte → activer **Réponse longue**",
                  DROPDOWN: "Choix → activer **Liste déroulante**",
                  CHECK: "Choix → activer **Plusieurs réponses**",
                  LIKERT: "**Likert** (%d lignes / %d colonnes)" % (len(LIKERT_ROWS), len(LIKERT_COLS)),
                  SCALE: "**Notation** → 10 niveaux, symbole « Nombre »"}
    grouped = {}
    for qq in ALL_Q:
        if qq["typ"] == RADIO: continue
        grouped.setdefault(forms_type[qq["typ"]], []).append(qq["id"])
    for t, ids in grouped.items():
        w("| %s | %s |\n" % (", ".join(ids), t))
    w("| %s | Choix à 1 option + **Obligatoire** (case à cocher d'accusé de lecture) |\n" % NUM["pro_confirm"])
    w("| %s | Texte → **Restrictions** → *Adresse e-mail* |\n" % NUM["syn_mail"])
    w("""
Toutes les autres questions sont des **Choix** à réponse unique.

**Questions obligatoires** (%d) : %s.
Tout le reste est facultatif, pour ne pas décourager la réponse.

---

## 5. Thème et logo Audika

`Thème` (en haut à droite) → **Personnaliser le thème** :

1. **Image** → *Télécharger* → charger le fichier du logo Audika officiel (intranet /
   communication interne — PNG à fond transparent, largeur ≥ 600 px). Le logo s'affiche en
   bandeau d'en-tête du formulaire.
2. **Couleur** → couleur personnalisée, code hexadécimal de la charte Audika (à confirmer auprès
   de la communication ; à défaut, un bleu foncé type `#0B3C5D` reste neutre et lisible).
3. Vérifier le rendu sur mobile : la majorité des réponses en centre se font sur téléphone.

> `04-apercu-formulaire.html` est une **maquette de rendu** pour validation interne avant saisie.
> Elle utilise un placeholder texte à la place du logo : charger le fichier officiel dans Forms.

---

## 6. Paramètres de collecte

`...` → **Paramètres** :

- ✅ **Toute personne de mon organisation peut répondre** (authentification Audika / Demant).
- ✅ **Enregistrer le nom** — recommandé : les réponses doivent être rattachées à un centre pour
  piloter les plans d'actions par site. Si vous préférez l'anonymat pour libérer la parole,
  décochez, mais gardez %s (nom du centre) obligatoire.
- ✅ **Une réponse par personne** — évite les doublons dans la comparaison vague 1 / vague 2.
- ✅ **Accepter les réponses** avec une **date de fin** alignée sur la date limite de l'intro.
- ✅ **Notification par e-mail de chaque réponse** pour traiter les insatisfactions au fil de l'eau.
- **Message de confirmation personnalisé** : coller le « Message de fin ».

---

## 7. Diffusion

1. **Envoyer** → *Lien* (raccourci) + *Code QR* à afficher en réserve de centre.
2. Mail de lancement aux centres — objet suggéré : *« 5 minutes : votre avis sur la propreté et
   l'entretien de votre centre — 2ᵉ enquête »*, avec le rappel du process ticket en corps de mail.
3. **Relance à J+7** aux non-répondants, clôture à J+14.

---

## 8. Exploitation des résultats

- Onglet **Réponses** → *Ouvrir dans Excel* pour croiser par centre / région / prestataire.
- Comparer les questions d'évolution (**%s**) avec les scores de la vague 1 :
  ce sont elles qui mesurent l'effet des plans d'actions, prestation par prestation.
- Comparer **%s** (jugement après changement de prestataire) sur les seuls centres concernés :
  c'est l'indicateur d'arbitrage pour étendre ou non le changement à d'autres sites.
- Croiser les questions de **fréquence / délai** (%s) : elles alimentent directement
  la renégociation des fréquences contractuelles.
- **%s** (note /10) sert d'indicateur de pilotage à suivre d'une vague à l'autre.
- Sortir la liste des centres avec ≥ 2 réponses « insatisfait » → plan d'action individuel avec
  le prestataire lors de la revue de contrat.
- **%s** + **%s** mesurent l'ancrage du process ticket : si « Non, je ne le connaissais pas »
  dépasse 20 %%, prévoir une communication dédiée avant la vague 3.
- Le taux de « Je ne suis pas concerné(e) » sur %s et %s permet au passage de fiabiliser le
  périmètre réel des prestations centre par centre.
""" % (len(req), ", ".join(req), NUM["nom"],
       ", ".join(NUM[k] for k in ["men_evol", "vit_evol", "dec_evol", "des_evol", "ev_evol"]),
       NUM["pre_juge"],
       ", ".join(NUM[k] for k in ["men_freq", "vit_freq", "dec_freq", "des_delai_ok", "ev_freq"]),
       NUM["syn_note"], NUM["pro_connu"], NUM["pro_raisons"],
       NUM["dec_glob"], NUM["ev_concerne"]))
    return o.getvalue()


# --- 04 : maquette HTML ---------------------------------------------------
PROCESS_HTML = """
<div class="process">
  <p class="process-title">%s</p>
  <p><strong>Toute demande d'intervention ou tout signalement doit faire l'objet d'un ticket auprès des Services Généraux.</strong></p>
  <ul>
    <li>une prestation non réalisée ou réalisée partiellement ;</li>
    <li>un problème de qualité constaté (ménage, vitrerie, déchets, encombrants, espaces verts) ;</li>
    <li>un besoin ponctuel ou exceptionnel (remise en état, débarras, intervention supplémentaire) ;</li>
    <li>une dégradation, un dysfonctionnement ou une demande d'ajustement de prestation.</li>
  </ul>
  <p><strong>Merci de ne pas contacter directement le prestataire.</strong> Un signalement sans ticket n'est ni tracé, ni suivi, ni opposable au prestataire lors des revues de contrat : c'est le volume et l'historique des tickets qui nous permettent d'obtenir des corrections et de renégocier les prestations.</p>
  <p class="process-cta">➡️ Créer un ticket : <span class="ph">[LIEN OUTIL DE TICKETING]</span> — <span class="ph">[MAIL SERVICES GÉNÉRAUX]</span></p>
</div>"""

CSS = """
:root{--bg:#eef1f6;--card:#fff;--ink:#16202b;--muted:#5b6b7c;--line:#dde3ea;--brand:#0b3c5d;
--brand-soft:#e8f0f6;--accent:#c9531f;--req:#c9531f;--note-bg:#fff8e8;--note-line:#e8c37a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#11161c;--card:#1a212a;
--ink:#e6ebf1;--muted:#9aa9b8;--line:#2b3743;--brand:#7fb6d9;--brand-soft:#16242f;--accent:#f0a071;
--req:#f0a071;--note-bg:#241f14;--note-line:#6b5320}}
:root[data-theme="dark"]{--bg:#11161c;--card:#1a212a;--ink:#e6ebf1;--muted:#9aa9b8;--line:#2b3743;
--brand:#7fb6d9;--brand-soft:#16242f;--accent:#f0a071;--req:#f0a071;--note-bg:#241f14;--note-line:#6b5320}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Segoe UI",-apple-system,
BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 64px}
.mockup-note{background:var(--note-bg);border:1px solid var(--note-line);border-radius:8px;
padding:10px 14px;font-size:13px;margin-bottom:18px}
.header{background:var(--card);border:1px solid var(--line);border-top:8px solid var(--brand);
border-radius:10px;padding:26px 28px;margin-bottom:16px}
.logo-slot{display:inline-flex;align-items:center;gap:10px;padding:8px 16px;border:1px dashed var(--line);
border-radius:6px;margin-bottom:18px}
.logo-word{font-size:26px;font-weight:700;letter-spacing:.08em;color:var(--brand)}
.logo-hint{font-size:11px;color:var(--muted);max-width:190px;line-height:1.3}
h1{font-size:26px;margin:0 0 14px;font-weight:600}
.intro p{margin:0 0 12px;font-size:15px}
.intro .meta{font-size:14px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin-bottom:12px}
.sec-head{background:var(--brand-soft);border:1px solid var(--line);border-left:5px solid var(--brand);
border-radius:10px;padding:16px 22px;margin:26px 0 12px}
.sec-head .kicker{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
.sec-head h2{margin:4px 0 0;font-size:19px;font-weight:600}
.sec-head p{margin:6px 0 0;font-size:14px;color:var(--muted)}
.qnum{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.06em}
.qtitle{font-size:16px;font-weight:600;margin:2px 0 4px}
.qhelp{font-size:13px;color:var(--muted);margin-bottom:10px}
.qtitle+.opt,.qtitle+.field,.qtitle+.area,.qtitle+.select,.qtitle+.scale,.qtitle+.tablewrap{margin-top:10px}
.req{color:var(--req);margin-left:3px}
.opt{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:15px}
.dot{width:17px;height:17px;border:2px solid var(--muted);border-radius:50%;flex:0 0 auto;margin-top:2px}
.box{width:17px;height:17px;border:2px solid var(--muted);border-radius:3px;flex:0 0 auto;margin-top:2px}
.field{border:0;border-bottom:1px solid var(--line);height:32px;color:var(--muted);font-size:14px;
display:flex;align-items:flex-end;padding-bottom:4px}
.area{border:1px solid var(--line);border-radius:6px;height:78px;color:var(--muted);font-size:14px;padding:8px 10px}
.select{border:1px solid var(--line);border-radius:6px;height:38px;display:flex;align-items:center;
justify-content:space-between;padding:0 12px;color:var(--muted);font-size:14px}
.scale{display:flex;gap:8px;flex-wrap:wrap}
.scale span{width:38px;height:38px;border:1px solid var(--line);border-radius:6px;display:flex;
align-items:center;justify-content:center;font-size:14px;color:var(--muted)}
.scale-legend{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:8px}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:560px}
th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:center;color:var(--muted)}
th:first-child,td:first-child{text-align:left;color:var(--ink);font-weight:500;min-width:190px}
th{font-weight:600;font-size:12px;vertical-align:bottom}
td .dot{margin:0 auto}
.branch{margin-top:12px;font-size:12px;color:var(--muted);background:var(--brand-soft);
border-radius:6px;padding:6px 10px;display:inline-block}
.process{background:var(--note-bg);border:1px solid var(--note-line);border-radius:8px;padding:16px 18px;margin-top:12px}
.process p{margin:0 0 10px;font-size:14px}
.process ul{margin:0 0 10px;padding-left:20px;font-size:14px}
.process li{margin-bottom:4px}
.process-title{font-weight:700;font-size:15px}
.process-cta{margin-bottom:0;font-weight:600}
.ph{color:var(--accent);font-weight:600}
.end{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--brand);
border-radius:10px;padding:20px 22px;margin-top:26px}
.end h3{margin:0 0 10px;font-size:16px}
.end p{margin:0 0 10px;font-size:14px}
.footer{text-align:center;font-size:12px;color:var(--muted);margin-top:28px}
"""


def build_html():
    e = html.escape
    o = io.StringIO(); w = o.write
    w('<!doctype html>\n<html lang="fr"><head><meta charset="utf-8">\n'
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      '<title>%s</title>\n<style>%s</style></head><body><div class="wrap">\n' % (e(TITLE), CSS))
    w('<div class="mockup-note"><strong>Maquette de validation interne</strong> — aperçu du rendu du '
      'formulaire Microsoft Forms avant saisie. Les champs ne sont pas actifs. Le logo officiel Audika '
      'est à charger dans le thème Forms (voir <code>03-parametrage-microsoft-forms.md</code>).</div>\n')
    w("""<div class="header">
  <div class="logo-slot"><span class="logo-word">audika</span>
    <span class="logo-hint">Emplacement du logo officiel — à charger dans Thème &gt; Image</span></div>
  <h1>%s</h1>
  <div class="intro">
    <p>Bonjour,</p>
    <p>Il y a quelques mois, vous avez été nombreux à répondre à notre première enquête sur les prestations
    de propreté et d'entretien de votre centre. Merci encore pour vos retours : ils ont été analysés centre
    par centre et ont donné lieu à des <strong>plans d'actions avec nos prestataires</strong> ainsi qu'à des
    <strong>ajustements contractuels</strong> (fréquences de passage, périmètre des prestations,
    changement de prestataire sur certains sites).</p>
    <p>Cette seconde enquête a un objectif simple : <strong>mesurer ce qui a réellement changé sur le
    terrain.</strong> Elle porte sur cinq prestations — le <strong>ménage</strong>, la
    <strong>vitrerie</strong>, l'<strong>enlèvement des déchets</strong>, le
    <strong>désencombrement</strong> et l'<strong>entretien des espaces verts</strong> — ainsi que sur les
    <strong>délais et fréquences de passage</strong> de chacune d'entre elles.</p>
    <p class="meta">⏱️ Environ 5 minutes (les prestations qui ne concernent pas votre centre sont
    automatiquement ignorées) &nbsp;•&nbsp; 📅 Merci de répondre avant le
    <span class="ph">[DATE LIMITE]</span> &nbsp;•&nbsp; 🔒 Réponses traitées par les Services Généraux
    et analysées par centre.</p>
  </div>
  %s
</div>
""" % (e(TITLE), PROCESS_HTML % "📌 Rappel important du process"))

    for s in SECTIONS:
        w('<div class="sec-head"><div class="kicker">Section %d sur %d</div><h2>%s</h2>'
          % (s["num"], len(SECTIONS), e(s["title"])))
        if s["desc"] == "__PROCESS__":
            w('</div>' + PROCESS_HTML % "📌 Le process à retenir")
        else:
            if s["desc"]: w('<p>%s</p>' % e(s["desc"]))
            w('</div>')
        for qq in s["questions"]:
            w('<div class="card"><div class="qnum">%s</div><div class="qtitle">%s%s</div>'
              % (qq["id"], e(qq["text"]), '<span class="req">*</span>' if qq["required"] else ''))
            if qq["help"]: w('<div class="qhelp">%s</div>' % e(qq["help"]))
            t = qq["typ"]
            if t in (RADIO, CHECK):
                mark = 'dot' if t == RADIO else 'box'
                for opt in qq["options"]:
                    w('<div class="opt"><span class="%s"></span><span>%s</span></div>' % (mark, e(opt)))
            elif t == DROPDOWN:
                w('<div class="select"><span>Sélectionner votre réponse</span><span>▾</span></div>')
            elif t == SHORT:
                w('<div class="field">Saisissez votre réponse</div>')
            elif t == LONG:
                w('<div class="area">Saisissez votre réponse</div>')
            elif t == SCALE:
                w('<div class="scale">%s</div>' % ''.join('<span>%d</span>' % i for i in range(1, 11)))
                w('<div class="scale-legend"><span>1 — très insatisfaisant</span><span>10 — excellent</span></div>')
            elif t == LIKERT:
                w('<div class="tablewrap"><table><thead><tr><th></th>%s</tr></thead><tbody>'
                  % ''.join('<th>%s</th>' % e(c) for c in LIKERT_COLS))
                for r in LIKERT_ROWS:
                    w('<tr><td>%s</td>%s</tr>' % (e(r), '<td><span class="dot"></span></td>' * len(LIKERT_COLS)))
                w('</tbody></table></div>')
            if qq["branch"]:
                w('<div class="branch">↳ Branchement : %s</div>' % e(branch_short(qq)))
            if qq["note"]:
                w('<div class="branch">↳ %s</div>' % e(qq["note"]))
            w('</div>')

    w("""
<div class="end"><h3>Message de fin</h3>
<p>Merci pour le temps que vous nous avez consacré.</p>
<p>Vos réponses seront analysées centre par centre et comparées à celles de la première enquête.
Une synthèse des résultats et des actions engagées vous sera communiquée par les Services Généraux.</p>
<p><strong>📌 Et d'ici là, un réflexe : un besoin, un problème, un signalement → un ticket Services Généraux.</strong></p>
</div>
<div class="footer">%d questions · %d sections · durée estimée 5 minutes — maquette de validation interne</div>
</div></body></html>""" % (NQ, len(SECTIONS)))
    return o.getvalue()


PROCESS_DOC = {
    "title": "Rappel du process — à retenir",
    "paras": [
        "Toute demande d'intervention ou tout signalement doit faire l'objet d'un ticket auprès "
        "des Services Généraux. Cela concerne notamment :",
    ],
    "bullets": [
        "une prestation non réalisée ou réalisée partiellement ;",
        "un problème de qualité constaté (ménage, vitrerie, déchets, encombrants, espaces verts) ;",
        "un besoin ponctuel ou exceptionnel (remise en état, débarras, intervention supplémentaire) ;",
        "une dégradation, un dysfonctionnement ou une demande d'ajustement de prestation.",
    ],
    "after": [
        "Merci de ne pas contacter directement le prestataire. Un signalement sans ticket n'est ni "
        "tracé, ni suivi, ni opposable au prestataire lors des revues de contrat : c'est le volume "
        "et l'historique des tickets qui nous permettent d'obtenir des corrections et de "
        "renégocier les prestations.",
        "Créer un ticket : [LIEN OUTIL DE TICKETING] — [ADRESSE MAIL SERVICES GÉNÉRAUX]",
    ],
}


def plain(md):
    """Markdown → paragraphes de texte simple (pour le Word)."""
    out = []
    for block in md.split("\n\n"):
        t = " ".join(l.strip() for l in block.strip().splitlines())
        out.append(t.replace("**", "").strip())
    return [t for t in out if t]


# Reformulations pour l'import Word : Forms déduit le type de question du libellé,
# on remplace donc les annotations entre crochets par des indices en langage naturel.
DOC_HINT = {
    CHECK: " (plusieurs réponses possibles)",
    LONG: " (réponse libre)",
    SHORT: " (réponse libre)",
}


def build_form_json():
    data = {
        "title": TITLE,
        "intro": plain(INTRO_MD) + plain(PROCESS_MD),
        "fin": plain(FIN_MD),
        "process": PROCESS_DOC,
        "likert": {"rows": LIKERT_ROWS, "cols": LIKERT_COLS},
        "sections": [],
    }
    for s_ in SECTIONS:
        sec = {"num": s_["num"], "title": s_["title"],
               "desc": "" if s_["desc"] == "__PROCESS__" else s_["desc"],
               "process": s_["desc"] == "__PROCESS__", "questions": []}
        for qq in s_["questions"]:
            text = qq["doc"] or qq["text"]
            if qq["doc"]:
                pass
            elif qq["typ"] == SCALE:
                text += " (note de 1 à 10 : 1 = très insatisfaisant, 10 = excellent)"
            elif qq["typ"] in DOC_HINT:
                text += DOC_HINT[qq["typ"]]
            sec["questions"].append({
                "id": qq["id"], "n": int(qq["id"][1:]), "typ": qq["typ"],
                "text": text, "options": qq["options"],
            })
        data["sections"].append(sec)
    return json.dumps(data, ensure_ascii=False, indent=1)


def write(name, content):
    path = os.path.join(HERE, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("%-36s %6d octets" % (name, len(content.encode("utf-8"))))


if __name__ == "__main__":
    write("01-enquete-menage-audika.md", build_md())
    write("02-import-microsoft-forms.txt", build_txt())
    write("03-parametrage-microsoft-forms.md", build_setup())
    write("04-apercu-formulaire.html", build_html())
    write("form.json", build_form_json())
    print("%d questions, %d sections" % (NQ, len(SECTIONS)))
