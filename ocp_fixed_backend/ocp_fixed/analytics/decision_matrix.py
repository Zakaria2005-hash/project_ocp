"""
================================================================================
  analytics/decision_matrix.py — Matrice de décision "Cause probable → Action"
================================================================================
Objectif : pour un jour classé "à risque élevé" par PannePredictor (qui ne
prédit qu'un score binaire panne_j1, pas la nature ni la cause), déduire une
recommandation concrète et exploitable par les équipes de maintenance :

    risk_panne_j1 (score) --> Nature probable + Cause probable + Action

RÈGLE D'OR — PAS DE FUITE DE DONNÉES (data leakage) :
La période de prévision réelle (Juin, hors-échantillon — cf.
dashboard_api.CUTOFF_PREDICTIF) est traitée comme un mois à venir dont on ne
connaît encore RIEN au moment de la prédiction. La cause probable ne peut
donc jamais s'appuyer sur un arrêt réellement survenu en juin — uniquement
sur la PÉRIODE DE RÉFÉRENCE (2026-01-08 → 2026-05-31, 144 jours), celle-là
même sur laquelle PannePredictor est entraîné.

JOUR ANALOGUE (variation jour par jour, sans fuite) :
Une seule analyse moyenne sur toute la période de référence donnerait EXACTEMENT
la même recommandation pour tous les jours à risque du mois — ce qui a été
signalé comme peu utile (le graphique de répartition ne "changeait" jamais
au clic). Pour que la recommandation varie réellement d'un jour à l'autre
tout en respectant la règle ci-dessus, on cherche plutôt, pour chaque jour
cible J (juin), le(s) jour(s) de la période de référence dont les conditions
opérationnelles mesurées CE jour-là (production, débit, TRS, taux de panne,
maintenance subie, perte de vitesse — les mêmes features que celles utilisées
par PannePredictor pour prédire J+1) ressemblent le plus à celles de J.
Utiliser les features du jour J lui-même n'est PAS une fuite : ce sont
exactement les données que le modèle utilise pour prédire son risque à J+1 —
on ne regarde jamais l'ISSUE (les arrêts) du jour J, seulement son CONTEXTE
opérationnel, déjà connu au moment de la prédiction.

On analyse ensuite TOUS les arrêts survenus sur ce(s) jour(s) analogue(s),
sans se limiter aux pannes majeures (Mécanique/Electrique) : les arrêts
Décidés, Externes, de Maintenance Planifiée et d'Utilisation sont désormais
inclus également — ils représentent l'essentiel du volume réel d'arrêts du
site et donnent une image plus complète et plus variée de ce qui menace
l'atelier, plutôt que de se limiter aux seuls cas de panne stricte (rares).
================================================================================
"""
from __future__ import annotations

from collections import Counter
from datetime import date as _date

import numpy as np
import pandas as pd

FENETRE_REFERENCE_DEBUT = _date(2026, 1, 8)
FENETRE_REFERENCE_FIN = _date(2026, 5, 31)

# Features opérationnelles utilisées pour mesurer la ressemblance entre deux
# journées — mêmes colonnes de base que PannePredictor._build_features (sans
# la cible), cf. ml_pipeline.py.
FEATURES_SIMILARITE = [
    "production_totale_t", "debit_th", "trs_calc",
    "taux_panne", "a_maint_subie_h", "perte_vitesse",
]

# Nombre de jours analogues agrégés pour construire la recommandation d'un
# jour cible (lisse un peu le signal plutôt que de dépendre d'un seul jour).
K_JOURS_ANALOGUES = 5

# -----------------------------------------------------------------------------
# 1) Actions génériques par nature (fallback si aucun signal plus précis)
# -----------------------------------------------------------------------------
ACTIONS_PAR_NATURE = {
    "Exploitation": "Planifier un nettoyage des grilles de séchage en fin de poste",
    "Mécanique": "Inspecter le palier du tambour sécheur (vibrations anormales)",
    "Electrique": "Contrôler les armoires électriques et connexions moteur/variateur",
    "Installation": "Vérifier l'état des canalisations et supports de tuyauterie",
    "Autre": "Alerter l'équipe de maintenance préventive pour inspection générale",
}

# -----------------------------------------------------------------------------
# 2) Matrice de décision fine — mots-clés observés dans `cause_precision`
#    (texte libre saisi par les équipes terrain) associés à une cause probable
#    typée et une action ciblée. Premier mot-clé qui matche l'emporte —
#    l'ordre reflète donc une priorité (ex. "réducteur"/"chaîne" avant le
#    terme générique "arrêt").
#
# À AJUSTER PAR VOUS : ces règles sont un point de départ raisonnable à partir
# des libellés observés dans vos données (cf. `cause_precision` de FactArret).
# Elles gagneraient à être validées/enrichies avec le service maintenance OCP,
# qui connaît la terminologie exacte du site mieux que quiconque.
# -----------------------------------------------------------------------------
REGLES_CAUSE_MOTS_CLES = [
    (["réducteur", "boulons", "galets", "chaîne", "palier", "moteur" , "Travaux mecaniques" , "ligne gicleur" , "accouplement","trappe","pompe d'injection","Graissage","Changement","tapis fleche","mécanique","Rettapage"],
     "Usure mécanique de transmission (réducteur / moteur / accouplement)",
     "Inspecter réducteur, boulons et galets — resserrage et graissage préventifs"),
    (["tension", "électrique", "electrique", "asservissement","courant","régulatrice","variateur","dosimètre","moteur de refroidissement","Electrique","translation","demarrage","discordance","orientation"],
     "Défaut électrique ou d'asservissement",
     "Contrôler armoires électriques, tension d'alimentation et boucles d'asservissement"),
    (["huile", "température", "temperature", "chauffe"],
     "Échauffement anormal / lubrification",
     "Vérifier niveau et température d'huile, contrôler le système de refroidissement"),
    (["pression d'air", "pression d'aire", "kaes", "air comprimé", "air comprime"],
     "Perte de pression du réseau d'air comprimé",
     "Contrôler compresseurs et détecter les fuites du réseau d'air comprimé"),
    (["transfert", "bouchage", "débouchage", "debouchage"],
     "Bouchage / difficulté de transfert de matière",
     "Inspecter et déboucher les points de transfert, vérifier le débit amont"),
    (["stock plein", "cubature", "expédition","pression","Réduction","stock","Rupture","urgence","Débit insuffisant","Arrêt","Patinage","Changement qualité","Travaux sur remise en états","Travaux  Entretien","Arrêt  planifiée","Entretien  des FAM","crible"],
     "Saturation logistique (stock aval / expédition)",
     "Coordonner avec la logistique pour fluidifier l'évacuation du stock"),
    (["humidité"],
     "Perturbation process liée à l'humidité de la matière",
     "Ajuster les paramètres de séchage selon l'humidité amont mesurée"),
    (["vibration", "roulement"],
     "Vibrations anormales / usure de roulement",
     "Programmer une inspection vibratoire du sous-ensemble concerné"),
    (["décidé", "decide", "arrêt décidé", "planning"],
     "Arrêt décidé par l'exploitation (hors incident)",
     "Confirmer le planning d'arrêt avec l'exploitation et anticiper les ressources"),
    (["externe", "sous-traitant", "fournisseur", "livraison"],
     "Cause externe au site (fournisseur / sous-traitant / livraison)",
     "Coordonner avec le tiers concerné pour sécuriser les délais"),
    (["planifi", "révision", "revision", "entretien"],
     "Maintenance planifiée arrivant à échéance",
     "Confirmer la disponibilité des équipes et pièces pour la maintenance planifiée"),
]


def _libelle_cause_et_action(cause_texte: str, nature: str) -> tuple[str, str]:
    """Associe un texte de cause libre à un couple (cause probable typée,
    action recommandée), via une recherche de mots-clés insensible à la casse.
    Retombe sur l'action générique de la nature si aucun mot-clé ne matche.
    """
    texte = (cause_texte or "").lower()
    for mots_cles, libelle_cause, action in REGLES_CAUSE_MOTS_CLES:
        if any(mot in texte for mot in mots_cles):
            return libelle_cause, action
    return (
        f"Cause non typée précisément (nature : {nature})",
        ACTIONS_PAR_NATURE.get(nature, ACTIONS_PAR_NATURE["Autre"]),
    )


def _resultat_vide(date_debut, date_fin) -> dict:
    return {
        "nature_probable": None,
        "equipement_probable": None,
        "cause_probable": "Historique de référence insuffisant pour typer la cause",
        "action_recommandee": "Maintenir une vigilance générale — pas assez de signal sur la période",
        "repartition_natures": [],
        "nb_evenements_analyses": 0,
        "fenetre_debut": str(date_debut),
        "fenetre_fin": str(date_fin),
        "jours_analogues": [],
    }


def _features_journalieres(fact_qs) -> pd.DataFrame:
    """DataFrame indexé par date (pd.Timestamp) avec les features
    opérationnelles brutes utilisées pour mesurer la similarité entre deux
    journées — mêmes colonnes que PannePredictor._build_features (sans la
    cible), cf. ml_pipeline.py, pour rester cohérent avec ce que le modèle
    utilise réellement.
    """
    records = list(fact_qs.values("date", *FEATURES_SIMILARITE))
    df = pd.DataFrame(records)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    for col in FEATURES_SIMILARITE:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df[col] = df[col].fillna(df[col].median())
    return df.set_index("date")


def _analyser_arrets(records: list[dict]) -> tuple[str | None, str | None, str, str]:
    """Déduit (nature_probable, equipement_probable, cause_probable, action)
    à partir d'une liste brute d'arrêts (dicts avec nature/equipement/
    cause_precision) — tous types d'arrêt confondus (Panne, Utilisation,
    Externe, M.Planifiée, Décidé...), pas seulement les pannes majeures.
    """
    if not records:
        return None, None, "Historique insuffisant", "Maintenir une vigilance générale"

    repartition = Counter(r["nature"] for r in records)
    nature_probable = repartition.most_common(1)[0][0]

    equipements = Counter(r["equipement"] for r in records if r["nature"] == nature_probable)
    equipement_probable = equipements.most_common(1)[0][0] if equipements else None

    causes_pertinentes = [
        r["cause_precision"] for r in records
        if r["nature"] == nature_probable
        and (equipement_probable is None or r["equipement"] == equipement_probable)
    ]
    cause_texte = Counter(causes_pertinentes).most_common(1)[0][0] if causes_pertinentes else ""
    cause_probable, action = _libelle_cause_et_action(cause_texte, nature_probable)

    return nature_probable, equipement_probable, cause_probable, action


def analyser_cause_jour_analogue(
    fact_qs,
    arret_qs,
    jour_cible: _date,
    date_debut: _date = FENETRE_REFERENCE_DEBUT,
    date_fin: _date = FENETRE_REFERENCE_FIN,
    k: int = K_JOURS_ANALOGUES,
) -> dict:
    """Pour le jour cible `jour_cible` (un jour à risque de la période de
    prévision), trouve les `k` jours de la période de référence [date_debut,
    date_fin] dont les conditions opérationnelles ressemblent le plus aux
    siennes (distance euclidienne sur les features standardisées — voir note
    en tête de module), puis analyse TOUS les arrêts (tous types confondus)
    survenus sur ces jours analogues pour en déduire la cause probable.

    La recommandation varie donc réellement d'un jour à l'autre de la
    période de prévision (contrairement à une moyenne fixe sur toute la
    période de référence), tout en ne s'appuyant jamais sur un arrêt
    survenu pendant la période de prévision elle-même.
    """
    df_features = _features_journalieres(fact_qs)
    if df_features.empty:
        return _resultat_vide(date_debut, date_fin)

    jour_cible_ts = pd.Timestamp(jour_cible)
    if jour_cible_ts not in df_features.index:
        return _resultat_vide(date_debut, date_fin)

    df_ref = df_features.loc[
        (df_features.index >= pd.Timestamp(date_debut)) & (df_features.index <= pd.Timestamp(date_fin))
    ]
    if df_ref.empty:
        return _resultat_vide(date_debut, date_fin)

    # Standardisation sur la seule période de référence (jamais sur juin).
    moyennes = df_ref.mean()
    ecarts = df_ref.std(ddof=0).replace(0, 1.0)
    df_ref_std = (df_ref - moyennes) / ecarts
    vecteur_cible_std = (df_features.loc[jour_cible_ts] - moyennes) / ecarts

    distances = np.sqrt(((df_ref_std - vecteur_cible_std) ** 2).sum(axis=1))
    jours_proches = distances.nsmallest(min(k, len(distances))).index

    records = list(
        arret_qs.filter(
            date_evenement__date__in=[d.date() for d in jours_proches]
        ).values("nature", "equipement", "type_arret", "cause_precision")
    )

    repartition = Counter(r["nature"] for r in records)
    repartition_natures = [
        {"name": nature, "value": count} for nature, count in repartition.most_common()
    ]

    nature_probable, equipement_probable, cause_probable, action = _analyser_arrets(records)

    if not records:
        resultat = _resultat_vide(date_debut, date_fin)
        resultat["jours_analogues"] = [str(d.date()) for d in jours_proches]
        return resultat

    return {
        "nature_probable": nature_probable,
        "equipement_probable": equipement_probable,
        "cause_probable": cause_probable,
        "action_recommandee": action,
        "repartition_natures": repartition_natures,
        "nb_evenements_analyses": len(records),
        "fenetre_debut": str(date_debut),
        "fenetre_fin": str(date_fin),
        "jours_analogues": [str(d.date()) for d in jours_proches],
    }


def analyser_cause_periode_reference(
    arret_qs,
    date_debut: _date = FENETRE_REFERENCE_DEBUT,
    date_fin: _date = FENETRE_REFERENCE_FIN,
) -> dict:
    """Repli (fallback) utilisé quand la recherche de jour analogue est
    impossible (ex. features manquantes pour le jour cible) : analyse
    l'ensemble de la période de référence en une seule fois, TOUS types
    d'arrêt confondus (Panne, Utilisation, Externe, M.Planifiée, Décidé),
    et non plus seulement les pannes majeures Mécanique/Electrique.
    """
    records = list(
        arret_qs.filter(
            date_evenement__date__gte=date_debut,
            date_evenement__date__lte=date_fin,
        ).values("nature", "equipement", "type_arret", "cause_precision")
    )

    repartition = Counter(r["nature"] for r in records)
    repartition_natures = [
        {"name": nature, "value": count} for nature, count in repartition.most_common()
    ]

    if not records:
        return _resultat_vide(date_debut, date_fin)

    nature_probable, equipement_probable, cause_probable, action = _analyser_arrets(records)

    return {
        "nature_probable": nature_probable,
        "equipement_probable": equipement_probable,
        "cause_probable": cause_probable,
        "action_recommandee": action,
        "repartition_natures": repartition_natures,
        "nb_evenements_analyses": len(records),
        "fenetre_debut": str(date_debut),
        "fenetre_fin": str(date_fin),
        "jours_analogues": [],
    }