from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # pas d'affichage interactif nécessaire (évite warnings backend)
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

from common_utils import (
    trouver_fichier,
    trouver_fichiers_mensuels,
    mois_vers_numero,
    normaliser_texte,
    safe_float,
    extraire_valeurs_par_libelle,
    parser_colonne_date_mixte,
    PATTERN_HISTORIQUE_KPI,
    PATTERN_PERFORMANCE_MOIS,
    PATTERN_SYNTHESE_ARRETS,
    PATTERN_PANNES,
)

# ==============================================================================
# CONTRAT DE COLONNES — Performance_Journalière_du_mois_*.xlsx
# (libellé brut normalisé -> nom de champ). Recherche par libellé : la
# position de ligne varie selon les mois (ex. énergie en ligne 56 pour
# janvier-mars, 58-59 pour avril-juin) — un index fixe serait faux la
# moitié du temps.
# ==============================================================================
CHAMPS_PERFORMANCE = {
    "Qualité traitée": "qualite_traitee",
    "Production totale": "production_totale_t",
    "Production MC": "production_mc_t",
    "Production MP": "production_mp_t",
    "Production BG10": "production_bg10_t",
    "Débit horaire par four (T/H)": "debit_par_four_th",
    "Humidité entrée %": "humidite_entree_pct",
    "Humidité sortie MC %": "humidite_sortie_mc_pct",
    "Humidité sortie MP %": "humidite_sortie_mp_pct",
    "Humidité sortie BG10 %": "humidite_sortie_bg10_pct",
    "HM Four N°1": "hm_four_1_h",
    "HM Four N°2": "hm_four_2_h",
    "HM Four N°3": "hm_four_3_h",
    "HM Four N°4": "hm_four_4_h",
    "HM Four N°5": "hm_four_5_h",
    "HM Four N°6": "hm_four_6_h",
    "HM Four N°7": "hm_four_7_h",
    "HM Four N°8": "hm_four_8_h",
    "Cs Gas (Nm3/T)": "cs_gaz_nm3t",
    "Cs gazoline (kg/T)": "cs_gazoline_kgt",
    "Cs Fuel (kg/T)": "cs_fuel_kgt",
    "Consommation d'énergie (kcal/T)": "conso_energie_kcalt",
}

# Colonnes retenues depuis Historique_KPI_journalier.xlsx (nom brut Excel
# -> nom de champ). "Tonnage (TSM)" est délibérément exclue : ce n'est pas
# la production totale (voir note en tête de fichier).
COLONNES_KPI = {
    "Journée": "date",
    "Débit (T/H)": "debit_th",
    "HM": "hm",
    "A Exploitation  (h)": "a_exploitation_h",
    "A Externe (h)": "a_externe_h",
    "Arrêts décidé  (h)": "arrets_decide_h",
    "A Maintenance Subie (h)": "a_maint_subie_h",
    "A Maintenance Planifié autres (h)": "a_maint_planifie_h",
    "Temps d'ouverture  (h)": "temps_ouverture_h",
    "OEE": "oee",
    "TRG": "trg",
    "TD": "td",
    "TAUX PANNE": "taux_panne",
}

# Colonnes retenues depuis Les_pannes_de_chaque_mois.xlsx.
# "DUREE" (pas "Duree(h)", qui est DUREE/24 — bug déjà corrigé ailleurs
# dans le projet) est la vraie colonne en heures.
COLONNES_PANNES = {
    "JOURNEE": "date",
    "EQUIPEMENT": "equipement",
    "DUREE": "duree_h",
    "CAUSE ARRET": "cause_arret",
    "TYPE": "type_arret",
    "NATURE": "nature",
    "UNITE": "unite",
}


def nettoyer_pourcentage_ou_ratio(valeur):
    """Convertit en float ; gère les pourcentages textuels type '100%'
    (bug déjà rencontré sur la colonne TRG d'Historique_KPI_journalier).
    """
    if isinstance(valeur, str):
        v = valeur.strip()
        if v.endswith("%"):
            try:
                return float(v[:-1].replace(",", ".")) / 100.0
            except ValueError:
                return np.nan
        try:
            return float(v.replace(",", "."))
        except ValueError:
            return np.nan
    try:
        return float(valeur)
    except (TypeError, ValueError):
        return np.nan


def rotation_xticks(ax, rotation=45, ha="right"):
    """Applique une rotation aux ticks sans déclencher le UserWarning
    "FixedFormatter should only be used together with FixedLocator".
    """
    ax.set_xticks(ax.get_xticks())
    ax.set_xticklabels(ax.get_xticklabels(), rotation=rotation, ha=ha)


# ==============================================================================
# ÉTAPE 1 : EXTRACTION — Historique_KPI_journalier.xlsx
# ==============================================================================
def charger_kpi(input_dir: Path) -> pd.DataFrame:
    kpi_file = trouver_fichier(input_dir, PATTERN_HISTORIQUE_KPI)
    if kpi_file is None:
        raise FileNotFoundError(f"'Historique_KPI_journalier.xlsx' introuvable dans {input_dir}.")

    df = pd.read_excel(kpi_file)

    # CORRECTION : la colonne de date s'appelait "Journée" dans les
    # versions précédentes du fichier, "Date" dans une mise à jour reçue
    # ensuite — on accepte les deux plutôt que de planter sur un simple
    # renommage de colonne.
    if "Date" in df.columns and "Journée" not in df.columns:
        df = df.rename(columns={"Date": "Journée"})

    colonnes_manquantes = set(COLONNES_KPI) - set(df.columns)
    if colonnes_manquantes:
        raise KeyError(
            f"Colonnes attendues manquantes dans {kpi_file.name} : {colonnes_manquantes}. "
            f"Colonnes disponibles : {list(df.columns)}"
        )

    df = df[list(COLONNES_KPI.keys())].rename(columns=COLONNES_KPI)

    # CORRECTION : la colonne date peut mélanger de vraies dates et des
    # chaînes texte françaises sans année (ex. "1-janv.") — défaut de
    # formatage Excel réellement rencontré. parser_colonne_date_mixte()
    # gère les deux cas plutôt qu'un simple pd.to_datetime() qui planterait
    # sur les chaînes non standard.
    if df["date"].apply(lambda v: isinstance(v, str)).any():
        print("  Colonne date au format mixte détectée (texte + dates réelles) — "
              "reconstruction via parser_colonne_date_mixte().")
        df["date"] = parser_colonne_date_mixte(df["date"])
    else:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["date"] = df["date"].dt.normalize()

    for champ in ["debit_th", "hm", "a_exploitation_h", "a_externe_h", "arrets_decide_h",
                  "a_maint_subie_h", "a_maint_planifie_h", "temps_ouverture_h"]:
        df[champ] = df[champ].apply(safe_float)
    # OEE/TRG/TD/TAUX PANNE : nettoyage renforcé (gère les "100%" textuels).
    for champ in ["oee", "trg", "td", "taux_panne"]:
        df[champ] = df[champ].apply(nettoyer_pourcentage_ou_ratio)

    print(f"  Chargé : {kpi_file.name} ({len(df)} lignes, {len(COLONNES_KPI)} colonnes retenues).")
    return df


# ==============================================================================
# ÉTAPE 2 : EXTRACTION — Performance_Journalière_du_mois_*.xlsx (par libellé)
# ==============================================================================
def charger_performance(input_dir: Path) -> pd.DataFrame:
    fichiers = trouver_fichiers_mensuels(input_dir, PATTERN_PERFORMANCE_MOIS)
    if not fichiers:
        raise FileNotFoundError(f"Aucun fichier 'Performance_Journalière_du_mois_*' trouvé dans {input_dir}.")

    lignes_par_mois = []
    for mois, filepath in fichiers.items():
        valeurs_par_jour: dict = {}
        for libelle_brut, champ in CHAMPS_PERFORMANCE.items():
            libelle_cible = normaliser_texte(libelle_brut)
            valeurs = extraire_valeurs_par_libelle(filepath, libelle_cible)
            if not valeurs:
                print(f"  ATTENTION : libellé '{libelle_brut}' introuvable dans {filepath.name}.")
                continue
            for dt, val in valeurs.items():
                valeurs_par_jour.setdefault(dt, {})[champ] = val

        df_mois = pd.DataFrame.from_dict(valeurs_par_jour, orient="index")
        df_mois.index.name = "date"
        df_mois = df_mois.reset_index()
        lignes_par_mois.append(df_mois)
        print(f"  Performance extraite de {filepath.name} ({len(df_mois)} jours, "
              f"{len(CHAMPS_PERFORMANCE)} libellés recherchés).")

    df = pd.concat(lignes_par_mois, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()

    # Garde-fou anti produit-cartésien (cf. bug déjà rencontré) : si un même
    # jour apparaît deux fois (chevauchement de fichiers), on ne garde que
    # la première occurrence plutôt que de laisser le merge dupliquer les
    # lignes du KPI pour ce jour.
    n_avant = len(df)
    doublons = df[df.duplicated(subset=["date"], keep=False)]
    if not doublons.empty:
        print(f"  ATTENTION : {doublons['date'].nunique()} date(s) en doublon dans "
              f"les fichiers Performance — la première occurrence est conservée.")
    df = df.drop_duplicates(subset=["date"], keep="first")
    if len(df) != n_avant:
        print(f"  {n_avant - len(df)} ligne(s) dupliquée(s) retirée(s) avant fusion.")

    champs_numeriques = [c for c in CHAMPS_PERFORMANCE.values() if c != "qualite_traitee"]
    for champ in champs_numeriques:
        if champ in df.columns:
            df[champ] = df[champ].apply(safe_float)

    return df


# ==============================================================================
# ÉTAPE 3 : EXTRACTION — Les_pannes_de_chaque_mois.xlsx
# ==============================================================================
def charger_pannes(input_dir: Path) -> pd.DataFrame:
    pannes_file = trouver_fichier(input_dir, PATTERN_PANNES)
    if pannes_file is None:
        raise FileNotFoundError(f"'Les_pannes_de_chaque_mois.xlsx' introuvable dans {input_dir}.")

    df = pd.read_excel(pannes_file)
    colonnes_manquantes = set(COLONNES_PANNES) - set(df.columns)
    if colonnes_manquantes:
        raise KeyError(
            f"Colonnes attendues manquantes dans {pannes_file.name} : {colonnes_manquantes}. "
            f"Colonnes disponibles : {list(df.columns)}"
        )

    df = df[list(COLONNES_PANNES.keys())].rename(columns=COLONNES_PANNES)
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.normalize()
    df["duree_h"] = df["duree_h"].apply(safe_float)

    print(f"  Chargé : {pannes_file.name} ({len(df)} lignes, {len(COLONNES_PANNES)} colonnes retenues).")
    return df


def main(input_dir: Path):
    output_dir = input_dir / "files"
    plots_dir = output_dir / "Visualisations"
    data_dir = output_dir / "Fichiers_CSV"
    reports_dir = output_dir / "Rapport"
    for d in (output_dir, plots_dir, data_dir, reports_dir):
        d.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("  EXTRACTION DES 3 SOURCES (contrat de colonnes explicite)")
    print("=" * 60)
    kpi_df = charger_kpi(input_dir)
    perf_df = charger_performance(input_dir)
    pannes_df = charger_pannes(input_dir)

    master_df = pd.merge(kpi_df, perf_df, on="date", how="outer")
    master_df = master_df.sort_values("date").reset_index(drop=True)

    # =========================================================================
    # NETTOYAGE
    # =========================================================================
    missing_stats = master_df.isnull().sum().to_dict()
    constant_vars = [c for c in master_df.columns if master_df[c].nunique(dropna=False) <= 1]

    for col in master_df.columns:
        if col == "date":
            continue
        if master_df[col].isnull().any():
            if pd.api.types.is_numeric_dtype(master_df[col]):
                master_df[col] = master_df[col].fillna(master_df[col].median())
            else:
                mode_vals = master_df[col].mode()
                if not mode_vals.empty:
                    master_df[col] = master_df[col].fillna(mode_vals.iloc[0])

    # =========================================================================
    # CORRÉLATIONS
    # =========================================================================
    numeric_cols = master_df.select_dtypes(include=[np.number]).columns
    valid_numeric = [c for c in numeric_cols if c not in constant_vars]
    pearson_corr = master_df[valid_numeric].corr(method="pearson")

    # =========================================================================
    # VISUALISATIONS
    # =========================================================================
    sns.set_theme(style="whitegrid")

    plt.figure(figsize=(12, 6))
    missing_s = pd.Series(missing_stats)
    missing_s = missing_s[missing_s > 0].sort_values(ascending=False)
    if not missing_s.empty:
        sns.barplot(x=missing_s.values, y=missing_s.index)
        plt.title("Valeurs Manquantes Initiales par Variable")
    else:
        plt.text(0.5, 0.5, "0 Valeur Manquante Initiale", ha="center", fontsize=14)
        plt.title("Valeurs Manquantes Initiales")
    plt.tight_layout()
    plt.savefig(plots_dir / "01_valeurs_manquantes.png")
    plt.close()

    fig, ax = plt.subplots(figsize=(14, 6))
    sns.lineplot(data=master_df, x="date", y="production_totale_t", label="Production totale (T)", ax=ax)
    sns.lineplot(data=master_df, x="date", y="debit_th", label="Débit (T/H)", ax=ax)
    ax.set_title("Séries Temporelles - Production du Four de Séchage")
    rotation_xticks(ax)
    plt.tight_layout()
    plt.savefig(plots_dir / "02_series_temporelles.png")
    plt.close()

    plt.figure(figsize=(10, 6))
    sns.histplot(master_df["oee"], bins=20, kde=True, color="teal")
    plt.title("Distribution de l'OEE")
    plt.tight_layout()
    plt.savefig(plots_dir / "03_histogramme_OEE.png")
    plt.close()

    fig, ax = plt.subplots(figsize=(10, 6))
    sns.boxplot(data=master_df, x="qualite_traitee", y="production_totale_t", ax=ax)
    ax.set_title("Boxplot : Production Totale par Qualité Traitée")
    rotation_xticks(ax)
    plt.tight_layout()
    plt.savefig(plots_dir / "04_boxplot.png")
    plt.close()

    if len(valid_numeric) >= 2:
        plt.figure(figsize=(14, 12))
        top_corr = pearson_corr.iloc[:14, :14]
        sns.heatmap(top_corr, annot=True, cmap="coolwarm", fmt=".2f", linewidths=0.5)
        plt.title("Heatmap des Corrélations de Pearson (Échantillon)")
        plt.tight_layout()
        plt.savefig(plots_dir / "05_heatmap_correlation.png")
        plt.close()

    plt.figure(figsize=(10, 6))
    sns.scatterplot(data=master_df, x="debit_th", y="production_totale_t", hue="qualite_traitee", alpha=0.7)
    plt.title("Scatter Plot : Production Totale vs Débit (Coloré par Qualité)")
    plt.tight_layout()
    plt.savefig(plots_dir / "06_scatter_plot.png")
    plt.close()

    # ---- Pareto des arrêts (durée réelle en heures, colonne DUREE) ----
    pareto_data = (
        pannes_df.groupby("cause_arret")["duree_h"]
        .sum()
        .sort_values(ascending=False)
        .head(10)
    )
    fig, ax = plt.subplots(figsize=(14, 7))
    sns.barplot(x=pareto_data.index, y=pareto_data.values, color="royalblue", ax=ax)
    ax2 = ax.twinx()
    cum_percent = 100 * pareto_data.cumsum() / pareto_data.sum()
    ax2.plot(ax.get_xticks(), cum_percent, color="red", marker="D", ms=7)
    ax.set_title("Pareto des Arrêts (Top 10 Causes de Panne du Four)")
    rotation_xticks(ax)
    ax.set_ylabel("Durée Totale (H)")
    ax2.set_ylabel("Pourcentage Cumulé (%)")
    plt.tight_layout()
    plt.savefig(plots_dir / "07_pareto_arrets.png")
    plt.close()

    # ---- Nouveau : humidité entrée/sortie (procédé) ----
    fig, ax = plt.subplots(figsize=(14, 6))
    for col, label in [
        ("humidite_entree_pct", "Humidité entrée"),
        ("humidite_sortie_mc_pct", "Humidité sortie MC"),
        ("humidite_sortie_mp_pct", "Humidité sortie MP"),
        ("humidite_sortie_bg10_pct", "Humidité sortie BG10"),
    ]:
        if col in master_df.columns:
            sns.lineplot(data=master_df, x="date", y=col, label=label, ax=ax)
    ax.set_title("Humidité Entrée / Sortie (Procédé)")
    rotation_xticks(ax)
    plt.tight_layout()
    plt.savefig(plots_dir / "08_humidite.png")
    plt.close()

    # ---- Nouveau : consommations spécifiques par combustible ----
    fig, ax = plt.subplots(figsize=(14, 6))
    for col, label in [
        ("cs_gaz_nm3t", "Gaz (Nm3/T)"),
        ("cs_gazoline_kgt", "Gazoline (kg/T)"),
        ("cs_fuel_kgt", "Fuel (kg/T)"),
    ]:
        if col in master_df.columns:
            sns.lineplot(data=master_df, x="date", y=col, label=label, ax=ax)
    ax.set_title("Consommations Spécifiques par Combustible")
    rotation_xticks(ax)
    plt.tight_layout()
    plt.savefig(plots_dir / "09_consommations_combustibles.png")
    plt.close()

    # =========================================================================
    # EXPORTS CSV
    # =========================================================================
    sql_df = master_df.copy()
    sql_df["date"] = sql_df["date"].dt.strftime("%Y-%m-%d")
    sql_df.to_csv(data_dir / "base_sql_fact_kpi.csv", index=False)

    pannes_export = pannes_df.copy()
    pannes_export["date"] = pannes_export["date"].dt.strftime("%Y-%m-%d")
    pannes_export.to_csv(data_dir / "base_sql_pannes.csv", index=False)

    ml_df = pd.get_dummies(master_df, columns=["qualite_traitee"], drop_first=True)
    ml_df.to_csv(data_dir / "base_ml_kpi.csv", index=False)

    # =========================================================================
    # RAPPORT D'AUDIT JSON
    # =========================================================================
    audit_report = {
        "timestamp": datetime.now().isoformat(),
        "contrat_colonnes": {
            "performance_journaliere": list(CHAMPS_PERFORMANCE.values()),
            "historique_kpi": list(COLONNES_KPI.values()),
            "pannes": list(COLONNES_PANNES.values()),
        },
        "nettoyage": {
            "valeurs_manquantes_initiales": missing_stats,
            "valeurs_manquantes_residuelles": int(master_df.isnull().sum().sum()),
            "decisions_justifiees": (
                "Variables quantitatives imputées par la médiane. Variables "
                "qualitatives imputées par le mode. production_totale_t vient de "
                "'Production totale' (Performance_Journalière), PAS de 'Tonnage "
                "(TSM)' (Historique_KPI) — ce sont deux métriques différentes, "
                "vérifié par la somme Production MC+MP+BG10."
            ),
        },
        "variables_constantes_detectees_non_supprimees": constant_vars,
    }
    with open(reports_dir / "audit_report.json", "w", encoding="utf-8") as f:
        json.dump(audit_report, f, indent=4, ensure_ascii=False, default=str)

    # =========================================================================
    # COPIE DU CODE SOURCE ET ARCHIVE ZIP
    # =========================================================================
    shutil.copy(__file__, output_dir / "code_python.py")
    shutil.make_archive(str(input_dir / "files"), "zip", output_dir)
    print(f"\nTraitement terminé avec succès. Archive générée : {input_dir / 'files.zip'}")
    print(f"Colonnes finales dans base_sql_fact_kpi.csv : {list(sql_df.columns)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nettoyage, analyse et export des données OCP.")
    parser.add_argument(
        "--input-dir",
        default=os.environ.get("OCP_DATA_DIR", "./data"),
        help="Dossier contenant les fichiers Excel sources (défaut : ./data).",
    )
    args = parser.parse_args()
    main(Path(args.input_dir).resolve())

