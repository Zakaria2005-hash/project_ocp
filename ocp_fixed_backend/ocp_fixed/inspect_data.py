#!/usr/bin/env python
"""
inspect_data.py — Inspection rapide des fichiers Excel sources (CORRIGÉ).

Corrections : chemin Windows codé en dur -> argument --input-dir portable ;
`with pd.ExcelFile` fermé proprement ; erreurs journalisées sans interrompre
l'inspection des autres fichiers.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandas as pd


def inspect_excel_files(directory: Path) -> Path:
    output = []
    fichiers = sorted(p for p in directory.iterdir() if p.suffix.lower() == ".xlsx")

    if not fichiers:
        print(f"Aucun fichier .xlsx trouvé dans {directory}.")

    for filepath in fichiers:
        output.append(f"=== Fichier : {filepath.name} ===")
        try:
            with pd.ExcelFile(filepath) as xls:
                for sheet_name in xls.sheet_names:
                    output.append(f"  --- Feuille : {sheet_name} ---")
                    df = pd.read_excel(xls, sheet_name=sheet_name)
                    output.append(f"  Dimensions : {df.shape}")
                    output.append("  Colonnes & types :")
                    for col in df.columns:
                        output.append(
                            f"    - {col} ({df[col].dtype}) : {df[col].notnull().sum()} non-null"
                        )
                    output.append("  Échantillon :")
                    output.append(df.head(2).to_string())
                    output.append("")
        except Exception as exc:
            output.append(f"  ERREUR de lecture : {exc}")
        output.append("")

    resultat_path = directory / "inspection_results.txt"
    resultat_path.write_text("\n".join(output), encoding="utf-8")
    return resultat_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inspection des fichiers Excel sources OCP.")
    parser.add_argument(
        "--input-dir",
        default=os.environ.get("OCP_DATA_DIR", "./data"),
        help="Dossier contenant les fichiers Excel à inspecter (défaut : ./data).",
    )
    args = parser.parse_args()
    chemin = inspect_excel_files(Path(args.input_dir).resolve())
    print(f"Résultats écrits dans : {chemin}")
