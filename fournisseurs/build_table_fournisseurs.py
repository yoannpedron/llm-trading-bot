# -*- coding: utf-8 -*-
"""
Consolide l'annuaire fournisseurs Audika en une table a plat, un seul onglet.

Colonnes :
    Pole | Fournisseur | Code fournisseur | Code fournisseur 2 | Domaine d'activite |
    Region | Centre(s) | Coordonnees telephoniques | Personne a contacter | Fonction |
    Numero | Courriel | Commentaire

Une ligne par contact ; les informations fournisseur sont repetees sur chaque ligne
du groupe pour que le tableau reste filtrable et triable tel quel.

Sources :
  - Annuaire_FRN.xlsx  (onglets "annuaire FRN contrats" et "annuaire FRN espaces verts")
  - Audika_Table_correspondance_centres.xlsx (contexte Eurofeu : aucune coordonnee fournisseur)
"""
import re
import sys
import unicodedata
from collections import OrderedDict

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

SRC_FRN = sys.argv[1]
OUT = sys.argv[2]

# Tout ce qui provient de l'annuaire FRN releve du reseau : a defaut de pole renseigne
# dans la source, on applique cette valeur par defaut.
POLE_DEFAUT = "SGX Réseau"

# --------------------------------------------------------------------------- outils

def clean(v):
    """Normalise une cellule en texte propre (espaces / retours ligne / tabulations)."""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return re.sub(r"\s+", " ", s).strip()


def fmt_phone(v):
    """Renvoie (numero_formate, note). Les numeros stockes en nombre ont perdu leur 0 initial."""
    s = clean(v)
    if not s:
        return "", ""
    digits = re.sub(r"\D", "", s)
    if len(digits) == 9 and not digits.startswith("0"):
        digits = "0" + digits
    if len(digits) in (11, 12) and digits.startswith("33"):
        digits = "0" + digits[2:]
    if len(digits) == 10 and digits.startswith("0"):
        num = " ".join(digits[i:i + 2] for i in range(0, 10, 2))
        reste = re.sub(r"[\d\s./-]+", " ", s).strip(" ,;()")
        return num, reste
    return "", s          # pas un numero exploitable : on conserve le texte tel quel


def norm_key(name):
    s = unicodedata.normalize("NFKD", clean(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^A-Za-z0-9]+", " ", s).upper().strip()


# Le champ "N° COMPTE FRN AUDIKA" melange la reference et la raison sociale, avec des
# separateurs variables : "FSAB0095, ABH", "FSCL0047,CLIMTEC", "FSNI0015 NISSE FRERES",
# "F/FSDC0004, DC PAYSAGE", "V000112, ASSAINISSEMENTS RATAUD".
RE_CODE = re.compile(r"(?:[A-Z]/)?[A-Z]+\d{4,}")


def split_compte(valeur):
    """Separe la reference fournisseur (code), la raison sociale (code 2) et un prefixe eventuel."""
    s = clean(valeur)
    if not s:
        return "", "", ""
    m = RE_CODE.search(s)
    if not m:
        return "", s, ""
    code = m.group(0)
    prefixe = ""
    if "/" in code:                       # "F/FSDC0004" -> code uniforme + prefixe en note
        prefixe, code = code.split("/", 1)
    reste = (s[:m.start()] + " " + s[m.end():]).strip(" ,;/-")
    return code, re.sub(r"\s+", " ", reste).strip(" ,;/-"), prefixe


# Libelles generiques (services, agences, standards) : ils alimentent la colonne
# "Coordonnees telephoniques" du fournisseur et non une personne physique.
GENERIC_STARTS = (
    "standard", "sav", "service", "agence", "plateforme", "pole", "info",
    "demande", "comptabilite", "generique", "maintenance", "planning",
    "gestion", "contact", "depannage", "boite", "courriel", "departement",
    "generaliste", "assistante d", "travaux", "siege", "vpi", "adv",
    "accueil", "secretariat",
)
MANUAL_GENERIC = {"saint denis"}     # agence designee par sa seule ville


def is_generic(label):
    key = norm_key(label).lower()
    if not key or key in MANUAL_GENERIC:
        return True
    return any(key.startswith(g) for g in GENERIC_STARTS)


# --------------------------------------------------------------------------- lecture
suppliers = OrderedDict()


def add_domain(s, dom):
    """Ajoute un domaine sans doublon ni libelle inclus dans un autre."""
    dom = clean(dom)
    if not dom:
        return
    k = norm_key(dom)
    for i, existant in enumerate(s["domaines"]):
        ke = norm_key(existant)
        if k == ke or k in ke:
            return
        if ke in k:                      # le nouveau libelle est plus complet
            s["domaines"][i] = dom
            return
    s["domaines"].append(dom)


def get_supplier(nom, domaine="", compte="", region="", centre=""):
    key = norm_key(nom)
    s = suppliers.get(key)
    if s is None:
        s = {"nom": clean(nom), "domaines": [], "comptes": [], "regions": [],
             "centres": [], "notes": [], "occurrences": [], "lignes": [],
             "tel_general": []}   # (priorite, ordre, numero)
        suppliers[key] = s
    add_domain(s, domaine)
    for champ, val in (("comptes", compte), ("regions", region), ("centres", centre)):
        val = clean(val)
        if val and val not in s[champ]:
            s[champ].append(val)
    return s


def add_contact(s, contact, fonction, tel, portable, courriel, commentaire,
                region, centre, header_row):
    nums, notes = [], []
    for raw in (tel, portable):
        num, note = fmt_phone(raw)
        if num and num not in nums:
            nums.append(num)
        if note and note not in notes:
            notes.append(note)

    contact, fonction = clean(contact), clean(fonction)
    libelle = contact or fonction
    generique = is_generic(libelle)
    if not libelle and nums:
        libelle = "Standard" if header_row else "N° sans libellé (à vérifier)"
        generique = True

    if generique and nums:
        # priorite aux lignes d'accueil pour designer le numero principal du fournisseur
        prioritaire = norm_key(libelle).lower().startswith(
            ("standard", "accueil", "info", "plateforme", "siege"))
        s["tel_general"].append((0 if prioritaire else 1, len(s["tel_general"]), nums[0]))

    s["lignes"].append({
        "contact": libelle,
        "fonction": fonction if fonction != libelle else "",
        "numero": " / ".join(nums),
        "courriel": clean(courriel),
        "commentaire": clean(commentaire),
        "notes": notes,
        "region": clean(region),
        "centre": clean(centre),
        "orpheline": (not contact and not fonction and bool(nums) and not header_row),
    })


wb = openpyxl.load_workbook(SRC_FRN, data_only=True)

# --- onglet "annuaire FRN contrats" ------------------------------------------------
courant = None
for row in wb["annuaire FRN contrats"].iter_rows(min_row=2, values_only=True):
    ent, compte, region, centre, domaine, contact, fonction, tel, port, mail, comm = \
        (list(row) + [None] * 11)[:11]
    if not any(clean(c) for c in row):
        continue

    entete = bool(clean(ent) and any(clean(x) for x in (compte, region, centre, domaine)))
    if entete:
        courant = get_supplier(ent, domaine, compte, region, centre)
        courant["occurrences"].append(("annuaire FRN contrats", clean(domaine) or "(domaine vide)"))
    elif clean(ent) and courant is not None:
        courant["notes"].append(clean(ent))   # suite du nom ou compte client
    if courant is None:
        continue

    add_domain(courant, domaine)
    for champ, val in (("regions", region), ("centres", centre)):
        val = clean(val)
        if val and val not in courant[champ]:
            courant[champ].append(val)

    if any(clean(x) for x in (contact, fonction, tel, port, mail, comm)):
        add_contact(courant, contact, fonction, tel, port, mail, comm,
                    region, centre, entete)

# --- onglet "annuaire FRN espaces verts" -------------------------------------------
courant = None
for row in wb["annuaire FRN espaces verts"].iter_rows(min_row=2, values_only=True):
    ent, compte, centre, contact, fonction, tel, port, mail, comm = \
        (list(row) + [None] * 9)[:9]
    if not any(clean(c) for c in row):
        continue
    entete = bool(clean(ent))
    if entete:
        courant = get_supplier(ent, "ESPACES VERTS / PAYSAGISTE", compte, "", centre)
        courant["occurrences"].append(("annuaire FRN espaces verts", "ESPACES VERTS / PAYSAGISTE"))
    if courant is None:
        continue
    if any(clean(x) for x in (contact, fonction, tel, port, mail, comm)):
        add_contact(courant, contact, fonction, tel, port, mail, comm, "", centre, entete)

# ------------------------------------------------- corrections et notes de conso
s = suppliers.get(norm_key("TECH 9 ENERGIE"))
if s and not s["domaines"]:
    add_domain(s, "CLIMATICIEN")
    s["notes"].append("Domaine absent de la source (« Climaticien » saisi en colonne Centre) : "
                      "rétabli lors de la consolidation")

for s in suppliers.values():
    if len(s["occurrences"]) > 1:
        det = " + ".join(f"« {o} » ({d})" for o, d in s["occurrences"])
        s["notes"].append(f"Saisi {len(s['occurrences'])} fois dans les sources ({det}) : "
                          "lignes fusionnées, domaines cumulés")
    if not s["comptes"]:
        s["notes"].append("Aucun n° de compte fournisseur Audika dans la source")
    if not any(l["numero"] for l in s["lignes"]):
        s["notes"].append("Aucun numéro de téléphone dans la source")

s = suppliers.get(norm_key("GRAF SERVICES PLUS"))
if s:
    for ligne in s["lignes"]:
        if ligne["courriel"].endswith("@gestivert.fr"):
            ligne["notes"].append("Contact « @gestivert.fr » sous un fournisseur « @stihle.fr » : "
                                  "raison sociale probablement manquante dans la source, à confirmer")

# --------------------------------------------------------------------------- ecriture
ARIAL = "Arial"
F_TITRE = Font(name=ARIAL, size=14, bold=True, color="1F3864")
F_SOUS = Font(name=ARIAL, size=9, italic=True, color="595959")
F_HEAD = Font(name=ARIAL, size=10, bold=True, color="FFFFFF")
F_CELL = Font(name=ARIAL, size=10)
F_NOM = Font(name=ARIAL, size=10, bold=True)
FILL_HEAD = PatternFill("solid", fgColor="1F3864")
FILL_ALT = PatternFill("solid", fgColor="EEF2F8")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
TOP = Alignment(vertical="top", wrap_text=True, horizontal="left")

COLONNES = [
    ("Pôle", 13), ("Fournisseur", 28), ("Code fournisseur", 16),
    ("Code fournisseur 2", 26), ("Domaine d’activité", 22), ("Région", 13),
    ("Centre(s)", 26), ("Coordonnées téléphoniques", 20), ("Personne à contacter", 28),
    ("Fonction", 32), ("Numéro", 20), ("Courriel", 30), ("Commentaire", 46),
]
LARGEURS = [w for _, w in COLONNES]

out = openpyxl.Workbook()
ws = out.active
ws.title = "Fournisseurs"

ws["A1"] = "Annuaire fournisseurs consolidé"
ws["A1"].font = F_TITRE
ws["A2"] = ("Source : Annuaire_FRN.xlsx (onglets « annuaire FRN contrats » et « annuaire FRN "
            "espaces verts »). Une ligne par contact ; les informations fournisseur sont "
            f"répétées sur chaque ligne du groupe. Pôle non renseigné dans la source → « {POLE_DEFAUT} ».")
ws["A2"].font = F_SOUS
ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(COLONNES))
ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=len(COLONNES))
ws["A2"].alignment = Alignment(vertical="center", wrap_text=True)
ws.row_dimensions[2].height = 26

for c, (titre, _) in enumerate(COLONNES, 1):
    cell = ws.cell(row=3, column=c, value=titre)
    cell.font, cell.fill, cell.border = F_HEAD, FILL_HEAD, BORDER
    cell.alignment = Alignment(vertical="center", horizontal="left", wrap_text=True)
ws.row_dimensions[3].height = 30


def hauteur(valeurs, largeurs, mini=15, maxi=409):
    """Hauteur de ligne approchee pour du texte renvoye a la ligne."""
    lignes = 1
    for v, w in zip(valeurs, largeurs):
        n = sum(max(1, -(-len(m) // max(8, int(w) - 2))) for m in str(v).split("\n"))
        lignes = max(lignes, n)
    return min(maxi, max(mini, lignes * 12.9 + 3))


r = 4
bande = False
for s in sorted(suppliers.values(), key=lambda x: norm_key(x["nom"])):
    code, code2, prefixe = split_compte(s["comptes"][0] if s["comptes"] else "")
    if prefixe:
        s["notes"].append(f"Compte saisi « {prefixe}/{code} » dans la source")
    if len(s["comptes"]) > 1:
        s["notes"].append("Autres comptes dans la source : " + " ; ".join(s["comptes"][1:]))
    domaine = " ; ".join(s["domaines"])
    tel_gen = min(s["tel_general"])[2] if s["tel_general"] else ""
    region_frn = " ; ".join(s["regions"])
    centre_frn = " ; ".join(s["centres"])
    notes_frn = " ; ".join(s["notes"])

    vues, uniques = set(), []
    for l in s["lignes"]:
        cle = (norm_key(l["contact"]), norm_key(l["fonction"]), l["numero"],
               l["courriel"].lower(), l["commentaire"])
        if cle in vues:
            continue
        vues.add(cle)
        uniques.append(l)
    s["lignes"] = uniques

    lignes = s["lignes"] or [{"contact": "", "fonction": "", "numero": "", "courriel": "",
                              "commentaire": "", "notes": [], "region": "", "centre": "",
                              "orpheline": False}]
    for i, l in enumerate(lignes):
        notes = list(l["notes"])
        if l["orpheline"]:
            notes.append("Numéro sans nom ni libellé dans la source : rattachement à confirmer")
        if i == 0 and notes_frn:
            notes.append(notes_frn)
        commentaire = " ; ".join(x for x in [l["commentaire"]] + notes if x)

        valeurs = [
            POLE_DEFAUT, s["nom"], code, code2, domaine,
            l["region"] or region_frn, l["centre"] or centre_frn, tel_gen,
            l["contact"], l["fonction"], l["numero"], l["courriel"], commentaire,
        ]
        for c, v in enumerate(valeurs, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = F_NOM if c == 2 else F_CELL
            cell.alignment = TOP
            cell.border = BORDER
            if bande:
                cell.fill = FILL_ALT
        ws.row_dimensions[r].height = hauteur(valeurs, LARGEURS)
        r += 1
    bande = not bande                      # une bande de couleur par fournisseur

last = r - 1
for c, (_, w) in enumerate(COLONNES, 1):
    ws.column_dimensions[openpyxl.utils.get_column_letter(c)].width = w
ws.freeze_panes = "C4"
ws.auto_filter.ref = f"A3:{openpyxl.utils.get_column_letter(len(COLONNES))}{last}"

out.save(OUT)
print(f"OK -> {OUT}")
print(f"   fournisseurs : {len(suppliers)}")
print(f"   lignes       : {last - 3}")
