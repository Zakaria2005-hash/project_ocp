import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  TrendingUp,
  Activity,
  AlertTriangle,
  Factory,
  Zap,
  Info,
  TrendingDown,
  ChevronRight,
  SlidersHorizontal,
  Calendar,
  ShieldAlert,
  ArrowUpRight,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import type { DashboardData, AlertItem, EnergyData } from "@/types";

interface Props {
  data: DashboardData;
  energyData?: EnergyData[];
  onNavigateToPrediction?: (date: string) => void;
}

const BASELINE_ENERGIE_KCALT = 160_000;
const FENETRE_ALERTES_RECENTES_JOURS = 7;

function formatNumberFr(num: number | null | undefined, decimals = 0): string {
  if (num === undefined || num === null || isNaN(num)) return "0";
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(num);
}

function formatDateFr(dateStr: string, option: "short" | "monthLong" | "full" = "short"): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;

  if (option === "monthLong") {
    const formatted = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }
  if (option === "full") {
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  }
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/* Tooltip Recharts Ultra-Clean */
function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-emerald-950/95 backdrop-blur-md text-white px-3.5 py-2.5 rounded-xl shadow-xl border border-emerald-800/50 text-xs space-y-1.5 z-50">
        <p className="font-semibold text-slate-300 border-b border-slate-800 pb-1 mb-1">
          {formatDateFr(label, "full")}
        </p>
        {payload.map((pld: any, idx: number) => {
          const isProduction = pld.dataKey === "production_t" || pld.dataKey === "production_moyenne_t";
          const isDebit = pld.dataKey === "debit_th";
          const isOee = pld.dataKey === "oeeNormalized";
          const isPanne = pld.dataKey === "tauxPanneNormalized";

          let labelText = pld.name;
          let formattedValue = pld.value;

          if (isProduction) {
            labelText = "Production";
            formattedValue = `${formatNumberFr(pld.value, 1)} T`;
          } else if (isDebit) {
            labelText = "Débit";
            formattedValue = `${formatNumberFr(pld.value, 1)} T/h`;
          } else if (isOee) {
            labelText = "OEE";
            formattedValue = `${(pld.value * 100).toFixed(1)}%`;
          } else if (isPanne) {
            labelText = "Taux panne";
            formattedValue = `${(pld.value * 100).toFixed(1)}%`;
          }

          return (
            <div key={idx} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-slate-400">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: pld.color || pld.fill }}
                />
                {labelText}
              </span>
              <span className="font-bold tabular-nums text-white">{formattedValue}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return null;
}

function KPICard({
  title,
  value,
  unit,
  icon: Icon,
  color,
  iconBg,
  subtext,
  badge,
  infoTooltip,
}: {
  title: string;
  value: string | number;
  unit?: string;
  icon: React.ElementType;
  color: string;
  iconBg: string;
  subtext?: string;
  badge?: string;
  infoTooltip?: string;
}) {
  return (
    <div className="group relative bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            {title}
            {infoTooltip && (
              <span title={infoTooltip} className="cursor-help inline-flex">
                <Info className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600 transition-colors" />
              </span>
            )}
          </p>
          <div className="flex items-baseline gap-1.5 pt-0.5">
            <span className="text-2xl font-display font-extrabold text-slate-900 tracking-tight tabular-nums">
              {value}
            </span>
            {unit && <span className="text-xs font-semibold text-slate-400">{unit}</span>}
          </div>
        </div>
        <div className={`p-2.5 rounded-xl ${iconBg} ${color} transition-transform duration-300 group-hover:scale-105`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
        {subtext && <span className="text-slate-500 font-medium truncate">{subtext}</span>}
        {badge && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/80">
            <TrendingDown className="h-3 w-3" />
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function AlertBadge({
  alert,
  onNavigateToPrediction,
}: {
  alert: AlertItem & { niveau?: string; suspicion?: string; score?: number };
  onNavigateToPrediction?: (date: string) => void;
}) {
  const niveauClé = (alert.niveau || alert.suspicion || "orange").toLowerCase();

  const isCritical =
    niveauClé.includes("rouge") || niveauClé.includes("élevé") || niveauClé.includes("critique");
  const isWarning =
    niveauClé.includes("orange") || niveauClé.includes("moyen") || niveauClé.includes("attention");

  const style = isCritical
    ? {
        borderLeft: "border-l-rose-500",
        container: "bg-rose-50/40 hover:bg-rose-50/70 border-slate-200/80",
        badge: "bg-rose-100/80 text-rose-800 border-rose-200",
        label: "CRITIQUE",
        icon: "text-rose-600",
        btn: "text-rose-700 hover:text-rose-800 hover:bg-rose-100/60",
      }
    : isWarning
    ? {
        borderLeft: "border-l-amber-500",
        container: "bg-amber-50/40 hover:bg-amber-50/70 border-slate-200/80",
        badge: "bg-amber-100/80 text-amber-800 border-amber-200",
        label: "SUSPICION",
        icon: "text-amber-600",
        btn: "text-amber-700 hover:text-amber-800 hover:bg-amber-100/60",
      }
    : {
        borderLeft: "border-l-emerald-500",
        container: "bg-emerald-50/40 hover:bg-emerald-50/70 border-slate-200/80",
        badge: "bg-emerald-100/80 text-emerald-800 border-emerald-200",
        label: "INFO / OK",
        icon: "text-emerald-600",
        btn: "text-emerald-700 hover:text-emerald-800 hover:bg-emerald-100/60",
      };

  return (
    <div
      className={`group relative p-3.5 rounded-xl border border-l-4 ${style.borderLeft} ${style.container} transition-all duration-200 space-y-2 shadow-2xs`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert className={`h-4 w-4 flex-shrink-0 ${style.icon}`} />
          <h4 className="text-xs font-bold text-slate-900 truncate">
            {alert.titre || "Alerte détectée"}
          </h4>
        </div>
        <span
          className={`text-[9px] px-2 py-0.5 rounded-md font-extrabold tracking-wider border ${style.badge}`}
        >
          {alert.suspicion ? alert.suspicion.toUpperCase() : style.label}
        </span>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed font-normal">{alert.description}</p>

      <div className="flex items-center justify-between pt-2 border-t border-slate-200/40">
        <span className="text-[10px] font-medium text-slate-400">
          {formatDateFr(alert.date, "full")}
        </span>

        {onNavigateToPrediction && (
          <button
            onClick={() => onNavigateToPrediction(alert.date)}
            className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md transition-all cursor-pointer ${style.btn}`}
          >
            <span>Analyser</span>
            <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function DashboardView({ data, onNavigateToPrediction }: Props) {
  const { kpis, evolution, alertes, monthly } = data;
  const [voirToutHistorique, setVoirToutHistorique] = useState(false);

  const [periodDays, setPeriodDays] = useState<number>(30);
  const [selectedMonthFilter, setSelectedMonthFilter] = useState<string | null>(null);

  const [visibleSeries, setVisibleSeries] = useState({
    production: true,
    debit: true,
  });

  const toggleSeries = (key: "production" | "debit") => {
    setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // 1. Filtrage dynamique des données temporelles
  const filteredEvolution = useMemo(() => {
    if (!evolution) return [];
    const list = [...evolution];

    if (selectedMonthFilter) {
      return list.filter((e) => e.date.startsWith(selectedMonthFilter));
    }

    return list.slice(-periodDays);
  }, [evolution, periodDays, selectedMonthFilter]);

  // 2. Recalcul dynamique des KPIs selon la période filtrée
  const dynamicKPIs = useMemo(() => {
    if (!filteredEvolution || filteredEvolution.length === 0) {
      return kpis;
    }

    const nbJours = filteredEvolution.length;

    const prodTotale = filteredEvolution.reduce((acc, curr) => acc + (curr.production_t ?? 0), 0);
    const prodMoyenne = prodTotale / nbJours;

    const oeeSum = filteredEvolution.reduce((acc, curr) => acc + (curr.oee ?? 0), 0);
    const oeeMoyen = oeeSum / nbJours;

    const panneSum = filteredEvolution.reduce((acc, curr) => acc + (curr.taux_panne ?? 0), 0);
    const panneMoyenne = panneSum / nbJours;

    const consoSum = filteredEvolution.reduce((acc, curr) => acc + (curr.conso_energie ?? 0), 0);
    const consoMoyenne = consoSum / nbJours;

    return {
      production_totale_t: prodTotale,
      production_moyenne_t: prodMoyenne,
      oee_moyen: oeeMoyen,
      trg_moyen: kpis?.trg_moyen,
      taux_panne_moyen: panneMoyenne,
      disponibilite_moyenne: kpis?.disponibilite_moyenne,
      conso_energie_moyenne: consoMoyenne > 0 ? consoMoyenne : kpis?.conso_energie_moyenne,
      nb_jours: nbJours,
    };
  }, [filteredEvolution, kpis]);

  // Normalisation des données mensuelles
  const formattedMonthly = useMemo(() => {
    if (!monthly) return [];
    return monthly.map((m) => {
      const monthLabel = m.mois_nom
        ? formatDateFr(`${m.mois_nom}-01`, "monthLong")
        : formatDateFr(`${m.mois}-01`, "monthLong");

      const rawOee = m.oee ?? 0;
      const rawPanne = m.taux_panne ?? 0;

      return {
        ...m,
        displayMonth: monthLabel,
        oeeNormalized: rawOee > 1 ? rawOee / 100 : rawOee,
        tauxPanneNormalized: rawPanne > 1 ? rawPanne / 100 : rawPanne,
      };
    });
  }, [monthly]);

  const handleMonthlyBarClick = (entry: any) => {
    if (entry && (entry.mois || entry.mois_nom)) {
      const monthKey = entry.mois || entry.mois_nom;
      setSelectedMonthFilter(selectedMonthFilter === monthKey ? null : monthKey);
    }
  };

  // Isolation des alertes récentes
  const derniereDate = evolution?.[evolution.length - 1]?.date;
  const alertesRecentes = useMemo(() => {
    if (!derniereDate || !alertes) return alertes || [];
    const seuil = new Date(derniereDate);
    seuil.setDate(seuil.getDate() - FENETRE_ALERTES_RECENTES_JOURS);
    return alertes.filter((a) => new Date(a.date) >= seuil);
  }, [alertes, derniereDate]);

  const alertesAffichees = voirToutHistorique ? alertes : alertesRecentes;

  // Économie d'énergie calculée sur la base des KPIs dynamiques
  const economiePct = dynamicKPIs?.conso_energie_moyenne
    ? ((BASELINE_ENERGIE_KCALT - dynamicKPIs.conso_energie_moyenne) / BASELINE_ENERGIE_KCALT) * 100
    : null;

  const hasCriticalAlerts = alertesRecentes.some(
    (a) => (a.niveau || a.suspicion || "").toLowerCase().includes("rouge") || (a.niveau || a.suspicion || "").toLowerCase().includes("critique")
  );

  return (
    <div className="space-y-6 text-slate-800 font-sans">
      {/* En-tête Principal & Filtres Temporels — bande sombre uniforme avec AnomaliesView.tsx / JumeauView.tsx */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h1 className="text-xl lg:text-2xl font-display font-extrabold tracking-tight">
            Tableau de Bord — Vue d'ensemble
          </h1>
          <p className="text-xs text-emerald-100/70 mt-1 flex items-center gap-1.5 font-medium">
            <Calendar className="w-3.5 h-3.5 text-amber-400" />
            {selectedMonthFilter ? (
              <span>
                Filtre mensuel actif :{" "}
                <strong className="text-white font-bold">
                  {formatDateFr(`${selectedMonthFilter}-01`, "monthLong")}
                </strong>
                <button
                  onClick={() => setSelectedMonthFilter(null)}
                  className="ml-2 text-xs text-amber-300 hover:text-amber-200 underline font-bold cursor-pointer"
                >
                  (Réinitialiser)
                </button>
              </span>
            ) : (
              <span>
                Période affichée :{" "}
                <strong className="text-emerald-50">{filteredEvolution?.[0]?.date}</strong> →{" "}
                <strong className="text-emerald-50">
                  {filteredEvolution?.[filteredEvolution.length - 1]?.date}
                </strong>{" "}
                ({dynamicKPIs?.nb_jours ?? 0} jours)
              </span>
            )}
          </p>
        </div>

        {/* Sélecteur dynamique de jours & Statut */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex items-center gap-1 bg-emerald-950/60 p-1 rounded-xl border border-emerald-700/50 backdrop-blur-md">
            <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-300 ml-2 mr-1" />
            {[7, 30, 90, 180].map((days) => (
              <button
                key={days}
                onClick={() => {
                  setSelectedMonthFilter(null);
                  setPeriodDays(days);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  periodDays === days && !selectedMonthFilter
                    ? "bg-white text-emerald-900 shadow-xs"
                    : "text-emerald-200/70 hover:text-white"
                }`}
              >
                {days}J
              </button>
            ))}
          </div>

          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
              hasCriticalAlerts
                ? "bg-rose-500/20 text-rose-200 border-rose-400/40 animate-pulse"
                : "bg-emerald-500/20 text-emerald-200 border-emerald-400/30"
            }`}
          >
            {hasCriticalAlerts ? (
              <>
                <Activity className="h-3.5 w-3.5 text-rose-300" />
                <span>Alertes critiques</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                <span>Système optimal</span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* Cartes KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Production Totale"
          value={formatNumberFr(dynamicKPIs?.production_totale_t ?? 0)}
          unit="T"
          icon={Factory}
          color="text-teal-600"
          iconBg="bg-teal-50"
          subtext={`Moy: ${formatNumberFr(dynamicKPIs?.production_moyenne_t ?? 0, 1)} T/j (${dynamicKPIs?.nb_jours ?? 0}J)`}
        />
        <KPICard
          title="OEE Moyen"
          value={
            dynamicKPIs?.oee_moyen
              ? `${(dynamicKPIs.oee_moyen * (dynamicKPIs.oee_moyen <= 1 ? 100 : 1)).toFixed(1)}`
              : "N/A"
          }
          unit="%"
          icon={TrendingUp}
          color="text-emerald-600"
          iconBg="bg-emerald-50"
          subtext={`TRG: ${
            dynamicKPIs?.trg_moyen
              ? (dynamicKPIs.trg_moyen * (dynamicKPIs.trg_moyen <= 1 ? 100 : 1)).toFixed(1)
              : "N/A"
          }%`}
          infoTooltip="Calculé en moyenne dynamique sur la période affichée."
        />
        <KPICard
          title="Taux de Panne"
          value={
            dynamicKPIs?.taux_panne_moyen
              ? `${(dynamicKPIs.taux_panne_moyen * (dynamicKPIs.taux_panne_moyen <= 1 ? 100 : 1)).toFixed(1)}`
              : "N/A"
          }
          unit="%"
          icon={AlertTriangle}
          color="text-amber-600"
          iconBg="bg-amber-50"
          subtext={`Sur ${dynamicKPIs?.nb_jours ?? 0} jours sélectionnés`}
        />
        <KPICard
          title="Conso. Énergie"
          value={dynamicKPIs?.conso_energie_moyenne ? formatNumberFr(dynamicKPIs.conso_energie_moyenne) : "N/A"}
          unit="kcal/T"
          icon={Zap}
          color="text-amber-700"
          iconBg="bg-amber-100"
          subtext={`Base: ${formatNumberFr(BASELINE_ENERGIE_KCALT)} kcal/T`}
          badge={
            economiePct !== null
              ? `${economiePct >= 0 ? "-" : "+"}${Math.abs(economiePct).toFixed(1)}% vs base`
              : undefined
          }
        />
      </div>

      {/* Graphique Principal & Panneau d'Anomalies / Alertes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Graphique de Production & Débit */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-xs border border-slate-200/80 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
              <div>
                <h3 className="text-base font-display font-bold text-slate-900">
                  Évolution Production & Débit
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Analyse temporelle sur {filteredEvolution.length} jours enregistrés
                </p>
              </div>

              <div className="flex items-center gap-2 text-xs font-semibold">
                <button
                  onClick={() => toggleSeries("production")}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                    visibleSeries.production
                      ? "bg-teal-50 text-teal-700 border-teal-200/80"
                      : "bg-slate-50 text-slate-400 border-slate-200 line-through opacity-60"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-teal-600" />
                  Production (T)
                </button>
                <button
                  onClick={() => toggleSeries("debit")}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                    visibleSeries.debit
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200/80"
                      : "bg-slate-50 text-slate-400 border-slate-200 line-through opacity-60"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  Débit (T/h)
                </button>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={filteredEvolution} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="prodGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#0d9488" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="debitGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => formatDateFr(v, "short")}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  stroke="#e2e8f0"
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={(v) => formatNumberFr(v)}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  stroke="#e2e8f0"
                  tickLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, "auto"]}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  stroke="#e2e8f0"
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip />} />

                {visibleSeries.production && (
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="production_t"
                    stroke="#0d9488"
                    fill="url(#prodGrad)"
                    name="Production (T)"
                    strokeWidth={2.5}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                  />
                )}
                {visibleSeries.debit && (
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="debit_th"
                    stroke="#10b981"
                    fill="url(#debitGrad)"
                    name="Débit (T/h)"
                    strokeWidth={2.5}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Panneau d'Anomalies / Alertes Actives (Vue Dédiée) */}
        <div className="bg-white rounded-2xl shadow-xs border border-slate-200/80 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-amber-50 text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-display font-bold text-slate-900">
                    Anomalies & Alertes
                  </h3>
                  <p className="text-[11px] text-slate-400 font-medium">
                    {voirToutHistorique
                      ? `Historique complet (${alertes?.length ?? 0})`
                      : `Urgences des ${FENETRE_ALERTES_RECENTES_JOURS} derniers jours`}
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
                {alertesAffichees.length}
              </span>
            </div>

            {/* Zone Scrollable des cartes d'alertes */}
            <div className="max-h-[310px] overflow-y-auto space-y-2.5 pr-1 custom-scrollbar">
              {alertesAffichees.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500/60 mb-2" />
                  <p className="text-xs font-medium text-slate-500">
                    {voirToutHistorique
                      ? "Aucune alerte enregistrée"
                      : "Aucune alerte récente à signaler"}
                  </p>
                </div>
              ) : (
                alertesAffichees.map((alert, idx) => (
                  <AlertBadge
                    key={idx}
                    alert={alert}
                    onNavigateToPrediction={onNavigateToPrediction}
                  />
                ))
              )}
            </div>
          </div>

          {alertes && alertes.length > alertesRecentes.length && (
            <button
              onClick={() => setVoirToutHistorique((v) => !v)}
              className="w-full mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 hover:text-slate-900 font-bold text-center flex items-center justify-center gap-1 transition-colors cursor-pointer"
            >
              <span>
                {voirToutHistorique
                  ? "Revenir aux urgences récents"
                  : `Voir l'historique complet (${alertes.length})`}
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* KPIs Mensuels */}
      <div className="bg-white rounded-2xl shadow-xs border border-slate-200/80 p-6">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-4">
          <div>
            <h3 className="text-base font-display font-bold text-slate-900">Performance Mensuelle</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Cliquez sur un mois pour filtrer dynamiquement le graphique quotidien
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-semibold text-slate-600">
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-teal-600 rounded-xs" /> Production (T)
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-emerald-500 rounded-xs" /> OEE (%)
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-amber-500 rounded-xs" /> Taux panne (%)
            </span>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={formattedMonthly}
            margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            onClick={(e) => e && e.activePayload && handleMonthlyBarClick(e.activePayload[0].payload)}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="displayMonth"
              tick={{ fontSize: 11, fill: "#64748b" }}
              stroke="#e2e8f0"
              tickLine={false}
            />
            <YAxis
              yAxisId="left"
              tickFormatter={(v) => formatNumberFr(v)}
              tick={{ fontSize: 11, fill: "#64748b" }}
              stroke="#e2e8f0"
              tickLine={false}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 11, fill: "#64748b" }}
              stroke="#e2e8f0"
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />

            <Bar
              yAxisId="left"
              dataKey="production_moyenne_t"
              fill="#0d9488"
              name="Production moy (T)"
              radius={[6, 6, 0, 0]}
              className="cursor-pointer hover:opacity-80 transition-opacity"
            />
            <Bar
              yAxisId="right"
              dataKey="oeeNormalized"
              fill="#10b981"
              name="OEE"
              radius={[6, 6, 0, 0]}
              className="cursor-pointer hover:opacity-80 transition-opacity"
            />
            <Bar
              yAxisId="right"
              dataKey="tauxPanneNormalized"
              fill="#f59e0b"
              name="Taux panne"
              radius={[6, 6, 0, 0]}
              className="cursor-pointer hover:opacity-80 transition-opacity"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}