from django.db import models  # noqa: F401

# Les modèles métier (FactJournalier, FactArret, EtatStocksFlux) vivent dans
# l'app "maintenance" — voir maintenance/models.py. Cette app "analytics" ne
# fait qu'exposer des pipelines ML et des endpoints API REST par-dessus.
