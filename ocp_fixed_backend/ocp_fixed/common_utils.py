"""
================================================================================
  common_utils.py — Utilitaires partagés du projet OCP Drying
================================================================================
Ce module centralise la logique auparavant dupliquée (et parfois buguée) dans
ingest_ocp_data.py / process_data.py / run_ml.py :

    * conversion sûre des types (safe_float, safe_str, parse_percent_or_float)
    * recherche de fichiers Excel tolérante aux variations de nommage
      (espaces vs underscores, accents, casse) — CORRIGE le bug où le code
      cherchait "Historique KPI journalier.xlsx" alors que le fichier réel
      s'appelle "Historique_KPI_journalier.xlsx" (jamais trouvé, ingestion
      silencieusement vide).
    * mapping des mois français
    * normalisation NATURE / TYPE des arrêts (complète les valeurs manquantes
      "Panne" et "Décidé" qui tombaient à tort dans "Autre")

Centraliser cette logique dans un seul fichier évite qu'un bug corrigé dans un
script ne persiste dans les deux autres.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Optional

import openpyxl
import pandas as pd

# ==============================================================================
# Normalisation générique de texte (accents, casse, espaces)
# ==============================================================================
def normaliser_texte(valeur) -> str:
    """Minuscule, sans accents, ponctuation -> espace, espaces superflus supprimés."""
    if valeur is None or (isinstance(valeur, float) and pd.isna(valeur)):
        return ""
    texte = str(valeur).strip().lower()
    texte = unicodedata.normalize("NFKD", texte).encode("ascii", "ignore").decode()
    texte = re.sub(r"[^a-z0-9]+", " ", texte)
    return " ".join(texte.split())


# ==============================================================================
# Conversions sûres
# ==============================================================================
def safe_float(value) -> Optional[float]:
    """Convertit en float ; gère aussi les pourcentages textuels ("100%" -> 1.0).

    NB : si `value` est une pandas.Series (bug historique de colonnes
    dupliquées), on lève explicitement une erreur claire plutôt que de planter
    avec un message pandas cryptique ("truth value of a Series is ambiguous").
    """
    if isinstance(value, pd.Series):
        raise TypeError(
            "safe_float() a reçu une Series au lieu d'un scalaire : "
            "vérifiez qu'il n'y a pas de colonnes dupliquées dans le DataFrame "
            f"(valeurs reçues : {value.tolist()})."
        )
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, str):
        value = value.strip()
        if value.endswith("%"):
            try:
                return float(value[:-1].replace(",", ".")) / 100.0
            except ValueError:
                return None
        value = value.replace(",", ".")
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def safe_str(value) -> Optional[str]:
    if isinstance(value, pd.Series):
        raise TypeError(
            "safe_str() a reçu une Series au lieu d'un scalaire : colonnes "
            f"dupliquées probables (valeurs reçues : {value.tolist()})."
        )
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def clean_col_name(name) -> str:
    """Normalise un nom de colonne Excel — VERSION CORRIGÉE.

    Le contenu entre parenthèses (ex. l'unité "(h)", "(T/H)") est conservé
    (accolé, sans parenthèses) plutôt que supprimé : l'ancienne version
    supprimait ce contenu, ce qui faisait collisionner "DUREE" et "Duree(h)"
    en une seule colonne "duree" — bug qui provoquait un plantage
    ("truth value of a Series is ambiguous") lors de l'accès à cette colonne.
    """
    if name is None or (isinstance(name, float) and pd.isna(name)):
        return "unnamed"
    texte = str(name).lower()
    texte = unicodedata.normalize("NFKD", texte).encode("ascii", "ignore").decode()
    texte = texte.replace("(", "_").replace(")", "_")
    texte = re.sub(r"[^a-z0-9]+", "_", texte)
    return texte.strip("_")


def dedupliquer_colonnes(df: pd.DataFrame) -> pd.DataFrame:
    """Renomme les colonnes dupliquées (col, col_2, col_3...) au lieu de les
    laisser silencieusement en collision — filet de sécurité supplémentaire.
    """
    compteurs: dict[str, int] = {}
    nouvelles_colonnes = []
    for col in df.columns:
        if col not in compteurs:
            compteurs[col] = 0
            nouvelles_colonnes.append(col)
        else:
            compteurs[col] += 1
            nouvelles_colonnes.append(f"{col}_{compteurs[col] + 1}")
    df = df.copy()
    df.columns = nouvelles_colonnes
    return df


# ==============================================================================
# Recherche de fichiers — tolérante aux variantes de nommage ET aux
# corruptions d'encodage (ex. transfert via un pipeline non-UTF-8).
# ==============================================================================
# Durcissement défensif : les segments "journaliere"/"arrets" sont remplacés
# par des jokers .*? — ce ne sont pas les mots qui comptent pour identifier
# le fichier (seuls "performance"/"synthese" en tête et le mois en fin de
# nom le sont), donc autant ne pas dépendre de leur orthographe exacte si
# jamais un encodage corrompu insère des caractères imprévus au milieu.
PATTERN_HISTORIQUE_KPI = re.compile(
    r"(?i)^historique[ _]kpi[ _]journalier\.xlsx$"
)
PATTERN_PERFORMANCE_MOIS = re.compile(
    r"(?i)^performance.*?mois[ _]+([a-z ]+?)\.xlsx$"
)
PATTERN_SYNTHESE_ARRETS = re.compile(
    r"(?i)^.*des[ _]arrets?[ _]journaliers?[ _]+([a-z ]+?)\.xlsx$"
)
PATTERN_PANNES = re.compile(
    r"(?i)^les[ _]pannes[ _]de[ _]chaque[ _]mois\.xlsx$"
)


def _nom_normalise_pour_matching(nom_fichier: str) -> str:
    """Supprime les accents du NOM DE FICHIER (pas du contenu) avant de tester
    les motifs regex ci-dessus, pour ne pas avoir à énumérer chaque variante
    accentuée (é/è/ê) dans chaque expression régulière.

    Filet de sécurité supplémentaire : les caractères qui ne survivent pas à
    la normalisation NFKD (ex. un octet mal décodé lors d'un transfert non-
    UTF-8) sont remplacés par un espace plutôt que silencieusement supprimés
    — un mot corrompu devient ainsi "coupé proprement" (ex. "journali??re"
    -> "journali re") au lieu de fusionner deux mots en un charabia
    ("journalire") qui ne matcherait plus aucun motif.
    """
    sans_accents = unicodedata.normalize("NFKD", nom_fichier).encode("ascii", "ignore").decode()
    # Remplace toute ponctuation/symbole résiduel (mojibake typique : +, ¿,
    # ®, ¬, etc.) par un espace, en conservant lettres/chiffres/points/
    # underscores nécessaires au matching.
    sans_accents = re.sub(r"[^\w. ]", " ", sans_accents)
    return sans_accents

MONTHS_FR = {
    "janvier": 1, "fevrier": 2, "février": 2, "fvrier": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "aout": 8, "août": 8, "aot": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12, "décembre": 12,
}


def trouver_fichier(directory: Path, pattern: re.Pattern) -> Optional[Path]:
    """Retourne le premier fichier du dossier correspondant au motif, ou None."""
    for f in sorted(Path(directory).iterdir()):
        if f.is_file() and pattern.match(_nom_normalise_pour_matching(f.name)):
            return f
    return None


def trouver_fichiers_mensuels(directory: Path, pattern: re.Pattern) -> dict[str, Path]:
    """Retourne {nom_mois_normalisé: chemin} pour tous les fichiers matchant
    un motif à capture de mois (Performance_Journalière_*, Synthèse_*).
    """
    resultats = {}
    for f in sorted(Path(directory).iterdir()):
        if not f.is_file():
            continue
        m = pattern.match(_nom_normalise_pour_matching(f.name))
        if m:
            # Le mois capturé peut contenir un espace résiduel si un
            # caractère corrompu a été remplacé en cours de route (ex.
            # "f vrier" au lieu de "fevrier") — on le retire avant de
            # normaliser, pour que la clé retrouve son mois d'origine.
            mois_brut = m.group(1).replace(" ", "")
            mois = normaliser_texte(mois_brut)
            resultats[mois] = f
    return resultats


def mois_vers_numero(nom_mois: str) -> Optional[int]:
    """Convertit un nom de mois en numéro (1-12), avec repli par
    correspondance approximative (difflib) si le dictionnaire MONTHS_FR n'a
    pas d'entrée exacte — filet de sécurité pour un mois dont l'orthographe
    aurait été légèrement altérée par un problème d'encodage (ex. "fvrier"
    au lieu de "fevrier" si un caractère a été perdu plutôt que remplacé).
    """
    cle = normaliser_texte(nom_mois).replace(" ", "")
    if cle in MONTHS_FR:
        return MONTHS_FR[cle]

    import difflib

    correspondances = difflib.get_close_matches(cle, MONTHS_FR.keys(), n=1, cutoff=0.7)
    if correspondances:
        return MONTHS_FR[correspondances[0]]
    return None


def parser_colonne_date_mixte(serie: pd.Series, annee_defaut: Optional[int] = None) -> pd.Series:
    """Reconstruit une colonne de dates à partir d'un mélange d'objets
    datetime/Timestamp ET de chaînes abrégées françaises SANS année (ex.
    "1-janv.", "28-févr.") — défaut de formatage Excel réellement observé
    dans une mise à jour d'Historique_KPI_journalier.xlsx : Janvier/Février
    et Avril étaient exportés en texte, Mars/Mai/Juin en vraies dates,
    au sein de la MÊME colonne.

    Stratégie :
    1. Année de référence déduite des valeurs datetime déjà présentes dans
       la série (le mode, i.e. l'année la plus fréquente), sauf si
       `annee_defaut` est fourni explicitement.
    2. Chaque valeur datetime/Timestamp est utilisée telle quelle ; chaque
       chaîne "JJ-mmm." est reconstruite via jour + mois (table
       d'abréviations FR, tolérante aux variantes) + année de référence.
    3. Vérifie que le résultat est strictement croissant sans trou (le
       fichier source couvre une période continue) ; signale un
       avertissement sans planter si ce n'est pas le cas — mieux vaut des
       dates imparfaites signalées que perdre toute l'ingestion.
    """
    valeurs_datetime = [v for v in serie if hasattr(v, "year") and not isinstance(v, str)]
    if annee_defaut is None:
        if valeurs_datetime:
            annees = pd.Series([v.year for v in valeurs_datetime])
            annee_defaut = int(annees.mode().iloc[0])
        else:
            from datetime import date as _date
            annee_defaut = _date.today().year
            logger_msg = (
                f"ATTENTION : aucune date complète (avec année) trouvée dans la "
                f"colonne pour en déduire l'année de référence — repli sur "
                f"l'année civile en cours ({annee_defaut})."
            )
            print(f"  {logger_msg}")

    def _parser_une_valeur(v):
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return pd.NaT
        if hasattr(v, "year") and not isinstance(v, str):
            return pd.Timestamp(v.year, v.month, v.day)
        if isinstance(v, str):
            texte = v.strip().rstrip(".")
            if "-" not in texte:
                return pd.to_datetime(v, errors="coerce")
            jour_str, mois_str = texte.split("-", 1)
            mois_num = mois_vers_numero(mois_str)
            try:
                jour_num = int(jour_str.strip())
            except ValueError:
                return pd.NaT
            if mois_num is None:
                return pd.NaT
            try:
                return pd.Timestamp(annee_defaut, mois_num, jour_num)
            except ValueError:
                return pd.NaT
        return pd.to_datetime(v, errors="coerce")

    resultat = serie.apply(_parser_une_valeur)

    # Vérification de cohérence : séquence continue attendue (le fichier
    # source représente un historique journalier sans trou). Un
    # avertissement suffit — ne bloque pas l'ingestion, car une vraie
    # rupture d'historique (nouveau mois ajouté avec un trou, par exemple)
    # est possible et légitime.
    resultat_valide = resultat.dropna().sort_values()
    ecarts = resultat_valide.diff().dropna()
    jours_anormaux = ecarts[ecarts != pd.Timedelta(days=1)]
    if not jours_anormaux.empty:
        print(f"  ATTENTION : {len(jours_anormaux)} rupture(s) de continuité "
              f"détectée(s) dans la séquence de dates reconstruite — "
              f"vérifiez le fichier source si ce n'est pas attendu.")

    return resultat


# ==============================================================================
# Normalisation NATURE / TYPE des arrêts — CORRIGÉE (valeurs manquantes ajoutées)
# ==============================================================================
NATURE_MAPPING = {
    "mecanique": "Mécanique",
    "electrique": "Electrique",
    "exploitation": "Exploitation",
    "installation": "Installation",
    "autre": "Autre",
}


def normaliser_nature(raw) -> str:
    return NATURE_MAPPING.get(normaliser_texte(raw), "Autre")


# CORRECTION : l'ancien mapping ne couvrait ni "Panne" ni "Décidé", qui
# tombaient donc systématiquement (et à tort) dans "Autre".
TYPE_MAPPING = {
    "m planifiee": "M.Planifiée",
    "m subie": "M.Subie",
    "utilisation": "Utilisation",
    "externe": "Externe",
    "panne": "Panne",
    "decide": "Décidé",
    "decides": "Décidé",
}


def normaliser_type(raw) -> str:
    raw_norm = normaliser_texte(raw)
    if not raw_norm:
        return "Autre"
    for cle, val in TYPE_MAPPING.items():
        if cle in raw_norm:
            return val
    return "Autre"


# ==============================================================================
# Extraction par libellé — robuste aux décalages de ligne entre mois
# ==============================================================================
def extraire_valeurs_par_libelle(filepath: Path, libelle_cible_normalise: str) -> dict:
    """Cherche, dans un fichier Performance_Journalière_du_mois_*.xlsx, la ligne
    dont le libellé (colonne B) correspond à `libelle_cible_normalise`, et
    retourne {date: valeur} pour toutes les colonnes-jours.

    Recherche PAR LIBELLÉ plutôt que par numéro de ligne fixe : vérifié que
    la ligne "Consommation d'énergie (kcal/T)" se trouve en ligne 56 pour
    janvier/février/mars mais en ligne 58-59 pour avril/mai/juin — un index
    de ligne codé en dur aurait donc silencieusement extrait la mauvaise
    valeur pour la moitié des mois.
    """
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))

    entete_dates = rows[1]
    colonnes_dates = [
        (i, v.date()) for i, v in enumerate(entete_dates) if isinstance(v, datetime)
    ]

    for row in rows[2:]:
        libelle = row[1] if len(row) > 1 else None
        if libelle is None:
            continue
        if normaliser_texte(libelle) == libelle_cible_normalise:
            return {
                date_val: (row[i] if i < len(row) else None)
                for i, date_val in colonnes_dates
            }
    return {}
