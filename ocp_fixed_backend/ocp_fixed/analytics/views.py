"""
================================================================================
  analytics/views.py — Endpoints API REST pour Power BI & Alertes Intelligentes
                        (VERSION CORRIGÉE)
================================================================================
Correction principale : `nature__in=['Mécanique', 'Électrique']` (avec accent)
ne correspondait jamais à la valeur réellement stockée "Electrique" (sans
accent) → les pannes électriques étaient invisibles dans les agrégats MTBF/
MTTR du dashboard Power BI. Corrigé partout via la constante partagée
`analytics.ml_pipeline.NATURES_PANNES_MAJEURES`.

Endpoints :
  /api/analytics/powerbi-dashboard/     — Flux JSON des KPIs avec MTBF/MTTR
  /api/analytics/live-alerts/           — Alertes cinétiques (Vert/Orange/Rouge)
  /api/analytics/train-model/           — Entraînement du modèle de pannes
  /api/analytics/cross-validate-pannes/ — Validation croisée temporelle (Pilier 2 renforcé)
  /api/analytics/predict-tomorrow/      — Prédiction de panne à J+1
  /api/analytics/anomalies/             — Détection d'anomalies (Isolation Forest)
  /api/analytics/efficience-energetique/— Courbe débit/énergie + alertes (Pilier 3)
  /api/analytics/simulate-flux/         — Simulation du jumeau numérique de flux
================================================================================
"""
from datetime import date
import logging
logger = logging.getLogger(__name__)
from django.db.models import Avg, Count, Sum
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from maintenance.models import EtatStocksFlux, FactArret, FactJournalier

from .ml_pipeline import (
    NATURES_PANNES_MAJEURES,
    AnomalyDetector,
    EfficienceEnergetique,
    FluxDigitalTwin,
    PannePredictor,
)


# =============================================================================
# ENDPOINT 1 : Power BI Dashboard
# =============================================================================
class PowerBIDashboardView(APIView):
    """GET /api/analytics/powerbi-dashboard/?month=6 (mois optionnel)."""

    def get(self, request):
        month = request.query_params.get("month")
        qs = FactJournalier.objects.all()
        if month:
            qs = qs.filter(date__month=int(month))

        journalier = []
        for jour in qs:
            arrets_jour = jour.arrets.filter(nature__in=NATURES_PANNES_MAJEURES)
            nb_pannes = arrets_jour.count()
            duree_pannes = arrets_jour.aggregate(total=Sum("duree_arret_h"))["total"] or 0.0

            to = jour.temps_ouverture_h or 24
            mttr = round(duree_pannes / nb_pannes, 2) if nb_pannes > 0 else 0.0
            mtbf = round((to - duree_pannes) / nb_pannes, 2) if nb_pannes > 0 else to

            journalier.append({
                "date": str(jour.date),
                "production_t": jour.production_totale_t,
                "oee": jour.trs_calc,
                "trg": jour.trg,
                "td": jour.disponibilite_globale,
                "taux_panne": jour.taux_panne,
                "debit_th": jour.debit_th,
                "hm": jour.hm,
                "qualite": jour.qualite_traitee,
                "mtbf_h": mtbf,
                "mttr_h": mttr,
                "nb_pannes": nb_pannes,
                "duree_pannes_h": round(duree_pannes, 2),
                "derive_thermique_pct": jour.derive_thermique(),
            })

        agg = qs.aggregate(
            production_totale=Sum("production_totale_t"),
            oee_moyen=Avg("trs_calc"),
            trg_moyen=Avg("trg"),
            td_moyen=Avg("disponibilite_globale"),
            taux_panne_moyen=Avg("taux_panne"),
            debit_moyen=Avg("debit_th"),
            nb_jours=Count("date"),
        )

        pannes_globales = FactArret.objects.filter(nature__in=NATURES_PANNES_MAJEURES)
        if month:
            pannes_globales = pannes_globales.filter(date_evenement__date__month=int(month))
        nb_pannes_total = pannes_globales.count()
        duree_pannes_total = pannes_globales.aggregate(total=Sum("duree_arret_h"))["total"] or 0.0
        temps_total = qs.aggregate(t=Sum("temps_ouverture_h"))["t"] or 1

        agg["mtbf_global_h"] = round((temps_total - duree_pannes_total) / max(nb_pannes_total, 1), 2)
        agg["mttr_global_h"] = round(duree_pannes_total / max(nb_pannes_total, 1), 2)
        agg["nb_pannes_total"] = nb_pannes_total

        return Response({"agregats": agg, "journalier": journalier})


# =============================================================================
# ENDPOINT 2 : Alertes Intelligentes en Temps Réel
# =============================================================================
class LiveAlertsView(APIView):
    """GET /api/analytics/live-alerts/ — vert/orange/rouge, 3 pipelines ML."""

    def get(self, request):
        all_alerts = []

        # 1. Anomalies (Isolation Forest sur Juin)
        try:
            detector = AnomalyDetector()
            juin_qs = FactJournalier.objects.filter(date__month=6)
            all_alerts.extend(detector.get_alerts(juin_qs))
        except Exception as exc:
            all_alerts.append({
                "date": str(date.today()), "niveau": "INFO", "type": "Système",
                "details": f"Détection d'anomalies indisponible : {exc}",
            })

        # 2. Risque de panne J+1
        try:
            predictor = PannePredictor()
            prediction = predictor.predict_tomorrow(
                FactJournalier.objects.all(), FactArret.objects.all()
            )
            if "error" not in prediction:
                all_alerts.append({
                    "date": prediction.get("date_prediction", ""),
                    "niveau": prediction.get("niveau", "VERT"),
                    "type": "Prédiction Panne J+1",
                    "details": prediction.get("message", ""),
                    "score": prediction.get("probabilite"),
                })
        except Exception as exc:
            all_alerts.append({
                "date": str(date.today()), "niveau": "INFO", "type": "Système",
                "details": f"Prédiction de pannes indisponible : {exc}",
            })

        # 3. Perte de rendement énergétique (régression débit/conso — Pilier 3)
        # Utilise alertes_recentes() (derniers jours seulement), pas
        # get_alerts() qui renverrait tout l'historique — non pertinent
        # pour un écran temps réel.
        try:
            efficience = EfficienceEnergetique()
            all_alerts.extend(efficience.alertes_recentes(FactJournalier.objects.all()))
        except Exception as exc:
            all_alerts.append({
                "date": str(date.today()), "niveau": "INFO", "type": "Système",
                "details": f"Analyse d'efficience énergétique indisponible : {exc}",
            })

        # 4. Saturation aval (dernier état de flux connu)
        try:
            dernier_flux = EtatStocksFlux.objects.order_by("-date_enregistrement").first()
            if dernier_flux:
                h = dernier_flux.heures_avant_saturation()
                if h is not None and h < 8:
                    all_alerts.append({
                        "date": str(dernier_flux.date_enregistrement),
                        "niveau": "ROUGE" if h < 4 else "ORANGE",
                        "type": "Saturation Silos Aval",
                        "details": (
                            f"Saturation des silos prévue dans {h}h. "
                            f"Stock aval: {dernier_flux.stock_aval_sec_t}T / "
                            f"{dernier_flux.capacite_max_silos_t}T."
                        ),
                    })
        except Exception as exc:
            all_alerts.append({
                "date": str(date.today()), "niveau": "INFO", "type": "Système",
                "details": f"Simulation de flux indisponible : {exc}",
            })

        priority = {"ROUGE": 0, "ORANGE": 1, "VERT": 2, "INFO": 3}
        all_alerts.sort(key=lambda a: priority.get(a.get("niveau", "INFO"), 3))

        if any(a["niveau"] == "ROUGE" for a in all_alerts):
            statut_global = "ROUGE"
        elif any(a["niveau"] == "ORANGE" for a in all_alerts):
            statut_global = "ORANGE"
        else:
            statut_global = "VERT"

        return Response({
            "statut_global": statut_global,
            "nb_alertes": len(all_alerts),
            "alertes": all_alerts,
        })


# =============================================================================
# ENDPOINT 3 : Entraînement du Modèle de Prédiction de Pannes
# =============================================================================
class TrainModelView(APIView):
    """POST /api/analytics/train-model/ — entraîne et évalue le prédicteur."""

    def post(self, request):
        try:
            predictor = PannePredictor()
            cutoff_str = request.data.get("cutoff_date") if hasattr(request, "data") else None
            cutoff = date.fromisoformat(cutoff_str) if cutoff_str else date(2026, 6, 1)
            results = predictor.train_and_evaluate(
                FactJournalier.objects.all(), FactArret.objects.all(), cutoff
            )
            return Response({
                "status": "success",
                "message": "Modèle entraîné avec succès.",
                "results": results,
            })
        except Exception as exc:
            return Response(
                {"status": "error", "message": str(exc)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )


# =============================================================================
# ENDPOINT 4 : Prédiction Panne J+1
# =============================================================================
class PredictTomorrowView(APIView):
    """GET /api/analytics/predict-tomorrow/"""

    def get(self, request):
        try:
            predictor = PannePredictor()
            result = predictor.predict_tomorrow(
                FactJournalier.objects.all(), FactArret.objects.all()
            )
            return Response(result)
        except Exception as exc:
            return Response({"error": str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# =============================================================================
# ENDPOINT 5 : Détection d'Anomalies (Juin)
# =============================================================================
class AnomalyDetectionView(APIView):
    """GET /api/analytics/anomalies/"""

    def get(self, request):
        try:
            detector = AnomalyDetector()
            juin_qs = FactJournalier.objects.filter(date__month=6)
            alerts = detector.get_alerts(juin_qs)
            df = detector.fit_predict(juin_qs)

            return Response({
                "nb_jours_analyses": len(df) if not df.empty else 0,
                "nb_anomalies": len(alerts),
                "alertes": alerts,
            })
        except Exception as exc:
            return Response({"error": str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# =============================================================================
# ENDPOINT 6 : Simulation Jumeau Numérique de Flux
# =============================================================================
class SimulateFluxView(APIView):
    """POST /api/analytics/simulate-flux/ — voir docstring FluxDigitalTwin.simulate()."""

    def post(self, request):
        try:
            data = request.data
            twin = FluxDigitalTwin()

            # BUG CORRIGÉ : `data.get(cle, defaut)` ne renvoie `defaut` QUE si
            # la clé est absente — pas si elle vaut `null`. Or le frontend
            # envoie explicitement `train_capacite_t: null` /
            # `train_intervalle_h: null` quand mode_trains === "continu"
            # (cf. JumeauView.tsx), donc `float(data.get("train_capacite_t",
            # 2500))` recevait `float(None)` et plantait — systématiquement
            # en mode continu, qui est le mode par défaut. Ce petit
            # utilitaire traite clé-absente et valeur-null de la même façon.
            def valeur(cle, defaut):
                v = data.get(cle, defaut)
                return defaut if v is None else v

            # BUG CORRIGÉ : cette vue ne transmettait aucun des nouveaux
            # paramètres (trains discrets, pauses programmées, Monte-Carlo)
            # à FluxDigitalTwin.simulate() — le frontend pouvait les envoyer
            # sans le moindre effet, silencieusement ignorés.
            pauses_brutes = valeur("pauses", [])
            pauses = [
                {"debut_h": int(p["debut_h"]), "duree_h": int(p["duree_h"])}
                for p in pauses_brutes
                if "debut_h" in p and "duree_h" in p
            ]
            result = twin.simulate(
                stock_amont_t=float(valeur("stock_amont_t", 10000)),
                debit_fours_th=float(valeur("debit_fours_th", 200)),
                stock_aval_t=float(valeur("stock_aval_t", 2000)),
                capacite_silos_t=float(valeur("capacite_silos_t", 5000)),
                cadence_trains_th=float(valeur("cadence_trains_th", 150)),
                horizon_h=int(valeur("horizon_h", 24)),
                mode_trains=valeur("mode_trains", "continu"),
                train_capacite_t=float(valeur("train_capacite_t", 2500)),
                train_intervalle_h=int(valeur("train_intervalle_h", 6)),
                pauses=pauses,
                aleas=bool(valeur("aleas", False)),
                aleas_pct=float(valeur("aleas_pct", 10)),
                n_iterations=int(valeur("n_iterations", 200)),
            )
            return Response(result)
        except Exception as exc:
            # Import local et volontairement autonome (ne dépend d'aucun
            # import ajouté ailleurs en haut du fichier) — pour que ce
            # correctif fonctionne même si seule cette méthode est copiée.
            import logging
            logging.getLogger(__name__).exception("Erreur dans SimulateFluxView (simulate-flux)")
            return Response({"error": str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# =============================================================================
# ENDPOINT 7 : Efficience Énergétique (Pilier 3)
# =============================================================================
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from django.db.models import Avg
from maintenance.models import FactJournalier  # Ajuste selon ton app


class EfficienceEnergetiqueView(APIView):
    """
    Vue analytics dynamique de l'efficience énergétique.
    Filtres acceptés (Query Params) :
    - month : numéro du mois (1-12) ou optionnel pour l'année complète
    - energy : 'ALL' (kcal/T), 'GAZ' (Nm³/T), 'GAZOLINE' (kg/T), 'FUEL' (kg/T)
    """

    # Baselines OCP selon le vecteur énergétique
    BASELINES = {
        "ALL": 160000.0,  # kcal/T
        "GAZ": 10.76,  # Nm³/T
        "GAZOLINE": 1.20,  # kg/T
        "FUEL": 12.50,  # kg/T
    }

    # Coûts unitaires moyens indicatifs (MAD / unité)
    COUTS_UNITAIRES = {
        "ALL": 0.00012,  # MAD / kcal
        "GAZ": 3.102547,  # MAD / Nm³
        "GAZOLINE": 4059.729,  # MAD / kg
        "FUEL": 4458.50,  # MAD / kg
    }

    def get(self, request):
        try:
            month = request.query_params.get("month")
            energy_filter = request.query_params.get("energy", "ALL").upper()
            qs = FactJournalier.objects.all().order_by("date")
            if month and month.isdigit():
                qs = qs.filter(date__month=int(month))
            baseline = self.BASELINES.get(energy_filter, self.BASELINES["ALL"])
            cout_unitaire = self.COUTS_UNITAIRES.get(energy_filter, self.COUTS_UNITAIRES["ALL"])
            evolution = []
            scatter = []
            valeurs_conso = []
            derives = []
            jours_sur_derive = 0
            cout_total_surplus = 0.0

            total_gaz = 0.0
            total_gazoline = 0.0
            total_fuel = 0.0
            count_valid = 0

            for j in qs:
                # 1. Extraction de la consommation selon le filtre
                if energy_filter == "GAZ":
                    conso = float(j.cs_gaz_nm3t or 0)
                elif energy_filter == "GAZOLINE":
                    conso = float(j.cs_gazoline_kgt or 0)
                elif energy_filter == "FUEL":
                    conso = float(j.cs_fuel_kgt or 0)
                else:  # ALL
                    conso = float(j.conso_energie_kcalt or 0)

                debit = float(j.debit_th or 0)
                prod = float(j.production_totale_t or (debit * 24.0))

                if conso <= 0:
                    continue

                valeurs_conso.append(conso)

                # 2. Calcul dynamique de la dérive par rapport à la baseline du vecteur
                derive_pct = round(((conso - baseline) / baseline) * 100, 1)
                derives.append(derive_pct)

                # 3. Calcul des jours en sur-dérive et du surcoût
                if derive_pct > 0:
                    jours_sur_derive += 1
                    surplus_unitaire = conso - baseline
                    impact_journalier = surplus_unitaire * prod * cout_unitaire
                    cout_total_surplus += impact_journalier
                else:
                    impact_journalier = 0.0

                evolution.append({
                    "date": str(j.date),
                    "conso_energie_kcalt": round(conso, 2),
                    "derive_thermique_pct": derive_pct,
                    "impact_financier_dh": round(impact_journalier, 0),
                    "production_t": round(prod, 1),
                })

                if debit > 0:
                    scatter.append({
                        "debit_th": round(debit, 1),
                        "conso_energie_kcalt": round(conso, 2),
                        "date": str(j.date)
                    })

                # Accumulation globale pour le mix des combustibles
                total_gaz += float(j.cs_gaz_nm3t or 0)
                total_gazoline += float(j.cs_gazoline_kgt or 0)
                total_fuel += float(j.cs_fuel_kgt or 0)
                count_valid += 1

            # Tri du Scatter Plot par Débit croissant pour le graphique Recharts
            scatter = sorted(scatter, key=lambda x: x["debit_th"])

            # Aggrégations dynamiques
            conso_moyenne = round(sum(valeurs_conso) / len(valeurs_conso), 2) if valeurs_conso else 0.0
            derive_moyenne = round(sum(derives) / len(derives), 1) if derives else 0.0

            # Détermination de l'unité
            unite = "kcal/T"
            if energy_filter == "GAZ":
                unite = "Nm³/T"
            elif energy_filter in ["GAZOLINE", "FUEL"]:
                unite = "kg/T"

            # Mix énergétique moyen
            mix_energetique = []
            if count_valid > 0:
                mix_energetique = [
                    {"name": "Gaz", "code": "GAZ", "value": round(total_gaz / count_valid, 2), "unit": "Nm³/T"},
                    {"name": "Gazoline", "code": "GAZOLINE", "value": round(total_gazoline / count_valid, 2),
                     "unit": "kg/T"},
                    {"name": "Fuel", "code": "FUEL", "value": round(total_fuel / count_valid, 2), "unit": "kg/T"},
                ]

            return Response({
                "energy_type": energy_filter,
                "unit": unite,
                "baseline": baseline,
                "conso_moyenne": conso_moyenne,
                "derive_moyenne_pct": derive_moyenne,
                "jours_sur_derive": jours_sur_derive,
                "total_jours": len(valeurs_conso),
                "cout_total_surplus_dh": round(cout_total_surplus, 0),
                "baseline_kcal_t": self.BASELINES["ALL"],
                "optimum_debit_min": 380,
                "optimum_debit_max": 450,
                "evolution": evolution,
                "scatter": scatter,
                "repartition_energies": mix_energetique,
            })

        except Exception as exc:
            return Response({"error": str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# =============================================================================
# ENDPOINT 8 : Validation Croisée Temporelle du Modèle de Pannes
# =============================================================================
class CrossValidatePannesView(APIView):
    """GET /api/analytics/cross-validate-pannes/?n_splits=4

    Complète /train-model/ (split unique) par une validation croisée
    temporelle (TimeSeriesSplit) — recommandé pour le rapport de stage,
    car moins optimiste mais plus représentatif de la performance réelle
    sur un historique aussi court.
    """

    def get(self, request):
        n_splits = int(request.query_params.get("n_splits", 4))
        try:
            predictor = PannePredictor()
            results = predictor.cross_validate(
                FactJournalier.objects.all(), FactArret.objects.all(), n_splits=n_splits
            )
            return Response(results)
        except Exception as exc:
            return Response({"error": str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
