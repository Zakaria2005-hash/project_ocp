export interface KPIData {
  production_totale_t: number;
  production_moyenne_t: number;
  debit_moyen_th: number;
  oee_moyen: number | null;
  trg_moyen: number | null;
  disponibilite_moyenne: number | null;
  taux_panne_moyen: number | null;
  conso_energie_moyenne: number | null;
  hm_moyen: number;
  nb_jours: number;
  nb_anomalies: number;
}

export interface DailyEvolution {
  date: string;
  production_t: number | null;
  debit_th: number | null;
  oee: number | null;
  trg: number | null;
  disponibilite: number | null;
  taux_panne: number | null;
  conso_energie: number | null;
  is_anomaly: boolean;
  anomaly_score: number | null;
  // Indice de criticité 0-100% (score IsolationForest inversé + redimensionné
  // sur tout l'historique) — 100% = jour le plus anormal connu. À utiliser
  // pour l'affichage (axe Y, tri) à la place du score brut anomaly_score,
  // qui est négatif pour les anomalies dans la convention scikit-learn et
  // donc trompeur visuellement (voir analytics/dashboard_api.py).
  criticite_pct: number | null;
  // Règles métier explicites déclenchées ce jour (avec leur niveau de
  // sévérité atteint) — liste vide + is_anomaly=true => anomalie
  // "multifactorielle" (l'IA voit une combinaison inhabituelle qu'aucun
  // seuil simple ne capture seul).
  regles_declenchees: { type: string; niveau: "orange" | "rouge" }[];
  risk_panne_j1: number | null;
  // True si ce jour fait partie de la période de prévision réelle
  // hors-échantillon (>= cutoff_predictif) — cf. DashboardData.cutoff_predictif.
  out_of_sample: boolean;
  derive_thermique: number | null;
}

export interface RegleDefinition {
  type: string;
  label: string;
  sens: "bas" | "haut";
  borne_orange: number;
  borne_rouge: number;
  unite: string;
  conseil: string;
}

export interface AlertItem {
  date: string;
  type: string;
  description?: string;
  details?: string;
  niveau?: string;
  suspicion?: string;
  titre?: string;
  score?: number;
}

export interface MonthlyKPI {
  mois: string;
  mois_nom: string;
  production_moyenne_t: number;
  debit_moyen_th: number;
  oee: number | null;
  trg: number | null;
  disponibilite: number | null;
  taux_panne: number | null;
  conso_energie: number | null;
  jours_production: number;
  mttr_h: number;
  nb_pannes: number;
}

export interface DashboardData {
  kpis: KPIData;
  evolution: DailyEvolution[];
  alertes: AlertItem[];
  monthly: MonthlyKPI[];
  // Date (YYYY-MM-DD) à partir de laquelle risk_panne_j1 est une vraie
  // prédiction hors-échantillon — cf. analytics/dashboard_api.py::CUTOFF_PREDICTIF.
  cutoff_predictif: string;
  // Position (0-100%) du seuil de décision de l'Isolation Forest sur
  // l'échelle de criticité — null si aucune anomalie n'a pu être calculée.
  seuil_criticite_pct: number | null;
  regles_definitions: RegleDefinition[];
}

export interface PanneItem {
  date: string;
  equipement: string;
  nature: string;
  type_arret: string;
  unite: string;
  cause: string;
  duree_h: number;
  semaine: number | null;
}

export interface EquipmentKPI {
  equipement: string;
  duree_totale_h: number;
  occurrences: number;
  duree_moyenne_h: number;
  by_nature: { nature: string; duree: number; count: number }[];
}

export interface EnergyData {
  date: string;
  conso_energie_kcalt: number | null;
  derive_thermique_pct: number | null;
  baseline_kcalt : number | null;
  // Impact financier estimé du jour, en DH — positif = surcoût (dérive vs
  // baseline), négatif = économie réalisée. Calculé côté backend, cf.
  // analytics/dashboard_api.py::EnergyListView (prix moyen estimé, à
  // ajuster avec le coût contractuel réel du site).
  impact_financier_dh: number | null;
  // Baseline (objectif kcal/T) effectivement utilisée pour ce jour — celle
  // du mois si un objectif spécifique a été fixé (cf. ObjectifEnergetique
  // côté backend), sinon la baseline usine par défaut (160 000 kcal/T).
  cs_gaz_nm3t: number | null;
  cs_gazoline_kgt: number | null;
  cs_fuel_kgt: number | null;
  debit_th: number | null;
  production_t: number | null;
}

export interface ParetoItem {
  cause: string;
  duree_totale_h: number;
  occurrences: number;
}

// Réponse de GET /dashboard/roi-predictif/?seuil=...&cout_horaire_dh=...
// Calculée côté backend (voir analytics/dashboard_api.py::ROIPredictifView) :
// MTTR mesuré sur l'historique réel FactArret, pas une constante frontend.
export interface RoiPredictif {
  seuil: number;
  mttr_moyen_h: number | null;
  debit_moyen_th: number;
  nb_jours_risque_eleve: number;
  nb_interventions_preventives: number;
  heures_evitees_h: number;
  tonnage_preserve_t: number;
  cutoff_predictif: string;
  methodologie: string;
}

// Un jour de la VRAIE période de prévision (hors-échantillon) classé à
// risque élevé, enrichi par la matrice de décision "Cause probable -> Action"
// (analytics/decision_matrix.py). nature_probable / equipement_probable /
// cause_probable sont déduits des jours "analogues" de ce jour précis (les
// jours de la période de référence 2026-01-08 → 2026-05-31 dont les
// conditions opérationnelles ressemblent le plus aux siennes) — la
// recommandation varie donc d'un jour à l'autre, sans jamais s'appuyer sur
// un arrêt survenu pendant la période de prévision elle-même.
export interface JourARisque {
  date: string;
  risk: number;
  production_t: number | null;
  nature_probable: string | null;
  equipement_probable: string | null;
  cause_probable: string;
  action_recommandee: string;
  repartition_natures: { name: string; value: number }[];
  nb_evenements_analyses: number;
  fenetre_debut: string;
  fenetre_fin: string;
  // Dates (YYYY-MM-DD) des jours de la période de référence les plus
  // similaires à ce jour en conditions opérationnelles — cf.
  // analytics/decision_matrix.py::analyser_cause_jour_analogue. C'est sur
  // ces jours précis (jamais sur juin) que la recommandation est basée.
  jours_analogues: string[];
}

// Réponse de GET /dashboard/jours-a-risque/?seuil=...
export interface JoursARisqueResponse {
  seuil: number;
  cutoff_predictif: string;
  fenetre_reference_debut: string;
  fenetre_reference_fin: string;
  jours: JourARisque[];
}

// Réponse de GET /dashboard/energy/objectifs/?marge_pct=...
// (analytics/dashboard_api.py::ObjectifsEnergetiquesView)
export interface ObjectifsEnergetiques {
  baseline_kcalt: number;
  marge_progres_pct: number;
  objectif_kcalt: number;
  conso_moyenne_kcalt: number | null;
  // Écart de la consommation moyenne réalisée vs l'objectif — négatif =
  // sous l'objectif (bonne performance), positif = au-dessus (dépassement).
  ecart_vs_objectif_pct: number | null;
  jours_sous_objectif: number | null;
  nb_jours_evalues: number;
}