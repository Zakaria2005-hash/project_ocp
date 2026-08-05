"""
Wrapper Django : `python manage.py ingest_ocp_data --input-dir ./data`
"""
from pathlib import Path

from django.core.management.base import BaseCommand

from ingest_ocp_data import (
    ingest_kpi_and_quality,
    ingest_production_totale,
    ingest_energie,
    ingest_synthese_arrets,
    ingest_pannes,
)


class Command(BaseCommand):
    help = "Ingestion idempotente des données KPI, arrêts et pannes du site de séchage."

    def add_arguments(self, parser):
        parser.add_argument(
            "--input-dir",
            default="./data",
            help="Dossier contenant les fichiers Excel sources.",
        )

    def handle(self, *args, **options):
        input_dir = Path(options["input_dir"]).resolve()
        if not input_dir.is_dir():
            self.stderr.write(self.style.ERROR(f"Dossier introuvable : {input_dir}"))
            return

        self.stdout.write("[1/5] KPIs journaliers + qualité traitée...")
        n1 = ingest_kpi_and_quality(input_dir)
        self.stdout.write(self.style.SUCCESS(f"  -> {n1} journées."))

        self.stdout.write("[2/5] Production totale (procédé)...")
        n2 = ingest_production_totale(input_dir)
        self.stdout.write(self.style.SUCCESS(f"  -> {n2} journées enrichies."))

        self.stdout.write("[3/5] Consommation d'énergie...")
        n3 = ingest_energie(input_dir)
        self.stdout.write(self.style.SUCCESS(f"  -> {n3} journées enrichies."))

        self.stdout.write("[4/5] Synthèse des arrêts journaliers...")
        n4 = ingest_synthese_arrets(input_dir)
        self.stdout.write(self.style.SUCCESS(f"  -> {n4} journées enrichies."))

        self.stdout.write("[5/5] Registre des pannes...")
        n5 = ingest_pannes(input_dir)
        self.stdout.write(self.style.SUCCESS(f"  -> {n5} événements."))

        self.stdout.write(self.style.SUCCESS("Ingestion terminée."))
