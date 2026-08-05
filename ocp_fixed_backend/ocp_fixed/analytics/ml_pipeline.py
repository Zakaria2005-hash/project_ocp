"""
================================================================================
  analytics/ml_pipeline.py — Moteur d'Intelligence Artificielle OCP Séchage
                              (VERSION CORRIGÉE)
================================================================================
Ce module contient les 3 pipelines prédictifs et analytiques du système :

  1. AnomalyDetector      — Isolation Forest (non-supervisé) pour la détection
                             de dérives process et énergétiques sur Juin 2026.
  2. PannePredictor       — HistGradientBoosting (supervisé) pour la prédiction
                             de pannes à J+1 basée sur l'historique Jan-Juin.
  3. FluxDigitalTwin      — Simulation différentielle de la balance des masses
                             (stocks amont/aval) avec alertes de saturation.

Corrections apportées par rapport à la version précédente :

  1. BUG CRITIQUE — accent incorrect : `nature__in=['Mécanique', 'Électrique']`
     ne matchait JAMAIS les pannes électriques, car la valeur réellement
     stockée en base est "Electrique" (sans accent — cf. données sources et
     maintenance/models.py::NATURE_CHOICES). Toutes les pannes électriques
     étaient donc invisibles pour le modèle prédictif ET pour les agrégats
     MTBF/MTTR. Corrigé partout (build_features, _build_features_with_django_agg).

  2. CODE MORT BUGUÉ : `build_features()` utilisait `models_Count`/
     `models_Sum` sans les avoir importés dans son propre scope (ils
     n'étaient importés que localement dans `train_and_evaluate`, qui ne
     l'appelle même pas). Cette méthode était un doublon non utilisé de
     `_build_features_with_django_agg` — supprimée pour éviter toute
     confusion et le risque de NameError si jamais appelée.

  3. `FluxDigitalTwin.simulate()` : le message d'alerte ORANGE estimait un
     "temps avant saturation" même quand le flux net était négatif (silos
     en décroissance), ce qui produisait un message trompeur. Corrigé :
     le message dépend désormais du signe du flux net.
================================================================================
"""
import logging
import os
from datetime import timedelta
import random
import joblib
import pandas as pd
from django.db.models import Count, Sum
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger("analytics.ml_pipeline")

# noinspection SpellCheckingInspection
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trained_models")
os.makedirs(MODEL_DIR, exist_ok=True)

# CORRECTION : valeur réelle stockée en base (voir maintenance/models.py
# FactArret.NATURE_CHOICES et les données sources — pas d'accent sur "E").
NATURES_PANNES_MAJEURES = ["Mécanique", "Electrique" , "Exploitation"]


def _formatter_date(valeur) -> str:
    """Formate une date en "YYYY-MM-DD" quel que soit son type réel
    (datetime.date, pandas.Timestamp, ou déjà une chaîne).

    CORRECTION DÉFENSIVE : dans l'implémentation actuelle, les dates issues
    de Django (`queryset.values(...)` -> `pd.DataFrame(records)`) restent
    des `datetime.date` bruts, dont `str(...)` donne déjà "YYYY-MM-DD" sans
    heure — vérifié empiriquement, donc aucune alerte n'est perdue
    aujourd'hui. MAIS si `prepare_data()` est un jour modifié pour appliquer
    `pd.to_datetime()` sur la colonne (par exemple pour faire de
    l'arithmétique de dates), `str(...)` produirait alors "YYYY-MM-DD
    00:00:00" (un pandas.Timestamp), ce qui casserait silencieusement la
    comparaison de chaînes dans `alertes_recentes()`. Cette fonction rend
    le comportement correct INDÉPENDAMMENT du type interne, au lieu de
    reposer sur un invariant implicite.
    """
    if hasattr(valeur, "strftime"):
        return valeur.strftime("%Y-%m-%d")
    return str(valeur).split(" ")[0]


# =============================================================================
# 1. DÉTECTION D'ANOMALIES & DÉRIVES ÉNERGÉTIQUES (Isolation Forest)
# =============================================================================
class AnomalyDetector:
    """Détection d'anomalies non-supervisée (Isolation Forest).

    Repère les jours où la consommation énergétique dévie anormalement du
    débit de production — suspicion d'encrassement du sécheur ou de fuite
    thermique.
    """

    def __init__(self, contamination=0.1, random_state=42):
        self.model = IsolationForest(
            contamination=contamination, random_state=random_state, n_estimators=200
        )
        self.scaler = StandardScaler()
        self.feature_cols = [
            "debit_th", "production_totale_t", "trs_calc", "taux_panne",
            "hm", "perte_vitesse", "a_maint_subie_h",
        ]

    def prepare_data(self, queryset):
        records = list(queryset.values("date", *self.feature_cols))
        df = pd.DataFrame(records)
        if df.empty:
            return df
        df = df.dropna(subset=self.feature_cols)
        # CORRECTION : exclut les jours d'arrêt total (hm=0, ex. arrêt externe
        # documenté du 1er au 18 juin dans les données réelles). Sans ce
        # filtre, ~60% des jours de juin sont à zéro partout, ce qui rend la
        # distribution bimodale (arrêt vs. production) : Isolation Forest
        # apprend alors "zéro" comme un régime normal et se met à signaler
        # les JOURS DE PRODUCTION comme anormaux par contraste — l'inverse de
        # l'objectif (détecter une dérive PENDANT la marche normale). Les
        # arrêts sont déjà tracés et expliqués par FactArret ; ce n'est pas
        # le rôle de ce détecteur de les re-signaler.
        df = df[df["hm"] > 0]
        return df

    def fit_predict(self, queryset):
        df = self.prepare_data(queryset)
        if df.empty:
            logger.warning("Aucune donnée disponible pour la détection d'anomalies.")
            return df

        X = self.scaler.fit_transform(df[self.feature_cols])
        df = df.copy()
        df["anomaly_label"] = self.model.fit_predict(X)
        df["anomaly_score"] = self.model.decision_function(X)

        joblib.dump(self.model, os.path.join(MODEL_DIR, "isolation_forest.pkl"))
        joblib.dump(self.scaler, os.path.join(MODEL_DIR, "anomaly_scaler.pkl"))

        n_anomalies = (df["anomaly_label"] == -1).sum()
        logger.info(f"Détection terminée : {n_anomalies} anomalies sur {len(df)} jours.")
        return df

    def get_alerts(self, queryset):
        df = self.fit_predict(queryset)
        if df.empty:
            return []

        anomalies = df[df["anomaly_label"] == -1].sort_values("anomaly_score")
        alerts = []
        for _, row in anomalies.iterrows():
            date_str = _formatter_date(row["date"])
            alerts.append({
                "date": date_str,
                "niveau": "ORANGE",
                "type": "Dérive Process / Énergie",
                "score": round(row["anomaly_score"], 4),
                "details": (
                    f"Jour {date_str} — Anomalie détectée. "
                    f"Débit: {row['debit_th']:.1f} T/H, "
                    f"Production: {row['production_totale_t']:.0f} T, "
                    f"OEE: {row['trs_calc']:.3f}, "
                    f"Taux Panne: {row['taux_panne']:.3f}. "
                    f"Suspicion : encrassement interne du tube sécheur ou fuite thermique."
                ),
            })
        return alerts


# =============================================================================
# 1bis. EFFICIENCE ÉNERGÉTIQUE — Corrélation Débit / Consommation (Pilier 3)
# =============================================================================
class EfficienceEnergetique:
    """Pilier 3 — Suivi de l'efficience énergétique.

    Modélise la relation entre le débit de production (T/H) et la
    consommation spécifique (kcal/T) via une régression linéaire, puis
    détecte les jours où la consommation réelle s'écarte anormalement de
    la courbe attendue (perte de rendement énergétique / fuite thermique).

    Complète FactJournalier.derive_thermique(), qui compare uniquement à
    une baseline fixe (160 000 kcal/T) sans tenir compte du régime de
    production du jour : à débit élevé, une conso. plus haute est normale.
    Ici, l'écart est mesuré par rapport à ce que la régression prédit
    POUR CE DÉBIT précis, ce qui est un signal plus fin.
    """

    def __init__(self, seuil_ecart_type=2.0):
        self.model = LinearRegression()
        self.seuil_ecart_type = seuil_ecart_type
        self.residual_std_ = None
        self.feature_col = "debit_th"
        self.target_col = "conso_energie_kcalt"

    def prepare_data(self, queryset):
        records = list(queryset.values("date", self.feature_col, self.target_col))
        df = pd.DataFrame(records)
        if df.empty:
            return df
        df = df.dropna(subset=[self.feature_col, self.target_col])
        # Exclut les jours à débit nul (four à l'arrêt) : ils n'ont pas leur
        # place dans une régression débit -> conso, et fausseraient la pente.
        df = df[df[self.feature_col] > 0]
        return df

    def fit(self, queryset):
        df = self.prepare_data(queryset)
        if len(df) < 10:
            logger.warning("Historique insuffisant pour la régression débit/énergie (< 10 jours).")
            return None

        X = df[[self.feature_col]].values
        y = df[self.target_col].values

        self.model.fit(X, y)
        y_pred = self.model.predict(X)
        residuals = y - y_pred
        self.residual_std_ = residuals.std() or 1.0
        r2 = self.model.score(X, y)

        joblib.dump(self.model, os.path.join(MODEL_DIR, "efficience_energetique.pkl"))

        df = df.copy()
        df["conso_prevue_kcalt"] = y_pred
        df["ecart_kcalt"] = residuals
        df["ecart_type_score"] = residuals / self.residual_std_

        logger.info(
            f"Régression débit/énergie ajustée — R²={r2:.3f}, "
            f"pente={self.model.coef_[0]:.2f} kcal/T par T/H."
        )
        return {
            "df": df,
            "r2": r2,
            "pente_kcalt_par_th": float(self.model.coef_[0]),
            "ordonnee_origine": float(self.model.intercept_),
        }

    def get_alerts(self, queryset):
        """Jours dont l'écart à la courbe attendue dépasse le seuil (en
        écarts-types des résidus) — utilisé par l'endpoint dédié
        /efficience-energetique/ pour une analyse complète de l'historique.
        """
        resultat = self.fit(queryset)
        if resultat is None:
            return []

        df = resultat["df"]
        anomalies = df[df["ecart_type_score"].abs() >= self.seuil_ecart_type].sort_values(
            "ecart_type_score", key=abs, ascending=False
        )

        alerts = []
        for _, row in anomalies.iterrows():
            row: pd.Series  # aide les analyseurs statiques à typer `row` correctement
            date_str = _formatter_date(row["date"])
            sens = "surconsommation" if row["ecart_type_score"] > 0 else "sous-consommation"
            niveau = "ROUGE" if abs(row["ecart_type_score"]) >= self.seuil_ecart_type * 1.5 else "ORANGE"
            alerts.append({
                "date": date_str,
                "niveau": niveau,
                "type": "Perte de rendement énergétique",
                "score": round(float(row["ecart_type_score"]), 2),
                "details": (
                    f"Jour {date_str} — {sens} détectée par rapport à la courbe "
                    f"débit/énergie attendue. Débit: {row['debit_th']:.1f} T/H, "
                    f"conso. réelle: {row['conso_energie_kcalt']:.0f} kcal/T, "
                    f"conso. attendue: {row['conso_prevue_kcalt']:.0f} kcal/T "
                    f"(écart: {row['ecart_kcalt']:+.0f} kcal/T). "
                    f"Suspicion : encrassement du sécheur ou fuite thermique."
                ),
            })
        return alerts

    def alertes_recentes(self, queryset, n_derniers_jours=3):
        """Version "temps réel" de get_alerts() : ajuste la régression sur
        TOUT l'historique disponible (pour une courbe robuste), mais ne
        remonte une alerte que si l'un des `n_derniers_jours` est en
        dérive — utilisé par LiveAlertsView.

        CORRECTION : get_alerts() seul renvoyait systématiquement TOUTES
        les dérives détectées sur les 6 mois d'historique à chaque appel,
        ce qui n'a pas de sens pour un écran "temps réel" (un jour de
        dérive survenu en janvier n'est plus une alerte pertinente en
        juillet).
        """
        toutes_les_alertes = self.get_alerts(queryset)
        if not toutes_les_alertes:
            return []

        dates_disponibles = sorted(
            d.isoformat() if hasattr(d, "isoformat") else str(d)
            for d in queryset.values_list("date", flat=True)
        )
        if not dates_disponibles:
            return []
        dates_recentes = set(dates_disponibles[-n_derniers_jours:])

        return [a for a in toutes_les_alertes if a["date"] in dates_recentes]

    def courbe(self, queryset):
        """Points (débit, conso réelle, conso prévue par la régression) pour
        tracer la courbe débit/énergie côté Power BI / dashboard.
        """
        resultat = self.fit(queryset)
        if resultat is None:
            return {"error": "Historique insuffisant pour calculer la courbe débit/énergie."}

        df = resultat["df"]
        points = df[
            ["date", self.feature_col, self.target_col, "conso_prevue_kcalt", "ecart_type_score"]
        ].copy()
        points["date"] = points["date"].astype(str)

        qualite = "bonne" if resultat["r2"] > 0.5 else "faible"
        return {
            "r2": round(resultat["r2"], 4),
            "pente_kcalt_par_th": round(resultat["pente_kcalt_par_th"], 2),
            "ordonnee_origine": round(resultat["ordonnee_origine"], 2),
            "interpretation": (
                f"Pour chaque T/H de débit supplémentaire, la consommation "
                f"spécifique attendue varie de {resultat['pente_kcalt_par_th']:+.1f} "
                f"kcal/T. R²={resultat['r2']:.3f} — {qualite} corrélation linéaire "
                f"entre débit et consommation spécifique."
            ),
            "points": points.to_dict(orient="records"),
        }


# =============================================================================
# 2. PRÉDICTION DE PANNES À J+1 (Apprentissage Supervisé)
# =============================================================================
class PannePredictor:
    """Classification supervisée pour la prédiction de pannes majeures à J+1.

    Cible : 1 si une panne mécanique/électrique de durée > 0.5h survient
    dans les 24h suivantes. Entraîné sur Janvier-Mai, évalué sur Juin par
    défaut (cutoff configurable dans train_and_evaluate).
    """

    def __init__(self, random_state=42):
        # CORRECTION — déséquilibre des classes : ~19% de jours avec panne
        # J+1 dans l'historique. Sans class_weight, HistGradientBoosting
        # optimise l'accuracy globale et finit par ne jamais prédire la
        # classe minoritaire (F1=0 malgré un ROC AUC correct). class_weight
        # "balanced" repondère les erreurs sur la classe rare.
        self.model = HistGradientBoostingClassifier(
            max_iter=300, max_depth=5, learning_rate=0.05,
            random_state=random_state, class_weight="balanced",
        )
        self.feature_cols = []
        # Seuil de décision par défaut ; recalculé (et sauvegardé) à chaque
        # entraînement pour maximiser le F1 plutôt que de garder 0.5, qui
        # n'a de sens que pour des classes équilibrées.
        self.seuil_decision = 0.5

    @staticmethod
    def _meilleur_seuil(y_true, y_proba):
        """Seuil de décision qui maximise le F1-score sur les probabilités
        données, au lieu du seuil par défaut 0.5 — indispensable avec des
        classes déséquilibrées (cf. correction class_weight ci-dessus).
        """
        from sklearn.metrics import precision_recall_curve

        if len(set(y_true)) < 2:
            return 0.5
        precisions, recalls, thresholds = precision_recall_curve(y_true, y_proba)
        if len(thresholds) == 0:
            return 0.5
        f1_scores = 2 * (precisions[:-1] * recalls[:-1]) / (precisions[:-1] + recalls[:-1] + 1e-9)
        return float(thresholds[f1_scores.argmax()])

    def _build_features(self, fact_qs, arret_qs, pour_entrainement: bool = True):
        """Construit le dataset de features + cible 'panne_j1'.

        pour_entrainement=True  (défaut, utilisé par train_and_evaluate et
            cross_validate) : filtre les jours d'arrêt total (hm=0), non
            pertinents pour ENTRAÎNER un modèle de risque de panne.
        pour_entrainement=False (utilisé par predict_tomorrow) : garde TOUS
            les jours, y compris un arrêt total, car prédire "demain" a
            besoin de l'état RÉEL du dernier jour connu — même si l'usine
            est à l'arrêt ce jour-là. Sans cette dissociation, si le tout
            dernier jour calendaire est un jour d'arrêt (ex. l'arrêt externe
            documenté du 1er au 18 juin), il serait retiré et
            predict_tomorrow s'appuierait sur un jour opérationnel vieux
            d'une semaine, avec une date et un contexte erronés.
        """
        base_cols = [
            "date", "production_totale_t", "debit_th", "hm",
            "trs_calc", "taux_panne", "a_maint_subie_h",
            "perte_vitesse", "temps_ouverture_h",
        ]
        records = list(fact_qs.values(*base_cols))
        df = pd.DataFrame(records)
        if df.empty:
            return df
        df = df.sort_values("date").reset_index(drop=True)

        for col in base_cols[1:]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df[col] = df[col].fillna(df[col].median())

        pannes_agg = (
            arret_qs
            .filter(nature__in=NATURES_PANNES_MAJEURES)
            .values("date_evenement")
            .annotate(nb_pannes=Count("id"), duree_totale=Sum("duree_arret_h"))
        )
        pannes_df = pd.DataFrame(list(pannes_agg))
        if not pannes_df.empty:
            pannes_df = pannes_df.rename(columns={"date_evenement": "date"})
            df = df.merge(pannes_df, on="date", how="left")
        else:
            df["nb_pannes"] = 0
            df["duree_totale"] = 0.0

        df["nb_pannes"] = df["nb_pannes"].fillna(0)
        df["duree_totale"] = df["duree_totale"].fillna(0.0)

        # Cible : panne majeure à J+1.
        # CORRECTION — biais du dernier jour : pour la toute dernière ligne
        # de la série, duree_totale.shift(-1) vaut NaN (le lendemain n'existe
        # pas encore). En pandas, "NaN > 0.5" s'évalue directement à False
        # (pas NaN) : panne_j1 valait donc 0 pour ce jour par CONSTRUCTION,
        # une étiquette fabriquée plutôt qu'observée — le modèle "apprenait"
        # que le dernier jour connu n'est jamais suivi d'une panne. On trace
        # explicitement quelles lignes ont une cible réellement connue
        # (`cible_connue`), pour que train_and_evaluate()/cross_validate()
        # excluent cette dernière ligne de tout entraînement/évaluation. Ce
        # n'est pas gênant pour predict_tomorrow(), qui n'utilise que les
        # features de cette ligne et jamais panne_j1.
        duree_j1 = df["duree_totale"].shift(-1)
        df["cible_connue"] = duree_j1.notna()
        df["panne_j1"] = (duree_j1 > 0.5).astype(int)

        for lag in [1, 2, 3]:
            df[f"taux_panne_lag{lag}"] = df["taux_panne"].shift(lag)
            df[f"hm_lag{lag}"] = df["hm"].shift(lag)
            df[f"debit_lag{lag}"] = df["debit_th"].shift(lag)

        df["hm_cumul"] = df["hm"].cumsum()
        df["taux_panne_ma7"] = df["taux_panne"].rolling(window=7, min_periods=1).mean()
        df = df.dropna(subset=[c for c in df.columns if c != "cible_connue"]).reset_index(drop=True)

        if pour_entrainement:
            # CORRECTION — cohérence juin : un arrêt externe documenté (manque
            # d'expédition, FactArret "Externe") couvre le 1er au 18 juin dans
            # l'historique réel, soit ~60% du mois à zéro sur toutes les
            # features. Ces jours sont retirés APRÈS le calcul des lags/rolling
            # (pour ne pas casser leur continuité temporelle), car prédire un
            # "risque de panne mécanique/électrique" un jour où l'usine est
            # arrêtée n'a pas de sens et biaiserait le modèle vers "features à
            # zéro => aucun risque", ce qui est trompeur pour les phases de
            # redémarrage (précisément les moments à risque réel).
            # -- Uniquement pour l'entraînement (cf. docstring ci-dessus).
            df = df[df["hm"] > 0].reset_index(drop=True)

        self.feature_cols = [
            "production_totale_t", "debit_th", "hm", "trs_calc",
            "taux_panne", "a_maint_subie_h", "perte_vitesse",
            "nb_pannes", "duree_totale", "hm_cumul", "taux_panne_ma7",
            "taux_panne_lag1", "taux_panne_lag2", "taux_panne_lag3",
            "hm_lag1", "hm_lag2", "hm_lag3",
            "debit_lag1", "debit_lag2", "debit_lag3",
        ]
        return df

    def train_and_evaluate(self, fact_qs, arret_qs, cutoff_date):
        """Entraîne sur les données avant `cutoff_date`, évalue après."""
        from sklearn.inspection import permutation_importance
        from sklearn.metrics import classification_report, confusion_matrix

        df = self._build_features(fact_qs, arret_qs)
        if df.empty:
            return {"error": "Aucune donnée disponible."}

        # CORRECTION : la colonne cible_connue (calculée dans
        # _build_features) était déjà tracée mais jamais exploitée ici —
        # la dernière ligne de la série avait donc une étiquette
        # panne_j1=0 FABRIQUÉE (le lendemain n'existe pas encore) qui
        # polluait silencieusement l'entraînement ET l'évaluation. On
        # l'exclut désormais explicitement des deux.
        df = df[df["cible_connue"]].reset_index(drop=True)
        if df.empty:
            return {"error": "Aucune ligne avec cible connue (historique trop court)."}

        train = df[df["date"] < cutoff_date]
        test = df[df["date"] >= cutoff_date]

        if train.empty or test.empty:
            logger.error("Données insuffisantes pour l'entraînement ou le test.")
            return {"error": "Données insuffisantes"}

        X_train, y_train = train[self.feature_cols], train["panne_j1"]
        X_test, y_test = test[self.feature_cols], test["panne_j1"]

        self.model.fit(X_train, y_train)
        y_proba = (
            self.model.predict_proba(X_test)[:, 1]
            if hasattr(self.model, "predict_proba") else None
        )

        # CORRECTION — déséquilibre des classes : seuil de décision optimisé
        # (maximise le F1) calculé sur le TRAIN, appliqué au TEST, plutôt que
        # le seuil par défaut 0.5 qui, avec ~19% de positifs, fait que le
        # modèle ne prédit jamais la classe minoritaire (F1=0 constaté avant
        # cette correction, malgré un ROC AUC correct).
        if y_proba is not None:
            y_proba_train = self.model.predict_proba(X_train)[:, 1]
            self.seuil_decision = self._meilleur_seuil(y_train, y_proba_train)
            y_pred = (y_proba >= self.seuil_decision).astype(int)
        else:
            y_pred = self.model.predict(X_test)

        joblib.dump(self.model, os.path.join(MODEL_DIR, "panne_predictor.pkl"))
        joblib.dump(self.seuil_decision, os.path.join(MODEL_DIR, "panne_predictor_seuil.pkl"))

        # labels=[0, 1] fixés explicitement : évite un UserWarning et une
        # forme de matrice ambiguë quand une seule classe est présente dans
        # y_test (cas fréquent avec un historique de pannes encore court).
        report = classification_report(
            y_test, y_pred, labels=[0, 1], output_dict=True, zero_division=0
        )
        cm = confusion_matrix(y_test, y_pred, labels=[0, 1]).tolist()

        test_results = test[["date", "panne_j1"]].copy()
        test_results["prediction"] = y_pred
        if y_proba is not None:
            test_results["probabilite_panne"] = y_proba
        test_results["date"] = test_results["date"].astype(str)

        # CORRECTION : HistGradientBoostingClassifier n'expose PAS
        # `feature_importances_` (contrairement à RandomForestClassifier),
        # ce qui provoquait un AttributeError à chaque appel de cet
        # endpoint. Remplacé par une importance par permutation (calculée
        # sur le jeu de test), méthode agnostique au type de modèle.
        try:
            perm = permutation_importance(
                self.model, X_test, y_test, n_repeats=10, random_state=42, n_jobs=-1
            )
            importances = dict(zip(self.feature_cols, perm.importances_mean.tolist()))
        except Exception as exc:
            logger.warning(f"Importance par permutation indisponible : {exc}")
            importances = {}

        results = {
            "classification_report": report,
            "confusion_matrix": cm,
            "feature_importances": importances,
            "predictions_test": test_results.to_dict(orient="records"),
            "nb_train": len(train),
            "nb_test": len(test),
            "seuil_decision_utilise": round(self.seuil_decision, 4),
        }
        logger.info(
            f"Modèle entraîné — Train: {len(train)} jours, Test: {len(test)} jours. "
            f"Accuracy: {report.get('accuracy', 0):.2%}"
        )
        return results

    def cross_validate(self, fact_qs, arret_qs, n_splits=4):
        """Validation croisée temporelle (TimeSeriesSplit).

        Un simple split train/test sur un historique court (comme dans
        train_and_evaluate, testé sur juin seul) peut donner une accuracy
        trompeuse si le mois de test ne contient qu'une classe (ex. aucune
        panne majeure). TimeSeriesSplit évalue le modèle sur plusieurs
        découpages chronologiques successifs — chaque fold entraîne sur le
        passé et teste sur une période future, jamais l'inverse — pour une
        estimation plus honnête de la performance réelle.
        """
        from sklearn.metrics import f1_score, roc_auc_score
        from sklearn.model_selection import TimeSeriesSplit

        df = self._build_features(fact_qs, arret_qs)
        # CORRECTION : même exclusion que dans train_and_evaluate — la
        # dernière ligne de la série a une cible fabriquée (0 par défaut,
        # pas observée), qui fausserait chaque fold où elle apparaît côté
        # test (et parfois côté train).
        df = df[df["cible_connue"]].reset_index(drop=True)

        if df.empty or len(df) < (n_splits + 1) * 5:
            return {
                "error": (
                    f"Historique insuffisant pour {n_splits} folds temporels "
                    f"(minimum recommandé : {(n_splits + 1) * 5} jours exploitables, "
                    f"disponible : {len(df)})."
                )
            }

        X = df[self.feature_cols].values
        y = df["panne_j1"].values

        tscv = TimeSeriesSplit(n_splits=n_splits)
        scores = []
        for fold, (train_idx, test_idx) in enumerate(tscv.split(X), start=1):
            X_train, X_test = X[train_idx], X[test_idx]
            y_train, y_test = y[train_idx], y[test_idx]

            if len(set(y_train)) < 2:
                scores.append({
                    "fold": fold, "n_train": len(X_train), "n_test": len(X_test),
                    "roc_auc": None, "f1": None,
                    "note": "Une seule classe dans le train de ce fold — non entraînable.",
                })
                continue

            fold_model = HistGradientBoostingClassifier(
                max_iter=300, max_depth=5, learning_rate=0.05,
                random_state=42, class_weight="balanced",
            )
            fold_model.fit(X_train, y_train)
            y_proba_train = fold_model.predict_proba(X_train)[:, 1]
            seuil_fold = self._meilleur_seuil(y_train, y_proba_train)

            fold_result = {"fold": fold, "n_train": len(X_train), "n_test": len(X_test)}
            if len(set(y_test)) > 1:
                y_proba_test = fold_model.predict_proba(X_test)[:, 1]
                y_pred = (y_proba_test >= seuil_fold).astype(int)
                fold_result["roc_auc"] = round(float(roc_auc_score(y_test, y_proba_test)), 3)
            else:
                y_proba_test = fold_model.predict_proba(X_test)[:, 1]
                y_pred = (y_proba_test >= seuil_fold).astype(int)
                fold_result["roc_auc"] = None
            fold_result["seuil_decision"] = round(seuil_fold, 3)
            fold_result["f1"] = round(float(f1_score(y_test, y_pred, zero_division=0)), 3)
            scores.append(fold_result)

        aucs = [s["roc_auc"] for s in scores if s.get("roc_auc") is not None]
        f1s = [s["f1"] for s in scores if s.get("f1") is not None]

        logger.info(
            f"Validation croisée temporelle terminée — {len(scores)} folds, "
            f"ROC AUC moyen: {round(sum(aucs) / len(aucs), 3) if aucs else 'N/A'}"
        )
        return {
            "n_splits_demandes": n_splits,
            "details_par_fold": scores,
            "roc_auc_moyen": round(sum(aucs) / len(aucs), 3) if aucs else None,
            "f1_moyen": round(sum(f1s) / len(f1s), 3) if f1s else None,
            "note": (
                "Chaque fold entraîne sur le passé et teste sur une période future "
                "uniquement — évite la fuite d'information propre aux séries "
                "temporelles. À privilégier sur train_and_evaluate pour un rapport "
                "de stage : la métrique est moins optimiste mais plus fiable."
            ),
        }

    def predict_tomorrow(self, fact_qs, arret_qs):
        """Prédit le risque de panne pour le jour suivant le dernier connu."""
        model_path = os.path.join(MODEL_DIR, "panne_predictor.pkl")
        seuil_path = os.path.join(MODEL_DIR, "panne_predictor_seuil.pkl")
        if not os.path.exists(model_path):
            return {"error": "Modèle non encore entraîné. Lancez train_and_evaluate()."}

        model = joblib.load(model_path)
        # CORRECTION — utilise le seuil optimisé (F1) sauvegardé lors du
        # dernier entraînement plutôt que le seuil par défaut 0.5 de
        # model.predict(), inadapté à des classes déséquilibrées.
        seuil = joblib.load(seuil_path) if os.path.exists(seuil_path) else 0.5

        df = self._build_features(fact_qs, arret_qs, pour_entrainement=False)
        if df.empty:
            return {"error": "Aucune donnée disponible."}

        last_row = df.iloc[[-1]]
        X = last_row[self.feature_cols]
        proba = model.predict_proba(X)[0][1] if hasattr(model, "predict_proba") else None
        pred = int(proba >= seuil) if proba is not None else int(model.predict(X)[0])

        last_date = last_row["date"].iloc[0]
        tomorrow = last_date + timedelta(days=1) if hasattr(last_date, "day") else "N/A"

        proba_pct = f"{proba:.1%}" if proba is not None else "N/A"
        return {
            "date_prediction": str(tomorrow),
            "risque_panne": bool(pred),
            "probabilite": round(float(proba), 4) if proba is not None else None,
            "seuil_decision": round(seuil, 4),
            "niveau": "ROUGE" if pred == 1 else "VERT",
            "message": (
                f"ALERTE : Risque de panne mécanique/électrique majeure détecté "
                f"pour {tomorrow} (probabilité : {proba_pct})."
                if pred == 1 else
                f"Fonctionnement nominal prévu pour {tomorrow}."
            ),
        }


# =============================================================================
# 3. JUMEAU NUMÉRIQUE DE FLUX (Simulation Différentielle)
# =============================================================================
class FluxDigitalTwin:
    """Simulateur de la balance des masses du site de séchage.

    Paramètres industriels fixes intégrés :
    - Mode discret : Train fixe de 3 500 T toutes les 4h.
    - Cadence nominale trains (mode continu) : 150 T/h.
    - Monte-Carlo : Perturbations appliquées uniquement sur le débit de production
      et les retards de trains (jitter d'arrivée).
    """

    def _simuler_coeur(self, stock_amont_t, debit_fours_th, stock_aval_t,
                       capacite_silos_t, cadence_trains_th=150.0, horizon_h=24,
                       mode_trains="discret", train_capacite_t=3500.0,
                       train_intervalle_h=4, pauses=None, retard_trains_h=None):
        pauses = pauses or []
        retard_trains_h = retard_trains_h or {}  # Dict {heure_prévue: dictionnaire de décalage}

        # Cadence équivalente pour le calcul du flux net théorique
        debit_evac_moyen = (
            train_capacite_t / max(train_intervalle_h, 1e-6)
            if mode_trains == "discret" else cadence_trains_th
        )
        flux_net = debit_fours_th - debit_evac_moyen

        trajectoire = []
        alertes = []
        evenements = []
        saturation_heure = None
        rupture_heure = None
        rupture_amont_heure = None

        stock_aval_courant = float(stock_aval_t)
        stock_amont_courant = float(stock_amont_t)

        for h in range(horizon_h + 1):
            # 1. Pauses de maintenance
            en_pause = any(p["debut_h"] <= h < p["debut_h"] + p["duree_h"] for p in pauses)
            if any(p["debut_h"] == h for p in pauses):
                evenements.append({
                    "heure": h,
                    "type": "pause_debut",
                    "detail": "Début de pause programmée (maintenance)."
                })
            if any(p["debut_h"] + p["duree_h"] == h for p in pauses):
                evenements.append({
                    "heure": h,
                    "type": "pause_fin",
                    "detail": "Fin de pause programmée."
                })

            # 2. Production horaire
            if h == 0:
                production_h = 0.0
            else:
                debit_effectif = 0.0 if en_pause else debit_fours_th
                production_h = min(debit_effectif, stock_amont_courant)

            stock_amont_courant = max(0.0, stock_amont_courant - production_h)
            stock_aval_intermediaire = stock_aval_courant + production_h

            # 3. Évacuation (Gestion des trains fixes de 3500T / 4h + retards éventuels)
            evacuation_h = 0.0
            if mode_trains == "discret":
                # Vérifie si un train programmé (ou retardé) arrive à l'heure h
                train_du_jour = False
                if train_intervalle_h > 0 and h > 0:
                    for h_theorique in range(train_intervalle_h, horizon_h + 1, train_intervalle_h):
                        retard = retard_trains_h.get(h_theorique, 0)
                        if h == (h_theorique + retard):
                            train_du_jour = True
                            break

                if train_du_jour:
                    # Capacité fixe à 3 500 T
                    evacuation_h = min(train_capacite_t, stock_aval_intermediaire)
                    evenements.append({
                        "heure": h,
                        "type": "train",
                        "detail": f"Train évacue {evacuation_h:.0f} T"
                                  + (" (chargement partiel)" if evacuation_h < train_capacite_t else ""),
                    })
            else:
                if h > 0:
                    evacuation_h = min(cadence_trains_th, stock_aval_intermediaire)

            # 4. Actualisation des stocks
            stock_aval_courant = max(0.0, stock_aval_intermediaire - evacuation_h)
            taux_remplissage = (stock_aval_courant / capacite_silos_t) * 100.0 if capacite_silos_t > 0 else 0.0
            flux_actuel = production_h - evacuation_h

            # 5. Statuts et Alertes
            statut = "VERT"

            if taux_remplissage >= 95.0:
                statut = "ROUGE"
                if saturation_heure is None:
                    saturation_heure = h
                    alertes.append({
                        "heure": h,
                        "niveau": "ROUGE",
                        "message": f"ALERTE CRITIQUE SATURATION AVAL : silos saturés à H+{h}.",
                    })
            elif taux_remplissage >= 80.0:
                statut = "ORANGE"
                if h == 0 or (len(trajectoire) > 0 and trajectoire[-1]["statut"] != "ORANGE"):
                    alertes.append({
                        "heure": h,
                        "niveau": "ORANGE",
                        "message": f"Taux de remplissage silos élevé ({taux_remplissage:.0f}%).",
                    })

            if stock_amont_courant <= 0.0 and rupture_amont_heure is None:
                rupture_amont_heure = h
                statut = "ROUGE"
                alertes.append({
                    "heure": h,
                    "niveau": "ROUGE",
                    "message": f"RUPTURE D'ALIMENTATION : stock amont épuisé à H+{h}.",
                })

            if stock_aval_courant <= 0.0 and rupture_heure is None and h > 0:
                rupture_heure = h
                if statut != "ROUGE":
                    statut = "ORANGE"
                alertes.append({
                    "heure": h,
                    "niveau": "ROUGE",
                    "message": f"ALERTE RUPTURE STOCK AVAL : silos vides à H+{h}.",
                })

            # 6. Point de trajectoire
            point = {
                "heure": h,
                "stock_amont_t": round(stock_amont_courant, 1),
                "stock_aval_t": round(stock_aval_courant, 1),
                "taux_remplissage_pct": round(taux_remplissage, 1),
                "production_h": round(production_h, 1),
                "evacuation_h": round(evacuation_h, 1),
                "statut": statut,
                "en_pause": en_pause,
            }
            trajectoire.append(point)

        return {
            "trajectoire": trajectoire,
            "alertes": alertes,
            "evenements": evenements,
            "saturation_heure": saturation_heure,
            "rupture_heure": rupture_heure,
            "rupture_amont_heure": rupture_amont_heure,
            "flux_net": flux_net,
        }

    def _monte_carlo(self, n_iterations, aleas_pct, seed, **kwargs_coeur):
        rng = random.Random(seed)
        n_iterations = max(1, min(int(n_iterations), 500))
        marge = aleas_pct / 100.0

        def perturber(v):
            return max(v * (1 + rng.uniform(-marge, marge)), 0.0)

        horizon_h = kwargs_coeur["horizon_h"]
        train_intervalle_h = kwargs_coeur.get("train_intervalle_h", 4)
        toutes_trajectoires = []
        nb_saturations = 0
        nb_ruptures = 0
        nb_ruptures_amont = 0
        heures_saturation = []
        heures_rupture = []

        for _ in range(n_iterations):
            params_tires = dict(kwargs_coeur)

            # 1. Perturbation Uniquement du Débit de Production
            params_tires["debit_fours_th"] = perturber(kwargs_coeur["debit_fours_th"])

            # Stock amont et capacités restent STRICTEMENT FIXES
            params_tires["stock_amont_t"] = kwargs_coeur["stock_amont_t"]
            params_tires["train_capacite_t"] = 3500.0
            params_tires["cadence_trains_th"] = 150.0

            # 2. Perturbation Uniquement des Retards de Trains (Jitter en heures)
            retard_trains = {}
            if kwargs_coeur.get("mode_trains") == "discret":
                for h_th in range(train_intervalle_h, horizon_h + 1, train_intervalle_h):
                    # Génère un retard aléatoire (ex: entre 0 et 2 heures selon aleas_pct)
                    max_retard = round(train_intervalle_h * marge)
                    retard_trains[h_th] = rng.randint(0, max(1, max_retard)) if max_retard > 0 else 0

            params_tires["retard_trains_h"] = retard_trains

            resultat = self._simuler_coeur(**params_tires)
            toutes_trajectoires.append(resultat["trajectoire"])

            if resultat["saturation_heure"] is not None:
                nb_saturations += 1
                heures_saturation.append(resultat["saturation_heure"])
            if resultat["rupture_heure"] is not None:
                nb_ruptures += 1
                heures_rupture.append(resultat["rupture_heure"])
            if resultat["rupture_amont_heure"] is not None:
                nb_ruptures_amont += 1

        bande = []
        for h in range(horizon_h + 1):
            vals_aval = [t[h]["stock_aval_t"] for t in toutes_trajectoires]
            vals_amont = [t[h]["stock_amont_t"] for t in toutes_trajectoires]
            vals_taux = [t[h]["taux_remplissage_pct"] for t in toutes_trajectoires]
            bande.append({
                "heure": h,
                "stock_aval_min": round(min(vals_aval), 1),
                "stock_aval_moyen": round(sum(vals_aval) / len(vals_aval), 1),
                "stock_aval_max": round(max(vals_aval), 1),
                "stock_amont_moyen": round(sum(vals_amont) / len(vals_amont), 1),
                "taux_min": round(min(vals_taux), 1),
                "taux_moyen": round(sum(vals_taux) / len(vals_taux), 1),
                "taux_max": round(max(vals_taux), 1),
            })

        return {
            "bande": bande,
            "probabilite_saturation_pct": round(100 * nb_saturations / n_iterations, 1),
            "probabilite_rupture_pct": round(100 * nb_ruptures / n_iterations, 1),
            "probabilite_rupture_amont_pct": round(100 * nb_ruptures_amont / n_iterations, 1),
            "heure_saturation_moyenne": round(sum(heures_saturation) / len(heures_saturation),
                                              1) if heures_saturation else None,
            "heure_rupture_moyenne": round(sum(heures_rupture) / len(heures_rupture), 1) if heures_rupture else None,
            "n_iterations": n_iterations,
        }

    def simulate(self, stock_amont_t, debit_fours_th, stock_aval_t,
                 capacite_silos_t, cadence_trains_th=150.0, horizon_h=24,
                 mode_trains="discret", train_capacite_t=3500.0,
                 train_intervalle_h=4, pauses=None,
                 aleas=False, aleas_pct=10.0, n_iterations=200, seed=42):
        pauses = pauses or []

        # Application stricte des paramètres fixes
        coeur_kwargs = dict(
            stock_amont_t=stock_amont_t,
            debit_fours_th=debit_fours_th,
            stock_aval_t=stock_aval_t,
            capacite_silos_t=capacite_silos_t,
            cadence_trains_th=150.0,  # Fixe à 150 T/h
            horizon_h=horizon_h,
            mode_trains=mode_trains,
            train_capacite_t=3500.0,  # Fixe à 3 500 T
            train_intervalle_h=4,  # Fixe toutes les 4h
            pauses=pauses,
        )

        resultat_central = self._simuler_coeur(**coeur_kwargs)
        flux_net = resultat_central["flux_net"]
        saturation_heure = resultat_central["saturation_heure"]
        rupture_heure = resultat_central["rupture_heure"]
        rupture_amont_heure = resultat_central["rupture_amont_heure"]

        suggestion = None
        plan_action = []

        if saturation_heure is not None and flux_net > 0:
            seuil_critique_t = 0.95 * capacite_silos_t
            marge_t = max(seuil_critique_t - stock_aval_t, 0)
            debit_max_tenable = 150.0 + marge_t / horizon_h if horizon_h else 150.0

            suggestion = f"Pour éviter la saturation à H+{saturation_heure}, ajustez le débit fours à ~{debit_max_tenable:.0f} T/h."
            plan_action = [
                {
                    "titre": "Réduire le débit des fours",
                    "description": f"Ajustez le débit de production à ~{debit_max_tenable:.0f} T/h.",
                    "parametre": "debit_fours_th",
                    "valeur_actuelle": round(debit_fours_th, 1),
                    "valeur_suggeree": round(max(debit_max_tenable, 0), 1),
                }
            ]
        if mode_trains == "discret":
            mode_str = f"Train discret ({train_capacite_t} T / {train_intervalle_h}h)"
        else:
            mode_str = f"Évacuation continue ({cadence_trains_th} T/h)"
        reponse = {
            "mode": "monte_carlo" if aleas else "deterministe",
            "parametres": {
                "stock_amont_initial_t": stock_amont_t,
                "debit_fours_th": debit_fours_th,
                "stock_aval_initial_t": stock_aval_t,
                "capacite_silos_t": capacite_silos_t,
                "cadence_trains_th": 150.0,
                "horizon_h": horizon_h,
                "flux_net_th": round(flux_net, 2),
                "mode_trains": mode_trains,
                "train_capacite_t": 3500.0,
                "train_intervalle_h": 4,
                "pauses": pauses,
            },
            "trajectoire": resultat_central["trajectoire"],
            "evenements": resultat_central["evenements"],
            "alertes": resultat_central["alertes"],
            "saturation_prevue_h": saturation_heure,
            "rupture_prevue_h": rupture_heure,
            "rupture_amont_prevue_h": rupture_amont_heure,
            "suggestion": suggestion,
            "plan_action": plan_action,
            "resume": (
                f"Simulation sur {horizon_h}h ({mode_str}). Flux net: {flux_net:.1f} T/h. "
            ),
        }

        if aleas:
            mc = self._monte_carlo(n_iterations, aleas_pct, seed, **coeur_kwargs)
            reponse["bande"] = mc["bande"]
            reponse["probabilite_saturation_pct"] = mc["probabilite_saturation_pct"]
            reponse["probabilite_rupture_pct"] = mc["probabilite_rupture_pct"]
            reponse["probabilite_rupture_amont_pct"] = mc["probabilite_rupture_amont_pct"]
            reponse["n_iterations"] = mc["n_iterations"]
            reponse["resume"] += (
                f" Monte-Carlo ({mc['n_iterations']} tirages, ±{aleas_pct:.0f}% sur prod/retards) : "
                f"Prob. Saturation {mc['probabilite_saturation_pct']:.0f}%, "
                f"Prob. Rupture {mc['probabilite_rupture_pct']:.0f}%."
            )

        return reponse