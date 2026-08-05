/**
 * PredictionView.tsx — Vue "Prédiction des Pannes J+1" enrichie
 *
 * Améliorations v2 :
 *  1. Actions prescriptives dynamiques par nature de panne la plus probable
 *  2. KPI de production : "Tonnage de production préservé" (calculé côté Django)
 *  3. Moyenne mobile 7 jours sur la courbe de risque (lissage tendance)
 *  4. Graphique de répartition par nature contextuel (clic sur un jour à risque)
 *
 * Améliorations v3 :
 *  5. "Jours à Risque Élevé" ne montre plus QUE la vraie période de prévision
 *     hors-échantillon (à partir de cutoff_predictif)
 *  6. Recommandations prescriptives basées sur les jours analogues (analytics/decision_matrix.py)
 */

import { useState, useMemo, useEffect } from "react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
  ReferenceArea,
  Line,
  ComposedChart,
  Area,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  Brain,
  TrendingUp,
  Info,
  Loader2,
  Wrench,
  Calendar,
  Zap,
  Sliders,
  Sparkles,
} from "lucide-react";
import type { DashboardData, RoiPredictif, JourARisque, JoursARisqueResponse } from "@/types";
import { fetchJson } from "@/hooks/useData";

interface Props {
  data: DashboardData;
}

// Couleurs thématiques OCP (Vert OCP, Ambre/Or, Rouge Industriel, Bleu Cyan)


const NATURE_COLORS: Record<string, string> = {
  Exploitation: "#0284c7", // Bleu
  Electrique:   "#d97706", // Ambre
  Mécanique:    "#dc2626", // Rouge
  Installation: "#0d9488", // Vert OCP
  Autre:        "#7c3aed", // Violet
};

// ─────────────────────────────────────────────────────────────────────────────
// Calcul de la moyenne mobile sur N jours
// ─────────────────────────────────────────────────────────────────────────────
function movingAverage(data: number[], windowSize: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < windowSize - 1) return null;
    const slice = data.slice(i - windowSize + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / windowSize;
  });
}

function formatDateLongue(d: string): string {
  return new Date(d).toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long",
  });
}

// Tooltip personnalisé pour thème clair OCP
interface PayloadEntree {
  color?: string;
  name?: string;
  value?: number;
}
interface CustomTooltipProps {
  active?: boolean;
  payload?: PayloadEntree[];
  label?: string;
}
const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-xl text-xs space-y-1.5">
        <p className="font-semibold text-slate-800 border-b border-slate-100 pb-1">
          {label && new Date(label).toLocaleDateString("fr-FR", {
            weekday: "long", day: "numeric", month: "long", year: "numeric"
          })}
        </p>
        {payload.map((entry, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <span style={{ color: entry.color }} className="font-medium">
              {entry.name === "risk" ? "Risque J+1" : entry.name === "ma7" ? "Moyenne 7j" : entry.name} :
            </span>
            <span className="font-bold text-slate-900">
              {((entry.value ?? 0) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Composant principal
// ─────────────────────────────────────────────────────────────────────────────
export default function PredictionView({ data }: Props) {
  const { evolution, cutoff_predictif } = data;
  const [riskThreshold, setRiskThreshold] = useState(0.4);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // ── Courbe complète (contexte historique + zone de prévision) ───────────
  const predictions = useMemo(() => {
    const vals = evolution
      .filter((e) => e.risk_panne_j1 !== null)
      .map((e) => ({
        date: e.date,
        risk: e.risk_panne_j1 as number,
        production: e.production_t,
        outOfSample: e.out_of_sample,
      }));

    const riskValues = vals.map((v) => v.risk);
    const ma7 = movingAverage(riskValues, 7);

    return vals.map((v, i) => ({ ...v, ma7: ma7[i] }));
  }, [evolution]);

  const predictionsHorsEchantillon = useMemo(
    () => predictions.filter((p) => p.outOfSample),
    [predictions]
  );

  // Risque moyen sur les jours prédits
  const risqueMoyen = useMemo(() => {
    if (predictionsHorsEchantillon.length === 0) return 0;
    const sum = predictionsHorsEchantillon.reduce((a, b) => a + (b.risk || 0), 0);
    return sum / predictionsHorsEchantillon.length;
  }, [predictionsHorsEchantillon]);

  // ── Jours à Risque Élevé — calculés côté Django ─────────────────────────
  const [joursARisque, setJoursARisque] = useState<JourARisque[]>([]);
  const [joursLoading, setJoursLoading] = useState(true);
  const [joursError, setJoursError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadJoursARisque() {
      setJoursLoading(true);
      setJoursError(null);
      try {
        const res = await fetchJson<JoursARisqueResponse>(`/dashboard/jours-a-risque/?seuil=${riskThreshold}`);
        if (!cancelled) setJoursARisque(res.jours);
      } catch (err) {
        if (!cancelled) setJoursError((err as Error).message);
      } finally {
        if (!cancelled) setJoursLoading(false);
      }
    }

    loadJoursARisque();

    return () => {
      cancelled = true;
    };
  }, [riskThreshold]);

  // ── KPI Production : Tonnage de production préservé ────────────────────
  const [roi, setRoi] = useState<RoiPredictif | null>(null);
  const [roiLoading, setRoiLoading] = useState(true);
  const [roiError, setRoiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRoiData() {
      setRoiLoading(true);
      setRoiError(null);
      try {
        const res = await fetchJson<RoiPredictif>(`/dashboard/roi-predictif/?seuil=${riskThreshold}`);
        if (!cancelled) setRoi(res);
      } catch (err) {
        if (!cancelled) setRoiError((err as Error).message);
      } finally {
        if (!cancelled) setRoiLoading(false);
      }
    }

    loadRoiData();

    return () => {
      cancelled = true;
    };
  }, [riskThreshold]);

  // ── Jour sélectionné ────────────────────────────────────────────────────
  const selectedDayData = selectedDay
    ? joursARisque.find((d) => d.date === selectedDay)
    : joursARisque[0];

  const chartTitle = selectedDayData
    ? `Jours analogues — ${selectedDayData.jours_analogues.length} jour(s) de référence`
    : "Sélectionnez un jour à risque";

  const contextualNatureData = selectedDayData?.repartition_natures ?? [];

  const cutoffFormatted = cutoff_predictif
    ? new Date(cutoff_predictif).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
    : "N/A";

  return (
    <div className="space-y-6 text-slate-800">

      {/* ── En-tête — bande sombre uniforme avec les autres vues ────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-2xl font-display font-extrabold tracking-tight flex items-center gap-2.5">
            <span className="flex items-center justify-center h-9 w-9 rounded-xl bg-white/10 border border-white/10 shadow-inner">
              <Brain className="h-4.5 w-4.5 text-emerald-300" />
            </span>
            Prédiction des Pannes J+1
          </h2>
          <p className="text-xs text-emerald-100/70 mt-1 ml-[46px]">
            HistGradientBoosting — Anticipation globale des défaillances (Mécanique, Électrique, Exploitation, Installation)
            {cutoff_predictif && (
              <> · Prévision active depuis le{" "}
                <strong className="text-white">{new Date(cutoff_predictif).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</strong>
              </>
            )}
          </p>
        </div>

        {/* Contrôle du Seuil */}
        <div className="relative z-10 flex items-center gap-3 bg-emerald-950/60 border border-emerald-700/50 px-4 py-2 rounded-xl backdrop-blur-md">
          <Sliders className="w-4 h-4 text-amber-400" />
          <label className="text-xs font-medium text-emerald-100">Seuil d'alerte :</label>
          <input
            type="range"
            min="0.1"
            max="0.9"
            step="0.1"
            value={riskThreshold}
            onChange={(e) => {
              setRiskThreshold(parseFloat(e.target.value));
              setSelectedDay(null);
            }}
            className="w-28 accent-amber-400 cursor-pointer"
          />
          <span className="text-xs font-bold text-amber-300 bg-amber-400/10 border border-amber-400/30 px-2 py-0.5 rounded-md min-w-[40px] text-center">
            {(riskThreshold * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* ── KPI Cards (Design Clair Harmonisé OCP) ─────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">

        {/* 1. Carte : Risque Moyen */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-5 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] flex flex-col justify-between hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.15)] hover:-translate-y-0.5 transition-all">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Risque Moyen</span>
              <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600 border border-amber-100">
                <TrendingUp className="w-5 h-5" />
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {(risqueMoyen * 100).toFixed(1)}%
              </span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                risqueMoyen > 0.35 
                  ? 'bg-rose-50 text-rose-700 border border-rose-200' 
                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              }`}>
                {risqueMoyen > 0.35 ? 'Élevé' : 'Modéré'}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Sévérité globale</span>
            <span className="text-slate-700 font-medium">Seuil : {(riskThreshold * 100).toFixed(0)}%</span>
          </div>
        </div>

        {/* 2. Carte : Jours à Risque Élevé */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-5 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] flex flex-col justify-between hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.15)] hover:-translate-y-0.5 transition-all">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Jours à Risque Élevé</span>
              <div className="p-2.5 rounded-xl bg-rose-50 text-rose-600 border border-rose-100">
                <AlertTriangle className="w-5 h-5" />
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {joursLoading ? <Loader2 className="w-6 h-6 animate-spin text-slate-400" /> : joursARisque.length}
              </span>
              <span className="text-xs font-medium text-slate-500">jours identifiés</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Interventions cibles</span>
            <span className="text-rose-600 font-semibold">{roi?.nb_interventions_preventives ?? 0} préventives</span>
          </div>
        </div>

        {/* 3. Carte : Jours Prédits */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-5 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] flex flex-col justify-between hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.15)] hover:-translate-y-0.5 transition-all">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Jours Prédits</span>
              <div className="p-2.5 rounded-xl bg-teal-50 text-teal-600 border border-teal-100">
                <Calendar className="w-5 h-5" />
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {predictionsHorsEchantillon.length}
              </span>
              <span className="text-xs font-medium text-slate-500">jours de prévision</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Horizon temporel</span>
            <span className="text-teal-700 font-medium">À partir du {cutoffFormatted}</span>
          </div>
        </div>

        {/* 4. Carte : Production Préservée (Thème OCP Vert Émeraude) */}
        <div className="bg-emerald-50/60 border border-emerald-300 rounded-2xl p-5 shadow-[0_4px_24px_-8px_rgba(4,120,87,0.20)] flex flex-col justify-between hover:border-emerald-400 hover:-translate-y-0.5 transition-all">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-teal-700">Tonnage Préservé</span>
              <div className="p-2.5 rounded-xl bg-teal-700 text-white shadow-sm">
                <Zap className="w-5 h-5" />
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              {roiLoading ? (
                <span className="text-lg font-bold text-slate-400 flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-teal-700" /> Calcul…
                </span>
              ) : roiError ? (
                <span className="text-xs text-rose-600">Indisponible</span>
              ) : (
                <>
                  <span className="text-2xl font-display font-extrabold text-teal-700 tabular-nums">
                    {roi?.tonnage_preserve_t?.toLocaleString("fr-FR") ?? 0}
                  </span>
                  <span className="text-sm font-bold text-emerald-800">Tonnes</span>
                </>
              )}
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-emerald-200 flex items-center justify-between text-xs text-emerald-900/80">
            <span>Pertes évitées</span>
            <span className="text-teal-700 font-bold">~{roi?.heures_evitees_h ?? 0} h d'arrêts</span>
          </div>
        </div>

      </div>

      {/* ── Courbe Risque + Moyenne Mobile 7j ──────────────────────────────── */}
      <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-6 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)]">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <h3 className="text-base font-display font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-5 h-5 text-teal-700" />
            Évolution de la Probabilité de Panne J+1
          </h3>
          <div className="flex items-center gap-4 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-teal-700" />
              Risque quotidien
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-dashed border-t-2 border-amber-500" />
              Moyenne 7j
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-emerald-100 border border-emerald-300 rounded" />
              Zone de prévision
            </span>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={predictions}>
            <defs>
              <linearGradient id="ocpRiskGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0d9488" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#0d9488" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis
              dataKey="date"
              tickFormatter={(v) =>
                new Date(v).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
              }
              tick={{ fontSize: 11, fill: "#64748b" }}
              stroke="#cbd5e1"
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 11, fill: "#64748b" }}
              stroke="#cbd5e1"
            />
            <Tooltip content={<CustomTooltip />} />
            {cutoff_predictif && (
              <ReferenceArea
                x1={cutoff_predictif}
                fill="#0d9488"
                fillOpacity={0.05}
                stroke="#0d9488"
                strokeOpacity={0.3}
                strokeDasharray="4 4"
                label={{ value: "Prévision active", position: "insideTopRight", fill: "#0d9488", fontSize: 11, fontWeight: 600 }}
              />
            )}
            <ReferenceLine
              y={riskThreshold}
              stroke="#dc2626"
              strokeDasharray="6 4"
              label={{
                value: `Seuil ${(riskThreshold * 100).toFixed(0)}%`,
                fill: "#dc2626",
                fontSize: 11,
                fontWeight: 600,
                position: "insideTopRight",
              }}
            />
            <Area
              type="monotone"
              dataKey="risk"
              stroke="#0d9488"
              fill="url(#ocpRiskGrad)"
              strokeWidth={2}
              dot={false}
              name="risk"
            />
            <Line
              type="monotone"
              dataKey="ma7"
              stroke="#d97706"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              name="ma7"
            />
          </ComposedChart>
        </ResponsiveContainer>

        <p className="text-xs text-slate-500 mt-3 flex items-center gap-1.5 border-t border-slate-100 pt-3">
          <Info className="h-4 w-4 text-teal-700 shrink-0" />
          La zone blanche correspond au contexte d'entraînement. La zone ombragée en vert indique la période de prédiction réelle.
        </p>
      </div>

      {/* ── Graphique contextuel + Liste des jours à risque ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Diagnostic & Cause Probable */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-5 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-display font-bold text-slate-900">{chartTitle}</h3>
              {selectedDay && (
                <button
                  onClick={() => setSelectedDay(null)}
                  className="text-xs text-teal-700 hover:underline font-semibold shrink-0"
                >
                  Réinitialiser
                </button>
              )}
            </div>

            {selectedDayData ? (
              <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-xs mb-4 space-y-1.5">
                <div className="flex items-center gap-2 text-emerald-900 font-bold">
                  <Wrench className="h-4 w-4 text-teal-700" />
                  <span>Cause probable : {selectedDayData.cause_probable}</span>
                </div>
                <p className="text-slate-700">
                  <strong className="text-emerald-950">Action recommandée :</strong> {selectedDayData.action_recommandee}
                </p>
                {selectedDayData.jours_analogues.length > 0 && (
                  <p className="text-slate-500 text-[11px] pt-1 border-t border-emerald-200/60">
                    Jours de référence :{" "}
                    {selectedDayData.jours_analogues
                      .map((d) => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))
                      .join(", ")}
                  </p>
                )}
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 mb-4 flex items-center gap-2">
                <Info className="h-4 w-4 text-slate-400 shrink-0" />
                Sélectionnez un jour à risque ci-contre pour afficher les diagnostics prescriptifs.
              </div>
            )}

            {contextualNatureData.length > 0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={contextualNatureData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} stroke="#cbd5e1" allowDecimals={false} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "#64748b" }} stroke="#cbd5e1" width={95} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderRadius: "8px", fontSize: "12px" }}
                    formatter={(v: number) => [`${v} événement(s)`, "Fréquence historique"]}
                  />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                    {contextualNatureData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={NATURE_COLORS[entry.name] ?? "#0d9488"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[210px] flex items-center justify-center text-slate-400 text-sm italic">
                {joursLoading ? "Analyse en cours…" : "Aucune donnée de référence disponible"}
              </div>
            )}
          </div>

          <p className="text-[11px] text-slate-400 text-center mt-2">
            Répartition des natures d'arrêts constatées sur les journées aux conditions opérationnelles analogues.
          </p>
        </div>

        {/* Liste des Jours à Risque Élevé */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/70 rounded-2xl p-5 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)]">
          <h3 className="text-base font-display font-bold text-slate-900 mb-4 flex items-center justify-between">
            <span>Jours à Risque Élevé</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
              {joursARisque.length} détecté(s)
            </span>
          </h3>

          <div className="max-h-[310px] overflow-y-auto space-y-2.5 pr-1.5 custom-scrollbar">
            {joursLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                <Loader2 className="h-7 w-7 mb-2 animate-spin text-teal-700" />
                <p className="text-xs font-medium">Calcul des prévisions J+1…</p>
              </div>
            ) : joursError ? (
              <div className="flex flex-col items-center justify-center py-12 text-rose-600">
                <AlertTriangle className="h-8 w-8 mb-2 opacity-80" />
                <p className="text-xs font-medium">Erreur : {joursError}</p>
              </div>
            ) : joursARisque.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                <Activity className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-xs">Aucun jour à risque élevé détecté pour ce seuil.</p>
              </div>
            ) : (
              joursARisque.map((day, idx) => {
                const isSelected = selectedDay === day.date;
                const riskPct = (day.risk * 100).toFixed(0);

                const badgeStyle =
                  day.risk >= 0.8 ? "bg-rose-100 text-rose-800 border-rose-200" :
                  day.risk >= 0.6 ? "bg-amber-100 text-amber-800 border-amber-200" :
                                    "bg-yellow-100 text-yellow-800 border-yellow-200";

                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedDay(isSelected ? null : day.date)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all duration-200 ${
                      isSelected
                        ? "bg-emerald-50/80 border-teal-700 shadow-sm ring-1 ring-teal-700"
                        : "bg-slate-50/60 border-slate-200 hover:bg-slate-100/80 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-800 truncate">
                          {formatDateLongue(day.date)}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Production estimée : <span className="text-slate-700 font-semibold">{day.production_t?.toFixed(0) ?? "N/A"} T</span>
                        </p>

                        <div className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-md text-[10px] font-medium bg-white border border-slate-200 text-slate-700 shadow-2xs">
                          <Wrench className="h-3 w-3 text-teal-700 shrink-0" />
                          <span className="truncate max-w-[200px]">{day.action_recommandee}</span>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${badgeStyle}`}>
                          {riskPct}%
                        </span>
                        {day.nature_probable && (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-md font-semibold border"
                            style={{
                              backgroundColor: (NATURE_COLORS[day.nature_probable] ?? "#0d9488") + "15",
                              borderColor: (NATURE_COLORS[day.nature_probable] ?? "#0d9488") + "40",
                              color: NATURE_COLORS[day.nature_probable] ?? "#0d9488",
                            }}
                          >
                            {day.nature_probable}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Note de transparence métier ──────────────────────────────────────── */}
      <div className="flex items-start gap-2.5 px-4 py-3 bg-white rounded-xl border border-slate-200 text-xs text-slate-500 shadow-2xs">
        <Info className="h-4 w-4 text-teal-700 shrink-0 mt-0.5" />
        <span>
          <strong className="text-slate-800">Note méthodologique OCP :</strong>{" "}
          {roi?.methodologie ??
            "Le tonnage de production préservé est calculé à partir du MTTR réel et du débit nominal du sécheur."}{" "}
          Les diagnostics prescriptifs sont générés dynamiquement par rapprochement avec les séquences historiques analogues.
        </span>
      </div>

    </div>
  );
}