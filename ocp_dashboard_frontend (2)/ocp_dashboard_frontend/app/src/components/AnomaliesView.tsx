import { useMemo, useState } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ZAxis,
  Cell,
  ReferenceLine,
} from "recharts";
import { AlertTriangle, ShieldCheck, Activity, Cpu, Sparkles, Filter, CheckCircle2, Info } from "lucide-react";
import type { DashboardData, RegleDefinition } from "@/types";

// NOUVEAU — le backend a connu plusieurs noms de champs successifs pour ces
// valeurs (rétro-compatibilité) ; ces champs ne sont pas déclarés dans
// DailyEvolution mais peuvent exister à l'exécution. On les type
// explicitement plutôt que de passer par `any`, pour garder la sécurité de
// type sur les vrais champs tout en autorisant ces alternatives connues.
interface ChampsBackendHerites {
  criticite?: number;
  score_criticite?: number;
  score_isolation_forest?: number;
  production?: number;
}

// Une "règle déclenchée" affichée peut venir soit de
// DailyEvolution.regles_declenchees (`{ type, niveau }`), soit, en repli, de
// AlertItem (`{ type, niveau?, description?, ... }`) — ni l'un ni l'autre ne
// déclare `champ`/`severity`, que certaines réponses backend renvoient
// néanmoins ; on les type ici en optionnels plutôt qu'en `any`.
interface RegleAffichee {
  type?: string;
  champ?: string;
  niveau?: string;
  severity?: string;
}

interface Props {
  data: DashboardData;
}

const DEFAULT_REGLES_FIXES: RegleDefinition[] = [
  { type: "seuil_debit_th", label: "Débit horaire", sens: "bas", borne_orange: 250.0, borne_rouge: 150.0, unite: "T/h", conseil: "vérifier l'alimentation amont et l'état des fours" },
  { type: "seuil_production_totale_t", label: "Tonnage (production)", sens: "bas", borne_orange: 4000.0, borne_rouge: 2000.0, unite: "T", conseil: "vérifier s'il s'agit d'un arrêt planifié ou d'une sous-performance" },
  { type: "seuil_trs_calc", label: "OEE", sens: "bas", borne_orange: 0.60, borne_rouge: 0.45, unite: "%", conseil: "analyser la répartition des pertes (arrêts, cadence, qualité)" },
  { type: "seuil_taux_panne", label: "Taux de panne", sens: "haut", borne_orange: 0.05, borne_rouge: 0.10, unite: "%", conseil: "anticiper une intervention de maintenance corrective" },
  { type: "seuil_trg", label: "TRG", sens: "bas", borne_orange: 0.65, borne_rouge: 0.50, unite: "%", conseil: "vérifier les arrêts planifiés et les baisses de charge externes" },
  { type: "seuil_humidite_sortie_mc_pct", label: "Humidité sortie MC", sens: "haut", borne_orange: 0.04, borne_rouge: 0.05, unite: "%", conseil: "risque de sous-séchage — ajuster la température ou le temps de séjour" },
  { type: "seuil_humidite_sortie_mp_pct", label: "Humidité sortie MP", sens: "haut", borne_orange: 0.06, borne_rouge: 0.07, unite: "%", conseil: "risque de sous-séchage — ajuster la température ou le temps de séjour" },
  { type: "seuil_hm", label: "Heures de marche (HM)", sens: "bas", borne_orange: 20.0, borne_rouge: 16.0, unite: "h/24h", conseil: "vérifier la disponibilité des fours et la cause des arrêts" },
  { type: "seuil_conso_energie_kcalt", label: "Consommation énergétique", sens: "haut", borne_orange: 168000.0, borne_rouge: 184000.0, unite: "kcal/T", conseil: "suspicion d'encrassement interne du tube sécheur ou de fuite thermique" },
];

function formatLabelRegle(unite: string, valeur: number): string {
  if (unite === "%") {
    const val = valeur <= 1.0 ? valeur * 100 : valeur;
    return `${val.toFixed(0)}%`;
  }
  return `${valeur.toLocaleString("fr-FR")} ${unite}`;
}

export default function AnomaliesView({ data }: Props) {
  const { evolution = [], seuil_criticite_pct = 50, regles_definitions = [], alertes = [] } = data ?? {};
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const reglesDefinitionsEffectives =
    Array.isArray(regles_definitions) && regles_definitions.length > 0
      ? regles_definitions
      : DEFAULT_REGLES_FIXES;

  const months = [...new Set(evolution.map((e) => e.date?.slice(0, 7)).filter(Boolean))].sort();

  const filteredEvolution = useMemo(() => {
    return (selectedMonth === "all" ? evolution : evolution.filter((e) => e.date?.startsWith(selectedMonth)))
      .map((e) => {
        let criticite = e.criticite_pct ?? (e as ChampsBackendHerites).criticite ?? (e as ChampsBackendHerites).score_criticite;

        if (criticite == null || isNaN(Number(criticite))) {
          const rawScore = (e as ChampsBackendHerites).score_isolation_forest ?? e.anomaly_score;
          if (rawScore != null && !isNaN(Number(rawScore))) {
            criticite = Math.min(100, Math.max(0, (0.5 - Number(rawScore)) * 100));
          } else {
            criticite = e.is_anomaly ? 85 : 20;
          }
        }

        return {
          ...e,
          criticite_pct: Number(criticite),
          production_t: Number(e.production_t || (e as ChampsBackendHerites).production || 0),
          is_anomaly: Boolean(e.is_anomaly),
        };
      });
  }, [evolution, selectedMonth]);

  const anomalyPoints = useMemo(() => {
    return filteredEvolution.map((e) => {
      const reglesJour = Array.isArray(e.regles_declenchees) && e.regles_declenchees.length > 0
        ? e.regles_declenchees
        : alertes.filter((a) => a.date === e.date);

      return {
        x: e.date,
        y: e.criticite_pct,
        z: e.production_t > 0 ? e.production_t : 100,
        isAnomaly: e.is_anomaly,
        production: e.production_t,
        conso: e.conso_energie,
        regles: reglesJour,
      };
    });
  }, [filteredEvolution, alertes]);

  const selectedPoint = useMemo(() => {
    if (!selectedDate) return null;
    return anomalyPoints.find((p) => p.x === selectedDate) ?? null;
  }, [selectedDate, anomalyPoints]);

  const reglesActives = useMemo(() => {
    const map = new Map<string, string>();
    if (selectedPoint?.regles && Array.isArray(selectedPoint.regles)) {
      (selectedPoint.regles as RegleAffichee[]).forEach((r) => {
        if (!r) return;
        const rawType = String(r.type || r.champ || "");
        const keyWithPrefix = rawType.startsWith("seuil_") ? rawType : `seuil_${rawType}`;
        const keyWithoutPrefix = rawType.replace(/^seuil_/, "");
        const niveau = r.niveau || r.severity || "rouge";

        map.set(keyWithPrefix, niveau);
        map.set(keyWithoutPrefix, niveau);
      });
    }
    return map;
  }, [selectedPoint]);

  const estMultifactorielle = useMemo(() => {
    if (!selectedPoint) return false;
    return selectedPoint.isAnomaly && reglesActives.size === 0;
  }, [selectedPoint, reglesActives]);

  const criticiteMax = useMemo(() => {
    if (filteredEvolution.length === 0) return null;
    const valeurs = filteredEvolution
      .map((e) => e.criticite_pct)
      .filter((v) => typeof v === "number" && !isNaN(v));
    return valeurs.length > 0 ? Math.max(...valeurs) : 0;
  }, [filteredEvolution]);

  const handlePointClick = (dateStr: string) => {
    setSelectedDate((prev) => (prev === dateStr ? null : dateStr));
  };

  return (
    <div className="space-y-6 font-sans">
      {/* En-tête de section style OCP Industrial Intelligence */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-display font-extrabold tracking-tight flex items-center gap-3">
            Détection Avancée d'Anomalies
          </h2>
          <p className="text-emerald-100/70 text-sm mt-1 max-w-xl">
            Modélisation hybride combinant l'algorithme non-supervisé <span className="text-amber-300 font-medium">Isolation Forest</span> et les <span className="text-amber-300 font-medium">règles métier procédé</span>.
          </p>
        </div>

        {/* Dynamic Month Selector */}
        <div className="relative z-10 flex items-center gap-2 bg-emerald-950/60 p-1.5 rounded-xl border border-emerald-700/50 backdrop-blur-md">
          <Filter className="h-4 w-4 text-amber-400 ml-2" />
          <select
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value);
              setSelectedDate(null);
            }}
            className="px-3 py-1.5 rounded-lg border-0 text-sm bg-transparent text-emerald-50 font-medium focus:ring-2 focus:ring-emerald-500 cursor-pointer"
          >
            <option value="all" className="bg-emerald-950 text-emerald-50">Toutes les périodes</option>
            {months.map((m) => (
              <option key={m} value={m} className="bg-emerald-950 text-emerald-50">
                {new Date(m + "-01").toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Cartes KPI - Style Glassmorphism & Émeraude */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="group relative bg-white rounded-2xl p-5 border border-slate-100/80 shadow-[0_2px_20px_-6px_rgba(15,23,42,0.08)] hover:shadow-[0_10px_28px_-6px_rgba(4,120,87,0.18)] transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-rose-500" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Anomalies détectées</p>
              <h4 className="text-2xl font-display font-extrabold text-slate-900 mt-1 tabular-nums">
                {filteredEvolution.filter((e) => e.is_anomaly).length}
              </h4>
              <p className="text-xs text-rose-500 font-medium mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Exige un suivi procédé
              </p>
            </div>
            <div className="p-2.5 bg-rose-50 border border-rose-100 rounded-xl group-hover:scale-105 transition-transform duration-300">
              <AlertTriangle className="h-5 w-5 text-rose-600" />
            </div>
          </div>
        </div>

        <div className="group relative bg-white rounded-2xl p-5 border border-slate-100/80 shadow-[0_2px_20px_-6px_rgba(15,23,42,0.08)] hover:shadow-[0_10px_28px_-6px_rgba(4,120,87,0.18)] transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-amber-500" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Criticité Maximale</p>
              <h4 className="text-2xl font-display font-extrabold text-slate-900 mt-1 tabular-nums">
                {criticiteMax !== null ? `${criticiteMax.toFixed(0)}%` : "N/A"}
              </h4>
              <p className="text-xs text-amber-600 font-medium mt-1">
                Score d'instabilité maximal
              </p>
            </div>
            <div className="p-2.5 bg-amber-50 border border-amber-100 rounded-xl group-hover:scale-105 transition-transform duration-300">
              <ShieldCheck className="h-5 w-5 text-amber-600" />
            </div>
          </div>
        </div>

        <div className="group relative bg-white rounded-2xl p-5 border border-slate-100/80 shadow-[0_2px_20px_-6px_rgba(15,23,42,0.08)] hover:shadow-[0_10px_28px_-6px_rgba(4,120,87,0.18)] transition-all duration-300 overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-emerald-600" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Taux d'Anomalie Global</p>
              <h4 className="text-2xl font-display font-extrabold text-slate-900 mt-1 tabular-nums">
                {((filteredEvolution.filter((e) => e.is_anomaly).length / Math.max(filteredEvolution.length, 1)) * 100).toFixed(1)}%
              </h4>
              <p className="text-xs text-emerald-600 font-medium mt-1 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Basé sur le volume capturé
              </p>
            </div>
            <div className="p-2.5 bg-emerald-50 border border-emerald-100 rounded-xl group-hover:scale-105 transition-transform duration-300">
              <Activity className="h-5 w-5 text-emerald-700" />
            </div>
          </div>
        </div>
      </div>

      {/* Conteneur Graphique Principal + Légende WOW */}
      <div className="bg-white rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-lg font-display font-bold text-slate-900 flex items-center gap-2">
              <Activity className="h-5 w-5 text-emerald-600" />
              Matrice de Criticité Procédé vs Production Tonnage
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Cliquez sur une bulle pour mapper l'anomalie avec les règles métriques
            </p>
          </div>

          {selectedDate && (
            <button
              onClick={() => setSelectedDate(null)}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-semibold transition-all flex items-center gap-1.5 shadow-sm"
            >
              <span>← Réinitialiser filtre ({new Date(selectedDate).toLocaleDateString("fr-FR")})</span>
            </button>
          )}
        </div>

        {/* LÉGENDE DU GRAPHIQUE COMPLÈTE & STYLISÉE */}
        <div className="bg-slate-50/80 rounded-xl p-3.5 border border-slate-200/60 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-6 flex-wrap">
            <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px]">Légende :</span>

            {/* Point Normal */}
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 border border-emerald-600 inline-block shadow-sm" />
              <span className="text-slate-600 font-medium">Fonctionnement Normal</span>
            </div>

            {/* Point Anormal */}
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-full bg-rose-500 border border-rose-600 inline-block shadow-sm animate-pulse" />
              <span className="text-slate-700 font-semibold">Anomalie Procédé</span>
            </div>

            {/* Ligne de criticité */}
            <div className="flex items-center gap-2">
              <span className="w-6 h-0.5 bg-rose-500 border-t border-dashed border-rose-500 inline-block" />
              <span className="text-slate-600 font-medium">Seuil de Criticité ({seuil_criticite_pct}%)</span>
            </div>
          </div>

          {/* Indicateur Taille bulle */}
          <div className="flex items-center gap-2 text-slate-500 bg-white px-3 py-1 rounded-lg border border-slate-200 shadow-2xs">
            <span className="w-2 h-2 rounded-full bg-slate-400" />
            <span className="w-3.5 h-3.5 rounded-full bg-slate-400" />
            <span className="font-medium text-slate-600">Taille bulle = Tonnage Production (T)</span>
          </div>
        </div>

        {/* Graphique Scatter Plot */}
        <div className="pt-2">
          <ResponsiveContainer width="100%" height={380}>
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="x"
                tickFormatter={(v) => {
                  if (!v) return "";
                  const d = new Date(v);
                  return isNaN(d.getTime()) ? v : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
                }}
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <YAxis
                dataKey="y"
                name="Criticité"
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <ZAxis dataKey="z" range={[80, 500]} name="Production" />

              {seuil_criticite_pct !== null && (
                <ReferenceLine
                  y={seuil_criticite_pct}
                  stroke="#f43f5e"
                  strokeDasharray="5 5"
                  strokeWidth={1.5}
                  label={{ value: `Seuil Critique (${seuil_criticite_pct}%)`, fill: "#e11d48", fontSize: 11, position: "insideTopLeft", fontWeight: 600 }}
                />
              )}

              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    return (
                      <div className="bg-emerald-950/95 backdrop-blur-md text-white p-3.5 rounded-xl shadow-xl border border-emerald-800/50 text-xs space-y-1.5 min-w-[180px]">
                        <p className="font-bold text-emerald-400 text-sm border-b border-slate-700 pb-1">
                          {new Date(data.x).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long" })}
                        </p>
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">Criticité:</span>
                          <span className="font-bold text-rose-400">{data.y.toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">Production:</span>
                          <span className="font-bold text-slate-200">{data.production.toLocaleString()} T</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-400">Statut:</span>
                          <span className={`font-bold ${data.isAnomaly ? "text-rose-400" : "text-emerald-400"}`}>
                            {data.isAnomaly ? "Anomalie Détectée" : "Normal"}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />

              <Scatter data={anomalyPoints} name="Jours">
                {anomalyPoints.map((entry, index) => {
                  const isSelected = entry.x === selectedDate;
                  const isAnomaly = entry.isAnomaly;

                  return (
                    <Cell
                      key={`cell-${index}`}
                      onClick={() => handlePointClick(entry.x)}
                      className="transition-all duration-300 cursor-pointer"
                      fill={isAnomaly ? "#f43f5e" : "#10b981"}
                      fillOpacity={isSelected ? 1 : isAnomaly ? 0.85 : 0.45}
                      stroke={isSelected ? "#0d9488" : isAnomaly ? "#be123c" : "#059669"}
                      strokeWidth={isSelected ? 3.5 : 1}
                    />
                  );
                })}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Grille des Règles Métier Procédé */}
      <div className="bg-white rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-slate-900 flex items-center gap-2">
              <Cpu className="h-5 w-5 text-emerald-600" />
              Analyse Diagnostique des Règles Procédé
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {selectedDate ? (
                <span className="text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-200 inline-block font-medium">
                  Matrice évaluée pour le jour : <strong>{new Date(selectedDate).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</strong>
                </span>
              ) : (
                "Sélectionnez un point dans le graphique supérieur pour activer l'analyse instantanée."
              )}
            </p>
          </div>
        </div>

        {/* Note méthodologique — les règles de procédé (univariées) et le
            statut Normal/Anomalie (multivarié, Isolation Forest) sont deux
            couches de détection indépendantes : un jour "Normal" peut
            déclencher une règle isolée sans que la combinaison globale des
            variables soit inhabituelle, et inversement un jour "Anomalie"
            peut n'enfreindre aucune règle simple si c'est la COMBINAISON des
            variables qui est rare (cf. carte "Anomalie multifactorielle"). */}
        <div className="flex items-start gap-2.5 mb-5 px-4 py-3 rounded-xl bg-teal-50/60 border border-teal-100">
          <Info className="h-4 w-4 text-teal-600 mt-0.5 shrink-0" />
          <p className="text-xs text-teal-900 leading-relaxed">
            <strong>Un jour normal peut déclencher une règle isolée sans être une anomalie multivariée, et inversement.</strong>{" "}
            Les règles ci-dessous testent chaque variable séparément (ex. le taux de panne dépasse-t-il 5% ?), tandis que le statut
            Normal/Anomalie de la bulle vient de l'Isolation Forest, qui juge la combinaison de toutes les variables du jour à la
            fois. Une seule règle franchie ne suffit pas toujours à rendre une journée statistiquement inhabituelle — et à
            l'inverse, une combinaison rare de valeurs par ailleurs normales peut déclencher une anomalie sans qu'aucune règle
            simple ne s'allume.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {reglesDefinitionsEffectives.map((regle) => {
            const niveauDeclenche = reglesActives.get(regle.type);
            const estActif = Boolean(niveauDeclenche);

            return (
              <div
                key={regle.type}
                className={`p-4 rounded-xl border transition-all duration-300 relative overflow-hidden ${
                  niveauDeclenche === "rouge"
                    ? "bg-rose-50/90 border-rose-300 shadow-md ring-2 ring-rose-400/30"
                    : niveauDeclenche === "orange"
                    ? "bg-amber-50/90 border-amber-300 shadow-md ring-2 ring-amber-400/30"
                    : selectedDate
                    ? "bg-slate-50/50 border-slate-200/60 opacity-40 grayscale-[20%]"
                    : "bg-slate-50/70 border-slate-200/80 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h5 className="text-sm font-bold text-slate-800 leading-snug">
                    {regle.label}
                  </h5>
                  {estActif ? (
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider shadow-2xs ${
                      niveauDeclenche === "rouge" ? "bg-rose-600 text-white" : "bg-amber-500 text-white"
                    }`}>
                      {niveauDeclenche}
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-slate-400 bg-slate-200/60 px-2 py-0.5 rounded-full">
                      {regle.sens === "bas" ? "<" : ">"} {formatLabelRegle(regle.unite, regle.borne_orange)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed font-medium">
                  {regle.conseil}
                </p>
              </div>
            );
          })}

          {/* Carte Anomalie IA / Multifactorielle */}
          <div
            className={`p-4 rounded-xl border transition-all duration-300 flex items-start gap-3 relative overflow-hidden ${
              estMultifactorielle
                ? "bg-gradient-to-br from-emerald-900 to-teal-900 text-white shadow-lg border-amber-400 ring-2 ring-amber-400/60"
                : selectedDate
                ? "bg-slate-50/50 border-slate-200/60 opacity-40"
                : "bg-slate-50/70 border-slate-200/80"
            }`}
          >
            <div className={`p-2 rounded-lg ${estMultifactorielle ? "bg-amber-400/30 text-amber-200" : "bg-emerald-100 text-emerald-700"}`}>
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="w-full">
              <div className="flex items-center justify-between mb-1">
                <h5 className={`text-sm font-bold ${estMultifactorielle ? "text-white" : "text-slate-800"}`}>
                  Anomalie IA Multifactorielle
                </h5>
                {estMultifactorielle && (
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 uppercase tracking-wider">
                    Décelée
                  </span>
                )}
              </div>
              <p className={`text-xs ${estMultifactorielle ? "text-amber-100" : "text-slate-500"} leading-relaxed`}>
                Dérive multidimensionnelle détectée par Isolation Forest sans franchissement univarié direct.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}