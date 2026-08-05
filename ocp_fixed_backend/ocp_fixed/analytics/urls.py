from django.urls import path

from .views import (
    AnomalyDetectionView,
    CrossValidatePannesView,
    EfficienceEnergetiqueView,
    LiveAlertsView,
    PowerBIDashboardView,
    PredictTomorrowView,
    SimulateFluxView,
    TrainModelView,
)
from .dashboard_api import (
    DashboardSummaryView,
    EnergyListView,
    EquipmentKPIView,
    ExportImpactEnergetiqueView,
    JoursARisqueView,
    ObjectifsEnergetiquesView,
    PannesListView,
    ParetoView,
    ROIPredictifView,
)

app_name = "analytics"

urlpatterns = [
    path("powerbi-dashboard/", PowerBIDashboardView.as_view(), name="powerbi-dashboard"),
    path("live-alerts/", LiveAlertsView.as_view(), name="live-alerts"),
    path("train-model/", TrainModelView.as_view(), name="train-model"),
    path("cross-validate-pannes/", CrossValidatePannesView.as_view(), name="cross-validate-pannes"),
    path("predict-tomorrow/", PredictTomorrowView.as_view(), name="predict-tomorrow"),
    path("anomalies/", AnomalyDetectionView.as_view(), name="anomalies"),
    path("efficience-energetique/", EfficienceEnergetiqueView.as_view(), name="efficience-energetique"),
    path("simulate-flux/", SimulateFluxView.as_view(), name="simulate-flux"),
    # ---- Dédiés au frontend React (Kimi) — voir dashboard_api.py ----
    path("dashboard/summary/", DashboardSummaryView.as_view(), name="dashboard-summary"),
    path("dashboard/pannes/", PannesListView.as_view(), name="dashboard-pannes"),
    path("dashboard/equipment/", EquipmentKPIView.as_view(), name="dashboard-equipment"),
    path("dashboard/energy/", EnergyListView.as_view(), name="dashboard-energy"),
    path("dashboard/energy/objectifs/", ObjectifsEnergetiquesView.as_view(), name="dashboard-energy-objectifs"),
    path("dashboard/energy/export/", ExportImpactEnergetiqueView.as_view(), name="dashboard-energy-export"),
    path("dashboard/pareto/", ParetoView.as_view(), name="dashboard-pareto"),
    path("dashboard/roi-predictif/", ROIPredictifView.as_view(), name="dashboard-roi-predictif"),
    path("dashboard/jours-a-risque/", JoursARisqueView.as_view(), name="dashboard-jours-a-risque"),
]