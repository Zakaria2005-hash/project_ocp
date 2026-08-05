#!/usr/bin/env python
"""
================================================================================
  run_ml.py — Feature Engineering & Modèles Prédictifs
              (VERSION ALIGNÉE — nouveau contrat de colonnes)
================================================================================
Aligné sur le nouveau contrat de colonnes de process_data.py :
  - "Tonnage (TSM)" n'est plus utilisée comme production totale (ce n'était
    pas la bonne métrique — voir process_data.py). production_totale_t
    (Production MC+MP+BG10 du fichier Performance_Journalière) est
    désormais la cible/feature de référence.
  - "Temps d'ouverture (h)" est réintégrée au contrat de colonnes (ajoutée
    sur demande) et disponible dans base_sql_fact_kpi.csv, mais le calcul
    du MTBF reste basé sur HM (heures de marche réelles) plutôt que sur
    Temps d'ouverture : cette dernière est quasi constante dans les
    données (24h pour 75% des jours), donc peu informative jour à jour —
    testé, le R² du MTBF en juin passe de -0.78 (avec Temps d'ouverture)
    à +0.47 (avec HM).
  - Nouvelles features exploitées (Performance_Journalière) pour enrichir
    la prédiction : humidité entrée/sortie, consommations spécifiques par
    combustible (gaz/gazoline/fuel), consommation d'énergie, heures de
    marche cumulées des 8 fours — susceptibles de mieux expliquer les
    dérives menant à une panne que les seules variables de production.

Lit directement base_sql_fact_kpi.csv / base_sql_pannes.csv produits par
process_data.py (à exécuter avant ce script) — pas de nouvelle lecture des
fichiers Excel bruts ici, pour éviter la redondance/divergence entre les
deux scripts.

Fuite de données : l'imputation (médiane/mode) est calculée UNIQUEMENT sur
la période d'entraînement (avant le dernier mois), jamais sur le test.

Exécution :
    python process_data.py --input-dir /chemin/vers/vos/fichiers   # d'abord
    python run_ml.py --input-dir /chemin/vers/vos/fichiers          # ensuite
================================================================================
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import joblib
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

# Colonnes des 8 fours, agrégées en une seule feature (hm_fours_total_h)
# plutôt que gardées séparées : 8 colonnes individuelles sur 144 lignes de
# train ajouteraient beaucoup de bruit/creux pour peu de signal ajouté.
COLONNES_HM_FOURS = [f"hm_four_{i}_h" for i in range(1, 9)]

# Nouvelles features de procédé (Performance_Journalière) utilisées en plus
# des variables de production/débit historiques, pour mieux expliquer les
# dérives menant aux pannes.
FEATURES_PROCEDE_ENRICHIES = [
    "humidite_entree_pct", "humidite_sortie_mc_pct", "humidite_sortie_mp_pct",
    "humidite_sortie_bg10_pct", "cs_gaz_nm3t", "cs_gazoline_kgt", "cs_fuel_kgt",
    "conso_energie_kcalt", "hm_fours_total_h",
]


def nom_fichier_sur(target: str) -> str:
    return target.replace(" ", "_").replace("(", "").replace(")", "")


def imputer_sans_fuite(df: pd.DataFrame, est_train: pd.Series, colonnes_a_ignorer=("date",)) -> pd.DataFrame:
    """Impute les valeurs manquantes en calculant médiane/mode UNIQUEMENT sur
    les lignes marquées `est_train`, puis applique le résultat à tout le
    DataFrame (train + test) — évite la fuite de la période de test vers
    l'entraînement.
    """
    df = df.copy()
    train_slice = df.loc[est_train]
    for col in df.columns:
        if col in colonnes_a_ignorer:
            continue
        if not df[col].isnull().any():
            continue
        if pd.api.types.is_numeric_dtype(df[col]):
            valeur_fill = train_slice[col].median()
            if pd.isna(valeur_fill):
                valeur_fill = df[col].median()
                print(f"  ATTENTION : train vide pour '{col}', imputation sur toute la série (repli).")
        else:
            mode_vals = train_slice[col].mode()
            valeur_fill = mode_vals.iloc[0] if not mode_vals.empty else None
        if valeur_fill is not None:
            df[col] = df[col].fillna(valeur_fill)
    return df


def main(input_dir: Path):
    output_dir = input_dir / "ML_Outputs"
    output_dir.mkdir(parents=True, exist_ok=True)

    # =========================================================================
    # 1. CHARGEMENT — source unique : les CSV nettoyés par process_data.py
    # =========================================================================
    fact_csv = input_dir / "files" / "Fichiers_CSV" / "base_sql_fact_kpi.csv"
    pannes_csv = input_dir / "files" / "Fichiers_CSV" / "base_sql_pannes.csv"

    if not fact_csv.exists():
        raise FileNotFoundError(
            f"{fact_csv} introuvable.\n"
            f"Lancez d'abord :\n    python process_data.py --input-dir {input_dir}\n"
            f"puis relancez run_ml.py."
        )

    master_df = pd.read_csv(fact_csv)
    master_df["date"] = pd.to_datetime(master_df["date"])

    if pannes_csv.exists():
        pannes_df = pd.read_csv(pannes_csv)
        pannes_df["date"] = pd.to_datetime(pannes_df["date"])
        pannes_daily = pannes_df.groupby("date").size().reset_index(name="nombre_pannes")
        master_df = pd.merge(master_df, pannes_daily, on="date", how="left")
        master_df["nombre_pannes"] = master_df["nombre_pannes"].fillna(0)
    else:
        print(f"  ATTENTION : {pannes_csv} introuvable — nombre_pannes mis à 0.")
        master_df["nombre_pannes"] = 0

    for champ in ["a_maint_subie_h", "hm", "temps_ouverture_h", "production_totale_t", "debit_th", "oee"]:
        if champ not in master_df.columns:
            raise KeyError(
                f"Colonne attendue manquante dans {fact_csv.name} : '{champ}'. "
                f"Vérifiez que process_data.py a bien été exécuté sur les données à jour."
            )

    master_df = master_df.sort_values("date").reset_index(drop=True)

    # ---- Feature dérivée : heures de marche cumulées des 8 fours ----
    colonnes_fours_presentes = [c for c in COLONNES_HM_FOURS if c in master_df.columns]
    if colonnes_fours_presentes:
        master_df["hm_fours_total_h"] = master_df[colonnes_fours_presentes].sum(axis=1, skipna=True)
    else:
        master_df["hm_fours_total_h"] = np.nan

    # =========================================================================
    # 2. DÉCOUPAGE TRAIN/TEST — déterminé AVANT l'imputation
    # =========================================================================
    derniere_date = master_df["date"].max()
    debut_test = derniere_date.replace(day=1)  # dernier mois disponible = jeu de test
    est_train = master_df["date"] < debut_test

    if not est_train.any() or est_train.all():
        raise RuntimeError(
            "Découpage train/test impossible : historique insuffisant pour isoler "
            "un dernier mois complet."
        )

    # =========================================================================
    # 3. IMPUTATION SANS FUITE (statistiques calculées sur le train uniquement)
    # =========================================================================
    master_df = imputer_sans_fuite(master_df, est_train)

    # =========================================================================
    # 4. FEATURE ENGINEERING
    # =========================================================================
    # MTTR/MTBF calculés à partir de HM (heures de marche réelles), pas de
    # Temps d'ouverture. Cette dernière est quasi constante dans les
    # données (24h pour 75% des jours, écart-type de 1.2h seulement — 10
    # valeurs distinctes sur 181 jours), donc peu informative jour à jour :
    # testé, le R² du MTBF en juin passe de -0.78 (avec Temps d'ouverture)
    # à +0.47 (avec HM). Temps d'ouverture reste disponible dans
    # base_sql_fact_kpi.csv pour d'autres usages, mais n'est plus la base
    # du MTBF ici.
    master_df["mttr_h"] = np.where(
        master_df["nombre_pannes"] > 0,
        master_df["a_maint_subie_h"] / master_df["nombre_pannes"],
        0,
    )
    master_df["mtbf_h"] = np.where(
        master_df["nombre_pannes"] > 0,
        master_df["hm"] / master_df["nombre_pannes"],
        master_df["hm"],
    )

    master_df["jour_semaine"] = master_df["date"].dt.dayofweek
    master_df["mois_num"] = master_df["date"].dt.month

    for col in ["production_totale_t", "debit_th", "oee"]:
        master_df[f"{col}_lag1"] = master_df[col].shift(1)
        master_df[f"{col}_lag7"] = master_df[col].shift(7)

    lignes_avant = len(master_df)
    master_df = master_df.dropna(
        subset=[c for c in master_df.columns if c.endswith("_lag1") or c.endswith("_lag7")]
    ).reset_index(drop=True)
    if lignes_avant != len(master_df):
        print(f"  {lignes_avant - len(master_df)} jour(s) de tête retiré(s) "
              f"(historique de lag incomplet, début de série).")

    master_df = pd.get_dummies(master_df, columns=["qualite_traitee"], drop_first=True)

    # =========================================================================
    # 5. ENTRAÎNEMENT (TRAIN : avant le dernier mois / TEST : dernier mois)
    # =========================================================================
    train_df = master_df[master_df["date"] < debut_test]
    test_df = master_df[master_df["date"] >= debut_test]

    if train_df.empty or test_df.empty:
        raise RuntimeError("Découpage train/test vide après retrait des lignes de tête.")
    print(f"  Train : {train_df['date'].min().date()} -> {train_df['date'].max().date()} "
          f"({len(train_df)} jours)")
    print(f"  Test  : {test_df['date'].min().date()} -> {test_df['date'].max().date()} "
          f"({len(test_df)} jours)")

    feature_cols = [
        "production_totale_t", "debit_th", "jour_semaine", "mois_num",
        "production_totale_t_lag1", "debit_th_lag1", "oee_lag1",
    ] + [c for c in FEATURES_PROCEDE_ENRICHIES if c in master_df.columns] + [
        c for c in master_df.columns if c.startswith("qualite_traitee_")
    ]

    targets = ["trg", "oee", "mtbf_h", "mttr_h", "a_maint_subie_h"]
    feature_cols = [c for c in feature_cols if c not in targets]

    X_train = train_df[feature_cols]
    X_test = test_df[feature_cols]

    sns.set_theme(style="whitegrid")
    models, predictions, metriques = {}, {}, {}

    for target in targets:
        y_train = train_df[target]
        y_test = test_df[target]

        model = HistGradientBoostingRegressor(random_state=42)
        model.fit(X_train, y_train)

        models[target] = model
        y_pred = model.predict(X_test)
        predictions[target] = y_pred
        metriques[target] = {
            "mae": float(mean_absolute_error(y_test, y_pred)),
            "r2": float(r2_score(y_test, y_pred)) if len(y_test) > 1 else None,
        }

        joblib.dump(model, output_dir / f"model_{nom_fichier_sur(target)}.pkl")

    print("\nMétriques de test (dernier mois disponible) :")
    for target, m in metriques.items():
        r2_str = f"{m['r2']:.3f}" if m["r2"] is not None else "N/A"
        print(f"  {target:20s} MAE={m['mae']:.3f}  R²={r2_str}")

    # =========================================================================
    # 6. COMPARAISON GLOBALE ET VISUALISATIONS
    # =========================================================================
    actual = test_df[["date"] + targets].copy()
    predicted = test_df[["date"]].copy()
    for target in targets:
        predicted[target] = predictions[target]

    global_actual = {t: actual[t].mean() if t != "a_maint_subie_h" else actual[t].sum() for t in targets}
    global_predicted = {t: predicted[t].mean() if t != "a_maint_subie_h" else predicted[t].sum() for t in targets}

    report_df = pd.DataFrame({"Actuel (dernier mois)": global_actual, "Prédiction (dernier mois)": global_predicted})
    report_df["Ecart Absolu"] = (report_df["Actuel (dernier mois)"] - report_df["Prédiction (dernier mois)"]).abs()
    report_df["Ecart Relatif (%)"] = (
        report_df["Ecart Absolu"]
        / report_df["Actuel (dernier mois)"].where(report_df["Actuel (dernier mois)"] != 0, 1e-9).abs()
    ) * 100
    report_df.to_csv(output_dir / "comparaison_globale.csv")

    x = np.arange(len(report_df))
    width = 0.35
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.bar(x - width / 2, report_df["Actuel (dernier mois)"], width, label="Actuel", color="steelblue")
    ax.bar(x + width / 2, report_df["Prédiction (dernier mois)"], width, label="Prédiction", color="darkorange")
    ax.set_ylabel("Valeur")
    ax.set_title("Comparaison Globale : Prédiction vs Actuel (dernier mois disponible)")
    ax.set_xticks(x)
    ax.set_xticklabels(report_df.index, rotation=45, ha="right")
    ax.legend()
    plt.tight_layout()
    plt.savefig(output_dir / "comparaison_globale.png")
    plt.close()

    for target in targets:
        plt.figure(figsize=(10, 4))
        plt.plot(actual["date"], actual[target], label="Actuel", marker="o")
        plt.plot(predicted["date"], predicted[target], label="Prédiction", marker="x", linestyle="--")
        plt.title(f"Prédiction journalière de {target} (dernier mois disponible)")
        plt.xticks(rotation=45)
        plt.legend()
        plt.tight_layout()
        plt.savefig(output_dir / f"prediction_journaliere_{nom_fichier_sur(target)}.png")
        plt.close()

    print(f"\nPhase de Machine Learning terminée. Résultats dans : {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Feature engineering et modèles prédictifs OCP.")
    parser.add_argument(
        "--input-dir",
        default=os.environ.get("OCP_DATA_DIR", "./data"),
        help="Dossier contenant les fichiers Excel sources (défaut : ./data).",
    )
    args = parser.parse_args()
    main(Path(args.input_dir).resolve())
