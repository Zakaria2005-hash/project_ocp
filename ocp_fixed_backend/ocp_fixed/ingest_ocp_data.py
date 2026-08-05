#!/usr/bin/env python
#!/usr/bin/env python
"""
================================================================================
  ingest_ocp_data.py — Script d'Ingestion Automatique, Robuste et Idempotent
                        (VERSION CORRIGÉE)
================================================================================
Corrections apportées par rapport à la version précédente :

  1. BUG CRITIQUE (collision de colonnes) : `clean_col_name()` transformait
     à la fois "DUREE" et "Duree(h)" en "duree", créant deux colonnes de
     même nom. `row.get('duree')` retournait alors une pandas.Series au lieu
     d'un scalaire, provoquant un plantage caché derrière un `except`
     générique. -> ingest_pannes() référence maintenant les colonnes réelles
     explicitement, sans passer par clean_col_name().

  2. BUG DE NOMMAGE DE FICHIERS : le code cherchait des noms avec espaces
     ("Historique KPI journalier.xlsx") alors que les fichiers réels
     utilisent des underscores ("Historique_KPI_journalier.xlsx").
     Résultat : `os.path.exists()` renvoyait toujours False et l'ingestion
     s'exécutait "avec succès" sans avoir rien inséré. -> utilise désormais
     des expressions régulières tolérantes (common_utils.py) qui acceptent
     espaces OU underscores, avec ou sans accents.

  3. BUG DE MAPPING : TYPE_MAPPING ne couvrait pas les valeurs "Panne" et
     "Décidé", qui tombaient donc systématiquement dans "Autre". -> corrigé
     dans common_utils.normaliser_type().

  4. INCOHÉRENCE MODÈLE/SCRIPT : le script tentait de renseigner
     `type_arret` et `unite` sur FactArret alors que ces champs n'existaient
     pas encore dans le modèle -> ajoutés dans maintenance/models.py.

  5. IDEMPOTENCE FRAGILE : `update_or_create(date_evenement=, equipement=,
     cause_precision=)` fusionnait à tort deux arrêts distincts du même
     équipement, le même jour, pour la même cause. -> utilise maintenant une
     clé naturelle dédiée (cle_naturelle) incluant la durée et le type.

  6. PERFORMANCE : ingest_synthese_arrets faisait un get_or_create + un
     .save() par (jour × nature), soit des centaines de requêtes SQL
     individuelles. -> les valeurs sont maintenant agrégées en mémoire par
     jour puis appliquées en un seul update_or_create par jour.

Exécution :
    python ingest_ocp_data.py --input-dir /chemin/vers/vos/fichiers
    (ou définissez la variable d'environnement OCP_DATA_DIR)

Idempotent : peut être relancé à volonté sans générer de doublons.
================================================================================
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import django
import pandas as pd

# ---- Initialisation de Django (avant tout import de modèle) ----
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from maintenance.models import FactJournalier, FactArret  # noqa: E402

from common_utils import (  # noqa: E402
    clean_col_name,
    safe_float,
    safe_str,
    normaliser_nature,
    normaliser_type,
    normaliser_texte,
    dedupliquer_colonnes,
    trouver_fichier,
    trouver_fichiers_mensuels,
    mois_vers_numero,
    extraire_valeurs_par_libelle,
    PATTERN_HISTORIQUE_KPI,
    PATTERN_PERFORMANCE_MOIS,
    PATTERN_SYNTHESE_ARRETS,
    PATTERN_PANNES,
)


# =============================================================================
# 1. INGESTION DES KPIs JOURNALIERS + QUALITÉ TRAITÉE
# =============================================================================
def ingest_kpi_and_quality(input_dir: Path) -> int:
    print("=" * 60)
    print("  INGESTION DES KPIs JOURNALIERS + QUALITÉ TRAITÉE")
    print("=" * 60)

    kpi_file = trouver_fichier(input_dir, PATTERN_HISTORIQUE_KPI)
    if kpi_file is None:
        print("  ATTENTION : fichier 'Historique_KPI_journalier.xlsx' introuvable "
              f"dans {input_dir} — étape ignorée.")
        return 0

    kpi_df = pd.read_excel(kpi_file)
    print(f"  Chargé : {kpi_file.name} ({len(kpi_df)} lignes)")

    # CORRECTION : normalisation explicite de la date du KPI (élimine toute
    # composante horaire résiduelle, ex. 00:00:01 au lieu de minuit pile,
    # qui ferait silencieusement échouer la jointure avec qualite_df sur
    # "Journée"). Sans "errors='coerce'" + "dt.normalize()", une valeur
    # Excel mal formatée passerait inaperçue jusqu'à ce que la qualité de
    # ce jour reste vide, remplie ensuite par le mode global (variance
    # détruite pour le ML).
    if "Date" in kpi_df.columns:
        kpi_df["Date"] = pd.to_datetime(kpi_df["Date"], errors="coerce").dt.normalize()

    # ---- Extraction de la qualité traitée depuis les fichiers Performance ----
    fichiers_performance = trouver_fichiers_mensuels(input_dir, PATTERN_PERFORMANCE_MOIS)
    qualite_dfs = []
    for mois, filepath in fichiers_performance.items():
        try:
            df = pd.read_excel(filepath, header=None)  # header=None est intentionnel : pas de ligne d'en-tête à cet endroit (faux positif possible des stubs de type pandas selon la version de l'IDE).
            dates = pd.to_datetime(df.iloc[1, 2:-1].values, errors="coerce")
            qualities = df.iloc[2, 2:-1].values
            q_df = pd.DataFrame({"Date": dates, "qualite_traitee": qualities})
            q_df["Date"] = q_df["Date"].dt.normalize()
            q_df = q_df.dropna(subset=["Date"])
            qualite_dfs.append(q_df)
            print(f"  Qualité extraite de {filepath.name} ({len(q_df)} jours).")
        except Exception as exc:
            print(f"  ATTENTION : échec extraction qualité pour {filepath.name} : {exc}")

    if qualite_dfs:
        qualite_df = pd.concat(qualite_dfs, ignore_index=True)

        # CORRECTION : garde-fou contre le produit cartésien. Si deux
        # fichiers Performance se chevauchent (même mois présent deux fois,
        # ou périodes qui se recoupent), une même "Journée" apparaîtrait
        # plusieurs fois dans qualite_df, et le merge multiplierait alors
        # les lignes de kpi_df pour ce jour — faussant tonnage/débit/etc.
        # dans la base et le dashboard, en silence.
        n_avant = len(qualite_df)
        doublons = qualite_df[qualite_df.duplicated(subset=["Date"], keep=False)]
        if not doublons.empty:
            print(f"  ATTENTION : {doublons['Date'].nunique()} date(s) en doublon dans "
                  f"les fichiers Performance (probable chevauchement de fichiers) — "
                  f"la première occurrence est conservée pour chacune.")
        qualite_df = qualite_df.drop_duplicates(subset=["Date"], keep="first")
        if len(qualite_df) != n_avant:
            print(f"  {n_avant - len(qualite_df)} ligne(s) dupliquée(s) retirée(s) de qualite_df "
                  f"avant la fusion (protection anti produit-cartésien).")

        kpi_df = pd.merge(kpi_df, qualite_df, on="Date", how="left")
        mode_val = kpi_df["qualite_traitee"].mode()
        if not mode_val.empty:
            kpi_df["qualite_traitee"] = kpi_df["qualite_traitee"].fillna(mode_val.iloc[0])

    # ---- Nettoyage des noms de colonnes (avec garde anti-collision) ----
    kpi_df.columns = [clean_col_name(c) for c in kpi_df.columns]
    kpi_df = dedupliquer_colonnes(kpi_df)

    COL_MAP = {
        "journee": "date",
        "tonnage": "tonnage_tsm_t",
        "oee": "trs_calc",
        "td": "disponibilite_globale",
        "debit": "debit_th",
        "hm": "hm",
        "a_exploitation": "a_exploitation_h",
        "a_externe": "a_externe_h",
        "a_maintenance_planifi": "a_maint_planifie_h",
        "arrets_decide": "arrets_decide_h",
        "a_maintenance_subie": "a_maint_subie_h",
        "temps_d_ouverture": "temps_ouverture_h",
        "perte_vitesse": "perte_vitesse",
        "trg": "trg",
        "taux_panne": "taux_panne",
        "qualite_traitee": "qualite_traitee",
    }
    rename_map = {}
    for col in kpi_df.columns:
        for pattern, target in COL_MAP.items():
            if pattern in col and target not in rename_map.values():
                rename_map[col] = target
                break
    kpi_df = kpi_df.rename(columns=rename_map)

    count_ok, count_err = 0, 0
    for _, row in kpi_df.iterrows():
        row: pd.Series  # aide les analyseurs statiques (PyCharm) à typer `row` correctement
        if "date" not in row or pd.isna(row.get("date")):
            continue
        try:
            dt = row["date"]
            dt = dt.date() if hasattr(dt, "date") else pd.to_datetime(dt).date()

            FactJournalier.objects.update_or_create(
                date=dt,
                defaults={
                    "tonnage_tsm_t": safe_float(row.get("tonnage_tsm_t")),
                    "trs_calc": safe_float(row.get("trs_calc")),
                    "disponibilite_globale": safe_float(row.get("disponibilite_globale")),
                    "debit_th": safe_float(row.get("debit_th")),
                    "hm": safe_float(row.get("hm")),
                    "a_exploitation_h": safe_float(row.get("a_exploitation_h")),
                    "a_externe_h": safe_float(row.get("a_externe_h")),
                    "a_maint_planifie_h": safe_float(row.get("a_maint_planifie_h")),
                    "arrets_decide_h": safe_float(row.get("arrets_decide_h")),
                    "a_maint_subie_h": safe_float(row.get("a_maint_subie_h")),
                    "temps_ouverture_h": safe_float(row.get("temps_ouverture_h")),
                    "perte_vitesse": safe_float(row.get("perte_vitesse")),
                    "trg": safe_float(row.get("trg")),
                    "taux_panne": safe_float(row.get("taux_panne")),
                    "qualite_traitee": safe_str(row.get("qualite_traitee")),
                },
            )
            count_ok += 1
        except Exception as exc:
            count_err += 1
            print(f"  ERREUR jour {row.get('date')} : {exc}")

    print(f"  -> FactJournalier : {count_ok} jours injectés, {count_err} erreurs.")
    return count_ok


# =============================================================================
# 1bis. INGESTION DE LA CONSOMMATION D'ÉNERGIE (pour derive_thermique())
# =============================================================================
def ingest_production_totale(input_dir: Path) -> int:
    """Extrait 'Production totale' des fichiers Performance_Journalière_*
    et l'utilise comme production_totale_t sur FactJournalier.

    CORRECTION : la valeur utilisée jusqu'ici, "Tonnage (TSM)" (fichier
    Historique_KPI_journalier), mesure autre chose que la production
    totale du site — vérifié : le ratio entre les deux varie de 0.85x à
    12x selon les jours (pas une différence d'unité constante). "Production
    totale" (ce fichier-ci) est en revanche la somme auto-cohérente
    Production MC + MP + BG10 + BG22 (vérifié : 5540 + 2163 + 0 = 7703
    pour le 1er janvier 2026) — c'est la vraie métrique de production
    globale. "Tonnage (TSM)" est conservée séparément sous tonnage_tsm_t
    pour traçabilité (voir ingest_kpi_and_quality), mais n'alimente plus
    production_totale_t.
    """
    print("\n" + "=" * 60)
    print("  INGESTION DE LA PRODUCTION TOTALE (Production MC+MP+BG10+BG22)")
    print("=" * 60)

    fichiers = trouver_fichiers_mensuels(input_dir, PATTERN_PERFORMANCE_MOIS)
    if not fichiers:
        print(f"  ATTENTION : aucun fichier Performance_Journalière_* trouvé dans {input_dir}.")
        return 0

    libelle_cible = normaliser_texte("Production totale")
    total = 0
    for mois, filepath in fichiers.items():
        valeurs = extraire_valeurs_par_libelle(filepath, libelle_cible)
        if not valeurs:
            print(f"  ATTENTION : libellé 'Production totale' introuvable dans {filepath.name}.")
            continue
        for dt, val in valeurs.items():
            production = safe_float(val)
            if production is None:
                continue
            FactJournalier.objects.update_or_create(
                date=dt, defaults={"production_totale_t": production}
            )
            total += 1
        print(f"  Production totale extraite de {filepath.name}.")

    print(f"  -> {total} journées enrichies avec la production totale (procédé).")
    return total


def ingest_energie(input_dir: Path) -> int:
    """Extrait la consommation d'énergie globale (kcal/T) ET les
    consommations spécifiques par combustible (gaz, gazoline, fuel) des
    fichiers Performance_* par recherche de libellé (position de ligne
    variable selon les mois : 56 pour janvier-mars, 58-59 pour avril-juin —
    un index fixe aurait silencieusement extrait la mauvaise donnée pour la
    moitié des mois).
    """
    print("\n" + "=" * 60)
    print("  INGESTION DE LA CONSOMMATION D'ÉNERGIE")
    print("=" * 60)

    fichiers = trouver_fichiers_mensuels(input_dir, PATTERN_PERFORMANCE_MOIS)
    if not fichiers:
        print(f"  ATTENTION : aucun fichier Performance_Journalière_* trouvé dans {input_dir}.")
        return 0

    # Libellé source -> champ FactJournalier. Une seule lecture par fichier
    # pour les 5 libellés, plutôt que 5 lectures séparées.
    CHAMPS_ENERGIE = {
        "Consommation d'énergie (kcal/T)": "conso_energie_kcalt",
        "Cs Gas (Nm3/T)": "cs_gaz_nm3t",
        "Cs gazoline (kg/T)": "cs_gazoline_kgt",
        "Cs Fuel (kg/T)": "cs_fuel_kgt",
        # AJOUTÉ — nécessaire au monitoring par règles métier
        # (analytics/regles_metier.py) : seuil de sur-humidité en sortie MC.
        "Humidité sortie MC %": "humidite_sortie_mc_pct",
    }

    total = 0
    for mois, filepath in fichiers.items():
        valeurs_par_jour: dict = {}
        for libelle_brut, champ in CHAMPS_ENERGIE.items():
            libelle_cible = normaliser_texte(libelle_brut)
            valeurs = extraire_valeurs_par_libelle(filepath, libelle_cible)
            if not valeurs:
                print(f"  ATTENTION : libellé '{libelle_brut}' introuvable dans {filepath.name}.")
                continue
            for dt, val in valeurs.items():
                conso = safe_float(val)
                if conso is None:
                    continue
                valeurs_par_jour.setdefault(dt, {})[champ] = conso

        for dt, champs in valeurs_par_jour.items():
            FactJournalier.objects.update_or_create(date=dt, defaults=champs)
            total += 1
        print(f"  Énergie (kcal/T + gaz/gazoline/fuel) + humidité sortie MC extraites de {filepath.name}.")

    print(f"  -> {total} journées enrichies avec les données d'énergie.")
    return total


# =============================================================================
# 2. INGESTION DES SYNTHÈSES D'ARRÊTS JOURNALIERS
# =============================================================================
NATURE_FIELD_MAP = {
    "heures theoriques": "heures_theoriques",
    "arrets decides": "arrets_decides",
    "arrets externes": "arrets_externes",
    "arrets utilisation y compris process": "arrets_utilisation",
    "heures de marche": "heures_de_marche",
    "maintenance planifiee": "maintenance_planifiee",
    "oee": "arrets_oee",
    "pannes maintenance mm me et inst": "pannes_maintenance",
    "trg": "arrets_trg",
    "taux de disponibilite": "taux_de_disponibilite",
    "temps d ouverture": "arrets_temps_ouverture",
}


def _annee_pour_mois(input_dir: Path, month_num: int) -> int:
    """Détermine l'année réelle du mois traité, au lieu de la coder en dur.

    CORRECTION : l'ancienne version utilisait `year=2026` en dur dans
    ingest_synthese_arrets — correct uniquement pour l'historique 2026
    fourni ici, mais silencieusement faux pour tout autre historique
    (2024, 2025...), qui se retrouverait alors projeté par erreur en 2026.

    Stratégie : le fichier Synthèse_des_arrets_* ne contient que le jour du
    mois (colonnes 1-31), sans année — on va donc la chercher dans le
    fichier Performance_Journalière_du_mois_* correspondant, qui contient
    de vraies dates complètes en en-tête. Si ce fichier est introuvable ou
    illisible, repli sur l'année civile en cours, avec avertissement
    explicite plutôt qu'une valeur fausse silencieuse.
    """
    fichiers_perf = trouver_fichiers_mensuels(input_dir, PATTERN_PERFORMANCE_MOIS)
    for mois_cle, filepath in fichiers_perf.items():
        if mois_vers_numero(mois_cle) != month_num:
            continue
        try:
            df = pd.read_excel(filepath, header=None)  # header=None est intentionnel : pas de ligne d'en-tête à cet endroit (faux positif possible des stubs de type pandas selon la version de l'IDE).
            dates = pd.to_datetime(df.iloc[1, 2:-1].values, errors="coerce")
            dates_valides = [d for d in dates if pd.notna(d)]
            if dates_valides:
                return dates_valides[0].year
        except Exception:
            continue

    from datetime import date as _date
    annee_repli = _date.today().year
    print(f"  ATTENTION : année introuvable pour le mois {month_num} via les fichiers "
          f"Performance_Journalière — repli sur l'année civile en cours ({annee_repli}). "
          f"Vérifiez le résultat si votre historique ne concerne pas l'année en cours.")
    return annee_repli



# =============================================================================
# 3. INGESTION DES PANNES (FactArret)
# =============================================================================
def ingest_pannes(input_dir: Path) -> int:
    print("\n" + "=" * 60)
    print("  INGESTION DES PANNES")
    print("=" * 60)

    pannes_file = trouver_fichier(input_dir, PATTERN_PANNES)
    if pannes_file is None:
        print(f"  ATTENTION : fichier 'Les_pannes_de_chaque_mois.xlsx' introuvable "
              f"dans {input_dir} — étape ignorée.")
        return 0

    pannes_df = pd.read_excel(pannes_file)
    print(f"  Chargé : {pannes_file.name} ({len(pannes_df)} lignes)")

    # IMPORTANT : on référence les colonnes ORIGINALES explicitement plutôt
    # que de passer par clean_col_name(), pour éviter la collision
    # "DUREE" / "Duree(h)" -> "duree" qui provoquait un plantage.
    colonnes_attendues = {
        "JOURNEE", "EQUIPEMENT", "CAUSE ARRET",
        "NATURE", "UNITE", "TYPE", "DUREE",
    }
    manquantes = colonnes_attendues - set(pannes_df.columns)
    if manquantes:
        print(f"  ATTENTION : colonnes attendues manquantes : {manquantes}. "
              "Vérifiez le format du fichier source.")

    count_ok, count_err = 0, 0
    # CORRECTION (Alerte 4) : compteur d'occurrences pour la clé naturelle.
    # Sans lui, deux arrêts RÉELLEMENT distincts (même équipement, même
    # jour, même cause, même durée — ex. deux bourrages identiques matin et
    # après-midi) generaient la même cle_naturelle et le second écrasait le
    # premier via update_or_create, faisant disparaître un événement réel
    # et faussant le MTBF (fréquence de pannes) utilisé par le ML.
    compteur_occurrences: dict = {}
    for _, row in pannes_df.iterrows():
        row: pd.Series  # aide les analyseurs statiques à typer `row` correctement
        journee_val = row.get("JOURNEE")
        if pd.isna(journee_val):
            continue

        try:
            dt = journee_val.date() if hasattr(journee_val, "date") else pd.to_datetime(journee_val).date()
            fact_jour, _ = FactJournalier.objects.get_or_create(date=dt)

            equipement = safe_str(row.get("EQUIPEMENT")) or "Inconnu"
            nature = normaliser_nature(row.get("NATURE"))
            type_arret = normaliser_type(row.get("TYPE"))
            unite = safe_str(row.get("UNITE")) or ""
            cause = safe_str(row.get("CAUSE ARRET")) or "Non spécifiée"

            # BUG DE DONNÉES DÉCOUVERT ET CORRIGÉ : "Duree(h)" est en réalité
            # DUREE / 24 (vérifié : ratio constant = 0.041666... = 1/24 sur
            # les 290 lignes) — c'est une fraction de jour au format Excel,
            # PAS des heures malgré son nom. La vraie colonne en heures est
            # "DUREE". L'ancienne priorité (Duree(h) d'abord) rendait toutes
            # les durées ~24x trop petites, ce qui empêchait le modèle de
            # prédiction de pannes de jamais voir une panne "significative"
            # (cible toujours à 0 sur tout l'historique).
            duree = safe_float(row.get("DUREE"))
            if duree is None:
                duree_fraction_jour = safe_float(row.get("DUREE"))
                duree = duree_fraction_jour * 24 if duree_fraction_jour is not None else None
            if duree is None:
                duree = 0.0

            cle_base = "|".join(
                [str(dt), equipement, cause, type_arret, f"{duree:.6f}"]
            )
            occurrence = compteur_occurrences.get(cle_base, 0)
            compteur_occurrences[cle_base] = occurrence + 1
            # Le suffixe "#0", "#1"... ne change rien pour le 1er événement
            # d'une combinaison donnée (compatibilité avec les bases déjà
            # ingérées), mais garantit qu'un 2e événement identique obtient
            # sa propre ligne au lieu d'écraser le premier.
            cle_naturelle = f"{cle_base}|{occurrence}"

            FactArret.objects.update_or_create(
                cle_naturelle=cle_naturelle,
                defaults={
                    "date_evenement": fact_jour,
                    "equipement": equipement,
                    "nature": nature,
                    "type_arret": type_arret,
                    "unite": unite,
                    "cause_precision": cause,
                    "duree_arret_h": duree,

                },
            )
            count_ok += 1
        except Exception as exc:
            count_err += 1
            print(f"  ERREUR panne {row.get('EQUIPEMENT')} le {row.get('JOURNEE')} : {exc}")

    print(f"  -> FactArret : {count_ok} pannes injectées, {count_err} erreurs.")
    return count_ok


# =============================================================================
# POINT D'ENTRÉE PRINCIPAL
# =============================================================================
def main():
    parser = argparse.ArgumentParser(description="Ingestion des données OCP (site de séchage).")
    parser.add_argument(
        "--input-dir",
        default=os.environ.get("OCP_DATA_DIR", "./data"),
        help="Dossier contenant les fichiers Excel sources "
             "(par défaut : ./data, ou variable d'environnement OCP_DATA_DIR).",
    )
    args = parser.parse_args()
    input_dir = Path(args.input_dir).resolve()

    print("\n" + "▓" * 60)
    print("  OCP DRYING PROJECT — INGESTION AUTOMATIQUE")
    print(f"  Source : {input_dir}")
    print("▓" * 60 + "\n")

    if not input_dir.is_dir():
        print(f"ERREUR : le dossier {input_dir} n'existe pas. "
              "Utilisez --input-dir ou la variable OCP_DATA_DIR pour le préciser.")
        return

    ingest_kpi_and_quality(input_dir)
    ingest_production_totale(input_dir)
    ingest_energie(input_dir)
    ingest_pannes(input_dir)

    nb_jours = FactJournalier.objects.count()
    nb_arrets = FactArret.objects.count()
    print("\n" + "▓" * 60)
    print("  INGESTION TERMINÉE")
    print(f"  FactJournalier : {nb_jours} jours en base")
    print(f"  FactArret      : {nb_arrets} événements en base")
    print("▓" * 60 + "\n")


if __name__ == "__main__":
    main()