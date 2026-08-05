import { useState } from "react";
import {
  ComposedChart,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  TrendingUp,
  Factory,
  Gauge,
  AlertTriangle,
  Clock,
  Activity,
  Sparkles,
} from "lucide-react";
import type { DashboardData, DailyEvolution } from "@/types";

interface Props {
  data: DashboardData;
}

type OngletProduction = "overview" | "volume" | "oee" | "panne";
const ONGLETS_PRODUCTION: { id: OngletProduction; label: string }[] = [
  { id: "overview", label: "Vue Globale" },
  { id: "volume", label: "Volumes & Débits" },
  { id: "oee", label: "Rendements (OEE/TRG)" },
  { id: "panne", label: "Pannes & HM" },
];

export default function ProductionView({ data }: Props) {
  const { evolution, kpis } = data;
  const [activeTab, setActiveTab] = useState<OngletProduction>("overview");

  // Sécurisation & Parsing explicite des données pour Recharts — "hm" est
  // déjà un champ officiel de DailyEvolution (cf. dashboard_api.py), mais on
  // garde ce filet de sécurité pour tolérer un éventuel nom hérité
  // ("heures_de_marche") sans recourir à `any`.
  const safeEvolution = (evolution || []).map((item: DailyEvolution & { heures_de_marche?: number | string }) => {
    const rawHm = item.hm ?? item.heures_de_marche;
    const parsedHm =
      typeof rawHm === "string" ? parseFloat(rawHm) : Number(rawHm);

    return {
      ...item,
      hm: !isNaN(parsedHm) ? parsedHm : 0,
    };
  });

  // Formateurs sécurisés pour TypeScript (number | null | undefined)
  const formatPct = (v: number | null | undefined) =>
    v !== undefined && v !== null && !isNaN(v) ? `${(v * 100).toFixed(1)}%` : "N/A";

  const formatNum = (v: number | null | undefined) =>
    v !== undefined && v !== null && !isNaN(v) ? v.toFixed(1) : "0";

  return (
    <div className="space-y-6">
      {/* En-tête avec navigation par Onglets — bande sombre uniforme avec les autres vues */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-2xl font-display font-extrabold tracking-tight flex items-center gap-3">
            <span className="flex items-center justify-center h-9 w-9 rounded-xl bg-white/10 border border-white/10 shadow-inner">
              <TrendingUp className="h-4.5 w-4.5 text-emerald-300" />
            </span>
            Production & KPIs
          </h2>
          <p className="text-sm text-emerald-100/70 ml-[46px]">
            Suivi opérationnel sur {kpis?.nb_jours ?? 0} jours de marche
          </p>
        </div>

        <div className="relative z-10 flex gap-1 bg-emerald-950/60 p-1 rounded-xl border border-emerald-700/50 backdrop-blur-md self-start sm:self-auto">
          {ONGLETS_PRODUCTION.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? "bg-white text-emerald-900 shadow-sm font-semibold"
                  : "text-emerald-200/70 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cartes KPI récapitulatives — anatomie unifiée avec les autres vues */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Prod. Totale</span>
            <div className="p-2.5 rounded-xl bg-teal-50 text-teal-600 border border-teal-100">
              <Factory className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {kpis?.production_totale_t
              ? `${(kpis.production_totale_t / 1000).toFixed(1)} kT`
              : "N/A"}
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Débit Moyen</span>
            <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100">
              <Activity className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {kpis?.debit_moyen_th
              ? `${kpis.debit_moyen_th.toFixed(1)} T/h`
              : "N/A"}
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">OEE Moyen</span>
            <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600 border border-amber-100">
              <Gauge className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {formatPct(kpis?.oee_moyen)}
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">TRG Moyen</span>
            <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-100">
              <TrendingUp className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {formatPct(kpis?.trg_moyen)}
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Disponibilité</span>
            <div className="p-2.5 rounded-xl bg-slate-100 text-slate-600 border border-slate-200">
              <Clock className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {formatPct(kpis?.disponibilite_moyenne)}
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Taux de Panne</span>
            <div className="p-2.5 rounded-xl bg-rose-50 text-rose-600 border border-rose-100">
              <AlertTriangle className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {formatPct(kpis?.taux_panne_moyen)}
          </p>
        </div>
      </div>

      {/* Graphique 1 : Production & Débits */}
      {(activeTab === "overview" || activeTab === "volume") && (
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-base font-display font-bold text-slate-800 mb-4">
            {activeTab === "overview"
              ? "Évolution de la Production & Débit"
              : "Volumes de Production (T) & Débit Horaire (T/h)"}
          </h3>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart
              data={safeEvolution}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "short",
                  })
                }
                tick={{ fontSize: 11, fill: "#64748b" }}
                minTickGap={25}
              />
              <YAxis
                yAxisId="left"
                domain={[0, "auto"]}
                tick={{ fontSize: 11, fill: "#64748b" }}
                unit=" T"
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, "auto"]}
                tick={{ fontSize: 11, fill: "#64748b" }}
                unit=" T/h"
              />
              <Tooltip
                labelFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                }
                formatter={(val: number, name: string) => [
                  name === "Production (T)"
                    ? `${formatNum(val)} T`
                    : `${formatNum(val)} T/h`,
                  name,
                ]}
              />
              <Legend wrapperStyle={{ paddingTop: "12px" }} />

              <Line
                yAxisId="left"
                type="monotone"
                dataKey="production_t"
                stroke="#0d9488"
                strokeWidth={2}
                dot={false}
                name="Production (T)"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="debit_th"
                stroke="#d97706"
                strokeWidth={2}
                dot={false}
                name="Débit (T/h)"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Graphique 2 : Rendements (OEE / TRG / Disponibilité) */}
      {(activeTab === "overview" || activeTab === "oee") && (
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-base font-display font-bold text-slate-800 mb-4">
            Taux d'Efficacité Globale (OEE, TRG & Disponibilité)
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart
              data={safeEvolution}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "short",
                  })
                }
                tick={{ fontSize: 11, fill: "#64748b" }}
                minTickGap={25}
              />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                tick={{ fontSize: 11, fill: "#64748b" }}
              />
              <Tooltip
                labelFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                }
                formatter={(v: number) => [formatPct(v), ""]}
              />
              <Legend wrapperStyle={{ paddingTop: "10px" }} />
              <Line
                type="monotone"
                dataKey="oee"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                name="OEE"
              />
              <Line
                type="monotone"
                dataKey="trg"
                stroke="#065f46"
                strokeWidth={2}
                dot={false}
                name="TRG"
              />
              <Line
                type="monotone"
                dataKey="disponibilite"
                stroke="#64748b"
                strokeWidth={2}
                dot={false}
                name="Disponibilité"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Graphique 3 : Pannes & Heures de Marche (HM) */}
      {(activeTab === "overview" || activeTab === "panne") && (
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-base font-display font-bold text-slate-800 mb-4">
            Analyse des Pannes & Heures de Marche (HM)
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              data={safeEvolution}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "short",
                  })
                }
                tick={{ fontSize: 11, fill: "#64748b" }}
                minTickGap={25}
              />
              {/* Axe HM (0 à 24 Heures) */}
              <YAxis
                yAxisId="left"
                domain={[0, 24]}
                tick={{ fontSize: 11, fill: "#64748b" }}
                unit="h"
              />
              {/* Axe Taux de Panne (0% à 100%) */}
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 1]}
                tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                tick={{ fontSize: 11, fill: "#64748b" }}
              />
              <Tooltip
                labelFormatter={(v) =>
                  new Date(v).toLocaleDateString("fr-FR", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                }
                formatter={(val: number, name: string) => [
                  name === "Heures de Marche (HM)"
                    ? `${formatNum(val)} h`
                    : formatPct(val),
                  name,
                ]}
              />
              <Legend wrapperStyle={{ paddingTop: "10px" }} />
              <Bar
                yAxisId="left"
                dataKey="hm"
                fill="#0d9488"
                opacity={0.8}
                name="Heures de Marche (HM)"
                radius={[2, 2, 0, 0]}
                minPointSize={2}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="taux_panne"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
                name="Taux de Panne"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}