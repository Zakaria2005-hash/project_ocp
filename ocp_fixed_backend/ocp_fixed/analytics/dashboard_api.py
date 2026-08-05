"""
================================================================================
  analytics/dashboard_api.py — Endpoints dédiés au frontend React
================================================================================
Le frontend attend exactement les formes JSON définies dans ses types TypeScript :
KPIData, DailyEvolution, AlertItem, MonthlyKPI, PanneItem, EquipmentKPI,
EnergyData, ParetoItem. Ce module les calcule à partir des données ingérées
(FactJournalier / FactArret).

Endpoints :
  GET /api/dashboard/summary/        -> { kpis, evolution, alertes, monthly, ... }
  GET /api/dashboard/pannes/         -> PanneItem[]
  GET /api/dashboard/equipment/      -> EquipmentKPI[]
  GET /api/dashboard/energy/         -> EnergyData[]
  GET /api/dashboard/pareto/         -> ParetoItem[]
  GET /api/dashboard/roi-predictif/  -> Gain financier prédictif
  GET /api/dashboard/jours-a-risque/ -> Jours prédits à risque + recommandations
================================================================================
"""
from __future__ import annotations

from datetime import date as _date

import pandas as pd
from django.db.models import Avg, Count, Sum
from rest_framework.response import Response
from rest_framework.views import APIView

from maintenance.models import BASELINE_CONSO_ENERGIE_KCAL_T, FactArret, FactJournalier

from .decision_matrix import (
    FENETRE_REFERENCE_DEBUT,
    FENETRE_REFERENCE_FIN,
    analyser_cause_jour_analogue,
    analyser_cause_periode_reference,
)
from .ml_pipeline import AnomalyDetector, NATURES_PANNES_MAJEURES, PannePredictor
from .regles_metier import (
    SEUILS_FIXES,
    evaluer_jour,
    generer_alertes_regles,
    generer_seuils_combustibles,
)


def _nombre_ou_none(valeur):
    """Convertit en float JSON-safe, ou None si NaN/absent (évite les NaN
    littéraux dans le JSON, invalides selon la RFC et mal gérés par JSON.parse)."""
    if valeur is None:
        return None
    try:
        if pd.isna(valeur):
            return None
    except (TypeError, ValueError):
        pass
    return float(valeur)


# CUTOFF_PREDICTIF : sépare la période d'ENTRAÎNEMENT de la période de PRÉVISION
CUTOFF_PREDICTIF = _date(2026, 6, 1)

_NATURES_PANNES_MAJEURES = NATURES_PANNES_MAJEURES
_DUREE_MIN_PANNE_MAJEURE_H = 0.5


def _risque_par_date(fact_qs, arret_qs, cutoff=CUTOFF_PREDICTIF):
    """Entraîne (ou réutilise) le PannePredictor et renvoie un dict
    {pd.Timestamp: probabilité de panne J+1} sur tout l'historique."""
    risque_par_date = {}
    try:
        predictor = PannePredictor()
        resultat_entrainement = predictor.train_and_evaluate(fact_qs, arret_qs, cutoff)
        if "error" not in resultat_entrainement:
            df_features = predictor._build_features(
                fact_qs, arret_qs, pour_entrainement=True
            )
            if not df_features.empty:
                X = df_features[predictor.feature_cols]
                probas = predictor.model.predict_proba(X)[:, 1]
                for d, p in zip(df_features["date"], probas):
                    risque_par_date[pd.Timestamp(d)] = float(p)
    except Exception:
        pass
    return risque_par_date


def _dates_pannes_majeures(arret_qs) -> set:
    """Renvoie l'ensemble des dates (pd.Timestamp) où une panne majeure a eu lieu."""
    records = list(
        arret_qs.filter(nature__in=_NATURES_PANNES_MAJEURES).values(
            "date_evenement", "duree_arret_h"
        )
    )
    if not records:
        return set()
    df = pd.DataFrame(records)
    df["date_evenement"] = pd.to_datetime(df["date_evenement"])
    agg = df.groupby("date_evenement")["duree_arret_h"].sum()
    return set(agg[agg > _DUREE_MIN_PANNE_MAJEURE_H].index)


def _mttr_reel_h(arret_qs) -> float | None:
    """MTTR réel (heures) mesuré sur l'historique des pannes majeures."""
    records = list(
        arret_qs.filter(
            nature__in=_NATURES_PANNES_MAJEURES, duree_arret_h__gt=_DUREE_MIN_PANNE_MAJEURE_H
        ).values_list("duree_arret_h", flat=True)
    )
    if not records:
        return None
    return float(sum(records) / len(records))


# =============================================================================
# GET /api/dashboard/summary/  ->  { kpis, evolution, alertes, monthly, ... }
# =============================================================================
class DashboardSummaryView(APIView):
  def get(self, request):
    qs = FactJournalier.objects.all().order_by("date")
    if not qs.exists():
      return Response({"kpis": None, "evolution": [], "alertes": [], "monthly": []})

    df = pd.DataFrame.from_records(
      qs.values(
        "date", "production_totale_t", "debit_th", "trs_calc", "trg",
        "disponibilite_globale", "taux_panne", "conso_energie_kcalt", "hm",
        "humidite_sortie_mc_pct", "humidite_sortie_mp_pct",
        "cs_gaz_nm3t", "cs_gazoline_kgt", "cs_fuel_kgt"
      )
    )
    df["date"] = pd.to_datetime(df["date"])

    # ---- Anomalies (Isolation Forest) ----
    detector = AnomalyDetector()
    df_anomalies = detector.fit_predict(qs)
    anomalies_par_date = {}
    if not df_anomalies.empty:
      for _, row in df_anomalies.iterrows():
        anomalies_par_date[pd.Timestamp(row["date"])] = {
          "is_anomaly": bool(row["anomaly_label"] == -1),
          "anomaly_score": _nombre_ou_none(row["anomaly_score"]),
        }

    # ---- Indice de Criticité (0-100%) ----
    # `criticite_par_date` reste calculé à partir du score brut d'Isolation
    # Forest (inversé + redimensionné 0-100%, voir logique ci-dessous).
    #
    # SEUIL_CRITICITE_PCT est en revanche FIXÉ à 50% (round, lisible pour un
    # directeur), plutôt que calculé dynamiquement à partir de la frontière
    # de décision interne du modèle (qui pouvait tomber n'importe où, ex.
    # 38.9%, sans signification métier particulière). Ce seuil n'affecte que
    # la ligne de référence visuelle "critique" côté frontend — il n'a AUCUN
    # impact sur `is_anomaly`, qui reste déterminé uniquement par le label
    # -1/1 réel du modèle (predict()), indépendamment de ce seuil d'affichage.
    SEUIL_CRITICITE_PCT = 50.0

    criticite_par_date = {}
    scores_bruts = [v["anomaly_score"] for v in anomalies_par_date.values() if v["anomaly_score"] is not None]
    if scores_bruts:
      scores_inverses = [-s for s in scores_bruts]
      score_min, score_max = min(scores_inverses), max(scores_inverses)
      etendue = (score_max - score_min) or 1.0
      for d_ts, info in anomalies_par_date.items():
        if info["anomaly_score"] is None:
          continue
        criticite_par_date[d_ts] = round(
          ((-info["anomaly_score"]) - score_min) / etendue * 100, 1
        )
    seuil_criticite_pct = SEUIL_CRITICITE_PCT
    for d_ts in anomalies_par_date:
        crit = criticite_par_date.get(d_ts)
        if crit is not None:
            anomalies_par_date[d_ts]["is_anomaly"] = crit >= SEUIL_CRITICITE_PCT
    # ---- Règles métier explicables (SEUILS FIXES + DYNAMIQUES COMBUSTIBLES) ----
    seuils_explicables = SEUILS_FIXES + generer_seuils_combustibles(qs)
    regles_par_date = {}
    for _, row in df.iterrows():
      row_dict = row.to_dict()
      alertes_jour = evaluer_jour(row_dict, seuils_explicables)

      # Normalisation du type pour correspondre EXACTEMENT aux types de regles_definitions
      regles_formatees = []
      for a in alertes_jour:
        t = str(a["type"])
        type_normalise = t if t.startswith("seuil_") else f"seuil_{t}"
        regles_formatees.append({
          "type": type_normalise,
          "niveau": a["niveau"],
          "titre": a.get("titre"),
          "description": a.get("description")
        })
      regles_par_date[row["date"]] = regles_formatees

    # ---- Risque de panne J+1 ----
    risque_par_date = _risque_par_date(FactJournalier.objects.all(), FactArret.objects.all())

    # ---- Dérive thermique ----
    derive_par_date = {
      j.date: j.derive_thermique() for j in qs if j.conso_energie_kcalt is not None
    }

    evolution = []
    for _, row in df.iterrows():
      d_ts = row["date"]
      d_py = d_ts.date()
      anomalie_info = anomalies_par_date.get(d_ts, {"is_anomaly": False, "anomaly_score": None})
      derive_info = derive_par_date.get(d_py)
      evolution.append({
        "date": d_ts.strftime("%Y-%m-%d"),
        "production_t": _nombre_ou_none(row["production_totale_t"]),
        "debit_th": _nombre_ou_none(row["debit_th"]),
        "oee": _nombre_ou_none(row["trs_calc"]),
        "trg": _nombre_ou_none(row["trg"]),
        "disponibilite": _nombre_ou_none(row["disponibilite_globale"]),
        "taux_panne": _nombre_ou_none(row["taux_panne"]),
        "conso_energie": _nombre_ou_none(row["conso_energie_kcalt"]),
        # CORRIGÉ — "hm" était sélectionné dans la requête (utilisé pour
        # l'agrégat mensuel hm_moyen) mais jamais inclus dans le dict par
        # jour, donc absent de `evolution` — c'est ce qui faisait
        # disparaître les barres "Heures de Marche (HM)" du graphique
        # "Analyse des Pannes & Heures de Marche" côté frontend.
        "hm": _nombre_ou_none(row["hm"]),
        "is_anomaly": anomalie_info["is_anomaly"],
        "anomaly_score": anomalie_info["anomaly_score"],
        "criticite_pct": criticite_par_date.get(d_ts),
        "regles_declenchees": regles_par_date.get(d_ts, []),
        "risk_panne_j1": risque_par_date.get(d_ts),
        "out_of_sample": d_py >= CUTOFF_PREDICTIF,
        "derive_thermique": derive_info["ecart_pct"] if derive_info else None,
      })

    nb_anomalies = sum(1 for e in evolution if e["is_anomaly"])

    kpis = {
      "production_totale_t": _nombre_ou_none(df["production_totale_t"].sum()),
      "production_moyenne_t": _nombre_ou_none(df["production_totale_t"].mean()),
      "debit_moyen_th": _nombre_ou_none(df["debit_th"].mean()),
      "oee_moyen": _nombre_ou_none(df["trs_calc"].mean()),
      "trg_moyen": _nombre_ou_none(df["trg"].mean()),
      "disponibilite_moyenne": _nombre_ou_none(df["disponibilite_globale"].mean()),
      "taux_panne_moyen": _nombre_ou_none(df["taux_panne"].mean()),
      "conso_energie_moyenne": _nombre_ou_none(df["conso_energie_kcalt"].mean()),
      "hm_moyen": _nombre_ou_none(df["hm"].mean()),
      "nb_jours": int(len(df)),
      "nb_anomalies": nb_anomalies,
    }

    # ---- Alertes actives ----
    alertes = [
      {
        "date": a["date"],
        "type": f"seuil_{a['type']}" if not str(a["type"]).startswith("seuil_") else a["type"],
        "niveau": a["niveau"],
        "titre": a["titre"],
        "description": a["description"],
        "score": a.get("score"),
      }
      for a in generer_alertes_regles(FactJournalier.objects.all())
    ]
    alertes.sort(key=lambda a: a["date"], reverse=True)

    # ---- Agrégats mensuels ----
    df["mois_periode"] = df["date"].dt.to_period("M")
    arrets_df = pd.DataFrame.from_records(
      FactArret.objects.all().values("date_evenement", "duree_arret_h", "type_arret")
    )
    if not arrets_df.empty:
      arrets_df["date_evenement"] = pd.to_datetime(arrets_df["date_evenement"])
      arrets_df["mois_periode"] = arrets_df["date_evenement"].dt.to_period("M")

    monthly = []
    for periode, groupe in df.groupby("mois_periode"):
      mois_arrets = (
        arrets_df[arrets_df["mois_periode"] == periode] if not arrets_df.empty else pd.DataFrame()
      )
      pannes_mois = mois_arrets[mois_arrets["type_arret"] == "Panne"] if not mois_arrets.empty else pd.DataFrame()
      mttr_h = _nombre_ou_none(pannes_mois["duree_arret_h"].mean()) if not pannes_mois.empty else 0.0

      monthly.append({
        "mois": periode.start_time.strftime("%Y-%m-%d"),
        "mois_nom": periode.start_time.strftime("%B %Y"),
        "production_moyenne_t": _nombre_ou_none(groupe["production_totale_t"].mean()),
        "debit_moyen_th": _nombre_ou_none(groupe["debit_th"].mean()),
        "oee": _nombre_ou_none(groupe["trs_calc"].mean()),
        "trg": _nombre_ou_none(groupe["trg"].mean()),
        "disponibilite": _nombre_ou_none(groupe["disponibilite_globale"].mean()),
        "taux_panne": _nombre_ou_none(groupe["taux_panne"].mean()),
        "conso_energie": _nombre_ou_none(groupe["conso_energie_kcalt"].mean()),
        "jours_production": int(len(groupe)),
        "mttr_h": mttr_h or 0.0,
        "nb_pannes": int(len(mois_arrets)),
      })

    # ---- Définition complète des règles envoyées au frontend ----
    regles_definitions = [
      {
        "type": s.champ if str(s.champ).startswith("seuil_") else f"seuil_{s.champ}",
        "label": s.label,
        "sens": s.sens,
        "borne_orange": s.borne_orange,
        "borne_rouge": s.borne_rouge,
        "unite": s.unite,
        "conseil": s.conseil,
      }
      for s in seuils_explicables
    ]

    return Response({
      "kpis": kpis,
      "evolution": evolution,
      "alertes": alertes,
      "monthly": monthly,
      "cutoff_predictif": CUTOFF_PREDICTIF.strftime("%Y-%m-%d"),
      "seuil_criticite_pct": seuil_criticite_pct,
      "regles_definitions": regles_definitions,
    })


# =============================================================================
# GET /api/dashboard/pannes/  ->  PanneItem[]
# =============================================================================
class PannesListView(APIView):
    def get(self, request):
        qs = FactArret.objects.all().order_by("-date_evenement").values(
            "date_evenement", "equipement", "nature", "type_arret",
            "unite", "cause_precision", "duree_arret_h", "semaine",
        )
        resultat = [
            {
                "date": str(row["date_evenement"]),
                "equipement": row["equipement"],
                "nature": row["nature"],
                "type_arret": row["type_arret"],
                "unite": row["unite"],
                "cause": row["cause_precision"],
                "duree_h": round(row["duree_arret_h"], 4),
                "semaine": row["semaine"],
            }
            for row in qs
        ]
        return Response(resultat)


# =============================================================================
# GET /api/dashboard/equipment/  ->  EquipmentKPI[]
# =============================================================================
class EquipmentKPIView(APIView):
    def get(self, request):
        df = pd.DataFrame.from_records(
            FactArret.objects.all().values("equipement", "nature", "duree_arret_h")
        )
        if df.empty:
            return Response([])

        resultat = []
        for equipement, groupe in df.groupby("equipement"):
            by_nature = [
                {
                    "nature": nature,
                    "duree": round(float(sous_groupe["duree_arret_h"].sum()), 2),
                    "count": int(len(sous_groupe)),
                }
                for nature, sous_groupe in groupe.groupby("nature")
            ]
            by_nature.sort(key=lambda x: x["duree"], reverse=True)
            resultat.append({
                "equipement": equipement,
                "duree_totale_h": round(float(groupe["duree_arret_h"].sum()), 2),
                "occurrences": int(len(groupe)),
                "duree_moyenne_h": round(float(groupe["duree_arret_h"].mean()), 2),
                "by_nature": by_nature,
            })

        resultat.sort(key=lambda x: x["duree_totale_h"], reverse=True)
        return Response(resultat)


# =============================================================================
# GET /api/dashboard/energy/  ->  EnergyData[]
# =============================================================================
class EnergyListView(APIView):
        COUT_UNITAIRE_DH = {
            "ALL": 0.00012,  # MAD / kcal
            "GAZ": 3.102547,  # MAD / Nm3
            "GAZOLINE": 4059.729,  # MAD / T
            "FUEL": 4459.50,  # MAD / T
        }

        def get(self, request):
            qs = FactJournalier.objects.all().order_by("date")
            resultat = []
            for j in qs:
                derive = j.derive_thermique()
                production = j.production_totale_t

                impact_financier_dh = None
                if derive and production and j.conso_energie_kcalt is not None:
                    surplus_kcalt = j.conso_energie_kcalt - BASELINE_CONSO_ENERGIE_KCAL_T
                    impact_financier_dh = round(
                        surplus_kcalt * production * self.COUT_UNITAIRE_DH["ALL"], 0
                    )

                resultat.append({
                    "date": str(j.date),
                    "conso_energie_kcalt": _nombre_ou_none(j.conso_energie_kcalt),
                    "derive_thermique_pct": _nombre_ou_none(derive["ecart_pct"]) if derive else None,
                    "impact_financier_dh": _nombre_ou_none(impact_financier_dh),
                    "cs_gaz_nm3t": _nombre_ou_none(j.cs_gaz_nm3t),
                    "cs_gazoline_kgt": _nombre_ou_none(j.cs_gazoline_kgt),
                    "cs_fuel_kgt": _nombre_ou_none(j.cs_fuel_kgt),
                    "debit_th": _nombre_ou_none(j.debit_th),
                    "production_t": _nombre_ou_none(production),
                })
            return Response(resultat)


# =============================================================================
# GET /api/dashboard/energy/objectifs/  -> Objectifs énergétiques vs réalisé
# =============================================================================
# AJOUTÉ — CORRECTIF CRITIQUE : cette classe était importée par analytics/urls.py
# (`from .dashboard_api import ..., ObjectifsEnergetiquesView, ...`) mais
# n'existait nulle part dans ce fichier. Toute la configuration d'URLs de
# l'app échouait donc à l'import (ImportError), ce qui faisait retourner une
# page d'erreur Django 500 pour LITTÉRALEMENT TOUS les endpoints de l'API —
# pas seulement celui-ci. C'est la cause racine des graphiques vides sur
# plusieurs vues du frontend (Prédiction, Anomalies, Production...), pas un
# problème isolé à la vue Énergie.
class ObjectifsEnergetiquesView(APIView):
    """Compare la consommation énergétique réalisée à un objectif cible
    (baseline usine réduite d'une marge de progrès configurable)."""

    MARGE_PROGRES_PCT = 5.0  # objectif = baseline - 5% par défaut

    def get(self, request):
        try:
            marge_pct = float(request.query_params.get("marge_pct", self.MARGE_PROGRES_PCT))
        except (TypeError, ValueError):
            marge_pct = self.MARGE_PROGRES_PCT

        qs = FactJournalier.objects.exclude(conso_energie_kcalt__isnull=True)
        conso_moyenne = qs.aggregate(m=Avg("conso_energie_kcalt"))["m"]

        objectif_kcalt = BASELINE_CONSO_ENERGIE_KCAL_T * (1 - marge_pct / 100)
        ecart_vs_objectif_pct = None
        jours_sous_objectif = None
        if conso_moyenne is not None:
            ecart_vs_objectif_pct = round(
                (conso_moyenne - objectif_kcalt) / objectif_kcalt * 100, 2
            )
            jours_sous_objectif = qs.filter(conso_energie_kcalt__lte=objectif_kcalt).count()

        return Response({
            "baseline_kcalt": BASELINE_CONSO_ENERGIE_KCAL_T,
            "marge_progres_pct": marge_pct,
            "objectif_kcalt": round(objectif_kcalt, 1),
            "conso_moyenne_kcalt": _nombre_ou_none(conso_moyenne),
            "ecart_vs_objectif_pct": ecart_vs_objectif_pct,
            "jours_sous_objectif": jours_sous_objectif,
            "nb_jours_evalues": qs.count(),
        })


# =============================================================================
# GET /api/dashboard/energy/export/  -> Export CSV de l'impact financier
# =============================================================================
# AJOUTÉ — voir note de ObjectifsEnergetiquesView ci-dessus : même cause
# racine (ImportError bloquant toute l'API).
class ExportImpactEnergetiqueView(APIView):
    """Export CSV téléchargeable du détail journalier de l'impact financier
    énergétique (mêmes données que /dashboard/energy/, au format tableur)."""

    def get(self, request):
        import csv
        from django.http import HttpResponse

        qs = FactJournalier.objects.all().order_by("date")
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = "attachment; filename=impact_energetique.csv"
        writer = csv.writer(response)
        writer.writerow([
            "date", "conso_energie_kcalt", "derive_thermique_pct",
            "impact_financier_dh", "production_t",
        ])
        for j in qs:
            derive = j.derive_thermique()
            impact_financier_dh = None
            if derive and j.production_totale_t and j.conso_energie_kcalt is not None:
                surplus_kcalt = j.conso_energie_kcalt - BASELINE_CONSO_ENERGIE_KCAL_T
                impact_financier_dh = round(
                    surplus_kcalt * j.production_totale_t * EnergyListView.COUT_UNITAIRE_DH["ALL"], 0
                )
            writer.writerow([
                j.date,
                j.conso_energie_kcalt if j.conso_energie_kcalt is not None else "",
                round(derive["ecart_pct"], 2) if derive else "",
                impact_financier_dh if impact_financier_dh is not None else "",
                j.production_totale_t if j.production_totale_t is not None else "",
            ])
        return response


# =============================================================================
# GET /api/dashboard/pareto/  ->  ParetoItem[]
# =============================================================================
class ParetoView(APIView):
    def get(self, request):
        limite = int(request.query_params.get("limit", 15))
        agg = (
            FactArret.objects.values("cause_precision")
            .annotate(duree_totale_h=Sum("duree_arret_h"), occurrences=Count("id"))
            .order_by("-duree_totale_h")[:limite]
        )
        resultat = [
            {
                "cause": row["cause_precision"],
                "duree_totale_h": round(row["duree_totale_h"], 2),
                "occurrences": row["occurrences"],
            }
            for row in agg
        ]
        return Response(resultat)


# =============================================================================
# GET /api/dashboard/roi-predictif/?seuil=0.4&cout_horaire_dh=15000
# =============================================================================
class ROIPredictifView(APIView):
    """CORRIGÉ — le frontend (PredictionView.tsx, carte "Tonnage Préservé")
    a été mis à jour pour afficher un ROI en TONNAGE de production préservé
    plutôt qu'en gain financier (DH), et lit `roi.tonnage_preserve_t`,
    `roi.heures_evitees_h`, `roi.debit_moyen_th` — mais cette vue backend
    n'avait jamais été mise à jour en conséquence : ces trois champs
    n'existaient pas dans la réponse, donc `roi?.tonnage_preserve_t ?? 0`
    retombait systématiquement sur 0 côté React (la carte semblait figée).

    Formule (cf. note méthodologique du frontend) :
        heures_evitees_h  = nb_interventions_préventives × MTTR réel (h)
        tonnage_preserve_t = heures_evitees_h × débit moyen du sécheur (T/h)
    """

    COUT_HORAIRE_DEFAUT_DH = 15_000.0

    def get(self, request):
        try:
            seuil = float(request.query_params.get("seuil", 0.4))
        except (TypeError, ValueError):
            seuil = 0.4
        try:
            cout_horaire_dh = float(
                request.query_params.get("cout_horaire_dh", self.COUT_HORAIRE_DEFAUT_DH)
            )
        except (TypeError, ValueError):
            cout_horaire_dh = self.COUT_HORAIRE_DEFAUT_DH

        fact_qs = FactJournalier.objects.all()
        arret_qs = FactArret.objects.all()

        risque_par_date = _risque_par_date(fact_qs, arret_qs)
        mttr_reel_h = _mttr_reel_h(arret_qs)
        debit_moyen_th = _nombre_ou_none(
            fact_qs.exclude(debit_th__isnull=True).aggregate(m=Avg("debit_th"))["m"]
        )

        if not risque_par_date or mttr_reel_h is None:
            return Response({
                "seuil": seuil,
                "cout_horaire_dh": cout_horaire_dh,
                "mttr_moyen_h": None,
                "debit_moyen_th": debit_moyen_th,
                "nb_jours_risque_eleve": 0,
                "nb_interventions_preventives": 0,
                "heures_evitees_h": 0.0,
                "tonnage_preserve_t": 0.0,
                "gain_unitaire_dh": None,
                "gain_total_dh": 0.0,
                "cutoff_predictif": CUTOFF_PREDICTIF.strftime("%Y-%m-%d"),
                "methodologie": "Historique insuffisant pour calculer le ROI.",
            })

        dates_pannes = _dates_pannes_majeures(arret_qs)
        jours_a_risque = [
            d for d, r in risque_par_date.items()
            if r > seuil and d.date() >= CUTOFF_PREDICTIF
        ]
        jours_risque_sans_panne = [d for d in jours_a_risque if d not in dates_pannes]

        gain_unitaire_dh = mttr_reel_h * cout_horaire_dh
        gain_total_dh = len(jours_risque_sans_panne) * gain_unitaire_dh

        heures_evitees_h = len(jours_risque_sans_panne) * mttr_reel_h
        tonnage_preserve_t = heures_evitees_h * (debit_moyen_th or 0)

        return Response({
            "seuil": seuil,
            "cout_horaire_dh": cout_horaire_dh,
            "mttr_moyen_h": round(mttr_reel_h, 2),
            "debit_moyen_th": round(debit_moyen_th, 1) if debit_moyen_th else 0.0,
            "nb_jours_risque_eleve": len(jours_a_risque),
            "nb_interventions_preventives": len(jours_risque_sans_panne),
            "heures_evitees_h": round(heures_evitees_h, 1),
            "tonnage_preserve_t": round(tonnage_preserve_t, 0),
            "gain_unitaire_dh": round(gain_unitaire_dh, 2),
            "gain_total_dh": round(gain_total_dh, 2),
            "cutoff_predictif": CUTOFF_PREDICTIF.strftime("%Y-%m-%d"),
            "methodologie": (
                f"Tonnage préservé = {len(jours_risque_sans_panne)} intervention(s) préventive(s) "
                f"× MTTR réel ({mttr_reel_h:.2f}h) × débit moyen du sécheur "
                f"({debit_moyen_th:.0f} T/h) = {round(heures_evitees_h, 1)}h d'arrêt évitées "
                f"représentant {round(tonnage_preserve_t):,.0f} T de production préservée "
                f"(à partir du {CUTOFF_PREDICTIF.strftime('%d/%m/%Y')})."
            ),
        })


# =============================================================================
# GET /api/dashboard/jours-a-risque/?seuil=0.4
# =============================================================================
class JoursARisqueView(APIView):
    """CORRIGÉ — deux bugs qui rendaient cette vue inutilisable côté frontend
    (graphique "Évolution de la Probabilité de Panne J+1" vide) :

    1. `analyser_cause_jour_analogue(d_py, fact_qs, arret_qs)` appelait la
       fonction avec les arguments dans le MAUVAIS ORDRE — sa signature réelle
       (analytics/decision_matrix.py) est `(fact_qs, arret_qs, jour_cible,
       ...)`. `jour_cible` recevait donc un queryset au lieu d'une date, ce
       qui empêchait tout calcul valide.
    2. La réponse était renvoyée comme une LISTE BRUTE avec des noms de champs
       (`probabilite_panne`, `niveau_risque`, `score_similitude`,
       `jour_analogue_date`) qui ne correspondent pas à ce que le frontend
       attend (`JoursARisqueResponse.jours[]`, avec `risk`, `production_t`,
       `nature_probable`, `repartition_natures`, etc. — cf.
       src/types/index.ts::JourARisque). Le frontend fait `res.jours` sur
       une liste brute : `undefined`, d'où un graphique et une liste "Jours
       à Risque Élevé" totalement vides malgré une API qui répondait 200.
    """

    def get(self, request):
        try:
            seuil = float(request.query_params.get("seuil", 0.4))
        except (TypeError, ValueError):
            seuil = 0.4

        fact_qs = FactJournalier.objects.all()
        arret_qs = FactArret.objects.all()

        risque_par_date = _risque_par_date(fact_qs, arret_qs)
        production_par_date = {
            j.date: j.production_totale_t for j in fact_qs.only("date", "production_totale_t")
        }

        jours = [
            (d, r) for d, r in risque_par_date.items()
            if r > seuil and d.date() >= CUTOFF_PREDICTIF
        ]
        jours.sort(key=lambda item: item[0])

        resultat = []
        for d_ts, risk in jours:
            d_py = d_ts.date()
            # Ordre d'arguments corrigé : (fact_qs, arret_qs, jour_cible).
            analyse = analyser_cause_jour_analogue(fact_qs, arret_qs, d_py)
            resultat.append({
                "date": d_ts.strftime("%Y-%m-%d"),
                "risk": round(risk, 4),
                "production_t": _nombre_ou_none(production_par_date.get(d_py)),
                "nature_probable": analyse.get("nature_probable"),
                "equipement_probable": analyse.get("equipement_probable"),
                "cause_probable": analyse.get("cause_probable", "Cause non déterminée"),
                "action_recommandee": analyse.get(
                    "action_recommandee", "Inspecter la chaîne de production"
                ),
                "repartition_natures": analyse.get("repartition_natures", []),
                "nb_evenements_analyses": analyse.get("nb_evenements_analyses", 0),
                "fenetre_debut": analyse.get("fenetre_debut", str(FENETRE_REFERENCE_DEBUT)),
                "fenetre_fin": analyse.get("fenetre_fin", str(FENETRE_REFERENCE_FIN)),
                "jours_analogues": analyse.get("jours_analogues", []),
            })

        return Response({
            "seuil": seuil,
            "cutoff_predictif": CUTOFF_PREDICTIF.strftime("%Y-%m-%d"),
            "fenetre_reference_debut": str(FENETRE_REFERENCE_DEBUT),
            "fenetre_reference_fin": str(FENETRE_REFERENCE_FIN),
            "jours": resultat,
        })