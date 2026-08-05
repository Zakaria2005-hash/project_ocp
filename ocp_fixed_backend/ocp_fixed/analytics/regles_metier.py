"""
================================================================================
  analytics/regles_metier.py — Monitoring par Règles Métier (Rule-Based)
================================================================================
Remplace, pour le panneau "Alertes Actives" du tableau de bord, la détection
d'anomalie purement statistique (Isolation Forest — multivariée, boîte noire)
par des SEUILS MÉTIER EXPLICITES, un par KPI industriel connu du site :

    Débit horaire, Tonnage (production), OEE, Taux de panne, TRG,
    Humidité de sortie MC, HM (heures de marche), Conso. énergétique globale,
    et Conso. spécifique par combustible (Gaz, Gazoline, Fuel).

Chaque seuil franchi génère SON PROPRE libellé de suspicion ciblé et son
propre niveau de sévérité (orange = attention, rouge = critique).
================================================================================
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

# Baseline globale d'énergie thermique (160 000 kcal/T)
BASELINE_CONSO_ENERGIE_KCAL_T = 160_000.0


@dataclass
class SeuilMetier:
    champ: str            # Nom du champ FactJournalier concerné (ex: "trs_calc")
    label: str            # Libellé humain du KPI (ex: "OEE")
    sens: str             # "bas" : alerte si valeur < seuil ; "haut" : alerte si valeur > seuil
    borne_orange: float
    borne_rouge: float
    unite: str
    conseil: str          # Action/suspicion à afficher dans la description


# -----------------------------------------------------------------------------
# Seuils fixes par KPI métier
# -----------------------------------------------------------------------------
SEUILS_FIXES: List[SeuilMetier] = [
    SeuilMetier(
        champ="debit_th",
        label="Débit horaire",
        sens="bas",
        borne_orange=250.0,
        borne_rouge=150.0,
        unite="T/h",
        conseil="vérifier l'alimentation amont et l'état des fours",
    ),
    SeuilMetier(
        champ="production_totale_t",
        label="Tonnage (production journalière)",
        sens="bas",
        borne_orange=4000.0,
        borne_rouge=2000.0,
        unite="T",
        conseil="vérifier s'il s'agit d'un arrêt planifié ou d'une sous-performance à traiter",
    ),
    SeuilMetier(
        champ="trs_calc",
        label="OEE",
        sens="bas",
        borne_orange=0.60,
        borne_rouge=0.45,
        unite="%",
        conseil="analyser la répartition des pertes (arrêts, cadence, qualité) du jour",
    ),
    SeuilMetier(
        champ="taux_panne",
        label="Taux de panne",
        sens="haut",
        borne_orange=0.05,
        borne_rouge=0.10,
        unite="%",
        conseil="anticiper une intervention de maintenance corrective",
    ),
    SeuilMetier(
        champ="trg",
        label="TRG",
        sens="bas",
        borne_orange=0.65,
        borne_rouge=0.50,
        unite="%",
        conseil="vérifier les arrêts planifiés et les baisses de charge externes du jour",
    ),
    SeuilMetier(
        champ="humidite_sortie_mc_pct",
        label="Humidité sortie MC",
        sens="haut",
        borne_orange=0.04,
        borne_rouge=0.05,
        unite="%",
        conseil="risque de sous-séchage — ajuster la température ou le temps de séjour",
    ),
    SeuilMetier(
        champ="humidite_sortie_mp_pct",
        label="Humidité sortie MP",
        sens="haut",
        borne_orange=0.06,
        borne_rouge=0.07,
        unite="%",
        conseil="risque de sous-séchage — ajuster la température ou le temps de séjour",
    ),
    SeuilMetier(
        champ="hm",
        label="Heures de marche (HM)",
        sens="bas",
        borne_orange=20.0,
        borne_rouge=16.0,
        unite="h/24h",
        conseil="vérifier la disponibilité des fours et la cause des arrêts du jour",
    ),
    SeuilMetier(
        champ="conso_energie_kcalt",
        label="Consommation énergétique",
        sens="haut",
        borne_orange=BASELINE_CONSO_ENERGIE_KCAL_T * 1.05,
        borne_rouge=BASELINE_CONSO_ENERGIE_KCAL_T * 1.15,
        unite="kcal/T",
        conseil="suspicion d'encrassement interne du tube sécheur ou de fuite thermique",
    ),
]

# Champs de consommation par combustible — seuils calculés par SPC
CHAMPS_COMBUSTIBLES = [
    ("cs_gaz_nm3t", "Consommation spécifique Gaz", "Nm3/T"),
    ("cs_gazoline_kgt", "Consommation spécifique Gazoline", "kg/T"),
    ("cs_fuel_kgt", "Consommation spécifique Fuel", "kg/T"),
]


def generer_seuils_combustibles(fact_qs) -> List[SeuilMetier]:
    """Calcule des seuils par Contrôle Statistique de Procédé (SPC) — moyenne
    + 2 σ (orange) / + 3 σ (rouge) — pour les consommations de combustible.
    """
    import numpy as np

    seuils: List[SeuilMetier] = []
    valeurs_par_champ = {champ: [] for champ, _, _ in CHAMPS_COMBUSTIBLES}

    for row in fact_qs.values(*[c for c, _, _ in CHAMPS_COMBUSTIBLES]):
        for champ in valeurs_par_champ:
            v = row.get(champ)
            if v is not None:
                valeurs_par_champ[champ].append(v)

    for champ, label, unite in CHAMPS_COMBUSTIBLES:
        valeurs = valeurs_par_champ[champ]
        if len(valeurs) < 10:
            continue  # Historique insuffisant pour un calcul statistique fiable

        moyenne = float(np.mean(valeurs))
        ecart_type = float(np.std(valeurs))

        if ecart_type == 0:
            continue

        seuils.append(
            SeuilMetier(
                champ=champ,
                label=label,
                sens="haut",
                borne_orange=moyenne + 2 * ecart_type,
                borne_rouge=moyenne + 3 * ecart_type,
                unite=unite,
                conseil=(
                    f"surconsommation vs moyenne du site ({moyenne:.1f} {unite}) — "
                    f"vérifier les brûleurs et le réglage de combustion"
                ),
            )
        )
    return seuils


def _formatter_valeur(valeur: float, seuil: SeuilMetier) -> str:
    """Formatage propre des valeurs pour les descriptions d'alertes."""
    if seuil.unite == "%":
        # Multiplie par 100 uniquement si la valeur est un ratio entre 0 et 1
        val = valeur * 100 if valeur <= 1.0 else valeur
        return f"{val:.1f}%"
    return f"{valeur:.1f} {seuil.unite}"


def evaluer_jour(row: Dict[str, Any], seuils: List[SeuilMetier]) -> List[Dict[str, Any]]:
    """Évalue tous les seuils pour une journée donnée et retourne les alertes déclenchées.

    Garantit que le type est systématiquement préfixé par 'seuil_' pour concorder
    avec les regles_definitions du frontend React.
    """
    alertes = []
    for seuil in seuils:
        valeur = row.get(seuil.champ)
        if valeur is None:
            continue

        if seuil.sens == "bas":
            if valeur < seuil.borne_rouge:
                niveau = "rouge"
            elif valeur < seuil.borne_orange:
                niveau = "orange"
            else:
                continue
        else:  # "haut"
            if valeur > seuil.borne_rouge:
                niveau = "rouge"
            elif valeur > seuil.borne_orange:
                niveau = "orange"
            else:
                continue

        borne_franchie = seuil.borne_rouge if niveau == "rouge" else seuil.borne_orange

        # Formatage de la clé 'type' unifiée pour le frontend React
        type_key = f"seuil_{seuil.champ}" if not str(seuil.champ).startswith("seuil_") else seuil.champ

        alertes.append({
            "type": type_key,
            "niveau": niveau,
            "titre": f"{seuil.label} {'en dessous du' if seuil.sens == 'bas' else 'au-dessus du'} seuil",
            "description": (
                f"{seuil.label} : {_formatter_valeur(valeur, seuil)} "
                f"({'seuil' if niveau == 'orange' else 'seuil critique'} : "
                f"{_formatter_valeur(borne_franchie, seuil)}) — {seuil.conseil}."
            ),
            "score": round(float(valeur), 4),
        })
    return alertes


def generer_alertes_regles(fact_qs) -> List[Dict[str, Any]]:
    """Évalue toutes les règles (fixes + combustibles) sur tout l'historique
    `fact_qs` et renvoie la liste PLATE des alertes déclenchées (une entrée
    par (jour, seuil franchi)) — c'est le format attendu par l'appelant
    (DashboardSummaryView.get(), qui construit ensuite le tableau `alertes`
    du panneau "Alertes Actives" à partir de cette liste).

    CORRIGÉ — cette fonction référençait un `df` jamais défini dans ce
    scope (NameError immédiat à l'exécution) et construisait un objet
    "evolution_data" par jour (avec des clés is_anomaly/criticite_pct...)
    qui n'a rien à voir avec ce que l'appelant attend réellement. Comme
    DashboardSummaryView.get() encapsule TOUT son traitement dans un même
    bloc, cette NameError faisait planter la vue "/dashboard/summary/" au
    grand complet — la cause de plusieurs graphiques vides côté frontend.
    """
    seuils = SEUILS_FIXES + generer_seuils_combustibles(fact_qs)
    champs_necessaires = {"date"} | {s.champ for s in seuils}

    resultat: List[Dict[str, Any]] = []
    for row in fact_qs.values(*champs_necessaires):
        alertes_jour = evaluer_jour(row, seuils)
        date_str = str(row["date"])
        for alerte in alertes_jour:
            alerte["date"] = date_str
            resultat.append(alerte)

    return resultat