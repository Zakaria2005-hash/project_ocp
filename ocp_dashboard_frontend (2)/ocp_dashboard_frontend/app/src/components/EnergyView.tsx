import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { Zap, TrendingUp, TrendingDown, Flame, Info, Coins, Activity, Target, Download, Loader2, Sparkles } from "lucide-react";
import type { EnergyData, ObjectifsEnergetiques } from "@/types";
import { API_BASE, fetchJson } from "@/hooks/useData";

interface Props {
  data: EnergyData[];
}

const BASELINE_KCALT = 160_000;

type CombustibleKey = "cs_gaz_nm3t" | "cs_gazoline_kgt" | "cs_fuel_kgt";

const COMBUSTIBLES: { label: string; key: CombustibleKey; unit: string; color: string; stroke: string }[] = [
  { label: "Cs Gaz", key: "cs_gaz_nm3t", unit: "Nm3/T", color: "bg-blue-500", stroke: "#3b82f6" },
  { label: "Cs Gazoline", key: "cs_gazoline_kgt", unit: "kg/T", color: "bg-emerald-500", stroke: "#10b981" },
  { label: "Cs Fuel", key: "cs_fuel_kgt", unit: "kg/T", color: "bg-amber-500", stroke: "#f59e0b" },
];

function formatDH(v: number): string {
  const abs = Math.abs(v);
  const formatted = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(0);
  return `${v >= 0 ? "+" : "-"}${formatted} DH`;
}

type PresetPeriode = "7J" | "30J" | "90J" | "180J" | "TOUS";
const PRESETS: PresetPeriode[] = ["7J", "30J", "90J", "180J", "TOUS"];

function formatMoisFr(isoDate: string): string {
  const libelle = new Date(isoDate).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return libelle.charAt(0).toUpperCase() + libelle.slice(1);
}

export default function EnergyView({ data: dataBrute }: Props) {
  const [combustibleActif, setCombustibleActif] = useState<CombustibleKey | null>(null);
  const [preset, setPreset] = useState<PresetPeriode>("TOUS");
  const [moisFiltre, setMoisFiltre] = useState<string | null>(null);
  const [fuelMode, setFuelMode] = useState<"ALL" | "GAZ" | "GAZOLINE" | "FUEL">("ALL");

  // ── Objectifs Énergétiques ──
  const [objectifs, setObjectifs] = useState<ObjectifsEnergetiques | null>(null);
  const [objectifsLoading, setObjectifsLoading] = useState(true);
  const [objectifsError, setObjectifsError] = useState<string | null>(null);


  useEffect(() => {
    let cancelled = false;

    fetchJson<ObjectifsEnergetiques>("/dashboard/energy/objectifs/")
      .then((res) => {
        if (!cancelled) {
          setObjectifs(res);
          setObjectifsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setObjectifsError((err as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setObjectifsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);
  // Calcul de la Dérive Thermique avec typage sécurisé
  const donneesAvecDerive = useMemo(
    () =>
      dataBrute.map((d) => {
        const conso = d.conso_energie_kcalt != null ? Number(d.conso_energie_kcalt) : null;
        const derive =
          d.derive_thermique_pct != null
            ? Number(d.derive_thermique_pct)
            : conso != null
            ? ((conso - BASELINE_KCALT) / BASELINE_KCALT) * 100
            : null;

        return {
          ...d,
          conso_energie_kcalt: conso,
          derive_thermique_pct: derive,
          cs_gaz_nm3t: d.cs_gaz_nm3t != null ? Number(d.cs_gaz_nm3t) : null,
          cs_gazoline_kgt: d.cs_gazoline_kgt != null ? Number(d.cs_gazoline_kgt) : null,
          cs_fuel_kgt: d.cs_fuel_kgt != null ? Number(d.cs_fuel_kgt) : null,
        };
      }),
    [dataBrute]
  );

  const moisDisponibles = useMemo(() => {
    const mois = new Set<string>();
    donneesAvecDerive.forEach((d) => {
      if (d.date) mois.add(d.date.slice(0, 7));
    });
    return Array.from(mois).sort();
  }, [donneesAvecDerive]);

  const dataFiltree = useMemo(() => {
    if (moisFiltre) {
      return donneesAvecDerive.filter((d) => d.date && d.date.startsWith(moisFiltre));
    }
    if (preset === "TOUS" || donneesAvecDerive.length === 0) return donneesAvecDerive;

    const derniereDate = donneesAvecDerive[donneesAvecDerive.length - 1].date;
    if (!derniereDate) return donneesAvecDerive;

    const fin = new Date(derniereDate);
    const debut = new Date(derniereDate);
    const joursParPreset: Record<Exclude<PresetPeriode, "TOUS">, number> = {
      "7J": 7,
      "30J": 30,
      "90J": 90,
      "180J": 180,
    };
    debut.setDate(debut.getDate() - joursParPreset[preset]);

    return donneesAvecDerive.filter((d) => {
      if (!d.date) return false;
      const dt = new Date(d.date);
      return dt >= debut && dt <= fin;
    });
  }, [donneesAvecDerive, preset, moisFiltre]);

  const data = dataFiltree;

  const avgConso = data.reduce((a, b) => a + (b.conso_energie_kcalt || 0), 0) / Math.max(data.length, 1);
  const avgDerive = data.reduce((a, b) => a + (b.derive_thermique_pct || 0), 0) / Math.max(data.length, 1);
  const highDeriveDays = data.filter((d) => (d.derive_thermique_pct || 0) > 15).length;
  const deriveEstGain = avgDerive < 0;

  const fuelBaselines = useMemo(() => {
    if (!donneesAvecDerive || donneesAvecDerive.length === 0) {
      return { GAZ: 12.5, GAZOLINE: 11.5, FUEL: 12.0 };
    }
    const gaz = donneesAvecDerive.map((d) => d.cs_gaz_nm3t).filter((v): v is number => v != null && v > 0);
    const gazoline = donneesAvecDerive.map((d) => d.cs_gazoline_kgt).filter((v): v is number => v != null && v > 0);
    const fuel = donneesAvecDerive.map((d) => d.cs_fuel_kgt).filter((v): v is number => v != null && v > 0);

    return {
      GAZ: gaz.length > 0 ? gaz.reduce((a, b) => a + b, 0) / gaz.length : 12.5,
      GAZOLINE: gazoline.length > 0 ? gazoline.reduce((a, b) => a + b, 0) / gazoline.length : 11.5,
      FUEL: fuel.length > 0 ? fuel.reduce((a, b) => a + b, 0) / fuel.length : 12.0,
    };
  }, [donneesAvecDerive]);

  const impactFinancierTotalDH = useMemo(() => {
    let total = 0;
    const costs = { ALL: 0.00012, GAZ: 4.50, GAZOLINE: 11.00, FUEL: 8.00 };
    const cost = costs[fuelMode];

    data.forEach((d) => {
      const prod = d.production_t ?? 0;
      if (prod <= 0) return;

      let conso: number | null = null;
      let baseline = 0;

      if (fuelMode === "ALL") {
        conso = d.conso_energie_kcalt;
        baseline = BASELINE_KCALT;
      } else if (fuelMode === "GAZ") {
        conso = d.cs_gaz_nm3t;
        baseline = fuelBaselines.GAZ;
      } else if (fuelMode === "GAZOLINE") {
        conso = d.cs_gazoline_kgt;
        baseline = fuelBaselines.GAZOLINE;
      } else if (fuelMode === "FUEL") {
        conso = d.cs_fuel_kgt;
        baseline = fuelBaselines.FUEL;
      }

      if (conso != null && !isNaN(conso)) {
        const diff = conso - baseline;
        total += diff * prod * cost;
      }
    });

    return total;
  }, [data, fuelMode, fuelBaselines]);

  const isSurcout = impactFinancierTotalDH > 0;

  // Données de corrélation
  const correlationData = useMemo(() => {
    return data
      .filter((d) => d.debit_th != null && d.conso_energie_kcalt != null && d.debit_th > 0)
      .map((d) => ({
        date: d.date,
        debit: Number(d.debit_th),
        conso: Number(d.conso_energie_kcalt),
        production: d.production_t || 0,
      }));
  }, [data]);

  const zoneOptimale = useMemo(() => {
    if (correlationData.length < 10) return null;
    const debits = correlationData.map((d) => d.debit);
    const debitMin = Math.min(...debits);
    const debitMax = Math.max(...debits);
    if (debitMax <= debitMin) return null;

    const nbBins = 8;
    const largeur = (debitMax - debitMin) / nbBins;
    const bins = Array.from({ length: nbBins }, (_, i) => ({
      debut: debitMin + i * largeur,
      fin: debitMin + (i + 1) * largeur,
      valeurs: [] as number[],
    }));

    correlationData.forEach((d) => {
      const idx = Math.min(nbBins - 1, Math.floor((d.debit - debitMin) / largeur));
      bins[idx].valeurs.push(d.conso);
    });

    const binsValides = bins
      .filter((b) => b.valeurs.length >= 2)
      .map((b) => ({ ...b, moyenne: b.valeurs.reduce((a, c) => a + c, 0) / b.valeurs.length }));

    if (binsValides.length === 0) return null;

    const meilleur = binsValides.reduce((min, b) => (b.moyenne < min.moyenne ? b : min));
    return { debut: meilleur.debut, fin: meilleur.fin, consoMoyenne: meilleur.moyenne };
  }, [correlationData]);

  const debitMaxAxe = Math.max(600, ...correlationData.map((d) => d.debit), 0) + 20;

  return (
    <div className="space-y-6">
      {/* En-tête — bande sombre uniforme avec les autres vues */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-xl font-display font-extrabold tracking-tight flex items-center gap-2.5">
            <span className="flex items-center justify-center h-9 w-9 rounded-xl bg-white/10 border border-white/10 shadow-inner">
              <Zap className="h-4.5 w-4.5 text-amber-300" />
            </span>
            Efficience Énergétique
          </h2>
          <p className="text-xs font-medium text-emerald-100/70 ml-[46px]">
            Modélisation thermique — Dérives énergétiques et régimes optimaux
          </p>
        </div>

        {/* Filtres Temporels */}
        <div className="relative z-10 flex items-center gap-3 flex-wrap">
          <div className="flex items-center bg-emerald-950/60 p-1 rounded-xl border border-emerald-700/50 backdrop-blur-md">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPreset(p);
                  setMoisFiltre(null);
                }}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  preset === p && !moisFiltre
                    ? "bg-white text-emerald-900 shadow-sm"
                    : "text-emerald-200/70 hover:text-white"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <select
            value={moisFiltre ?? ""}
            onChange={(e) => setMoisFiltre(e.target.value || null)}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-emerald-700/50 text-emerald-50 bg-emerald-950/60 backdrop-blur-md shadow-sm focus:ring-2 focus:ring-amber-400/40 focus:outline-none"
          >
            <option value="" className="bg-emerald-950 text-emerald-50">Par mois…</option>
            {moisDisponibles.map((m) => (
              <option key={m} value={m} className="bg-emerald-950 text-emerald-50">
                {formatMoisFr(m + "-01")}
              </option>
            ))}
          </select>
        </div>
      </div>

      {moisFiltre && (
        <p className="text-xs text-slate-500 -mt-2 px-1">
          Période affichée : <span className="font-semibold text-slate-800">{formatMoisFr(moisFiltre + "-01")}</span> ({dataFiltree.length} jours) —{" "}
          <button onClick={() => setMoisFiltre(null)} className="text-teal-700 font-semibold underline hover:text-teal-800">
            réinitialiser
          </button>
        </p>
      )}

      {/* Cartes KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {/* KPI 1 : Impact Financier */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between h-full min-h-[150px]">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                Impact Financier
                <span title="Impact = (Conso - Baseline) × Production × Coût" className="cursor-help">
                  <Info className="h-3 w-3 text-slate-400 hover:text-slate-600" />
                </span>
              </span>
              <div className={`p-2.5 rounded-xl ${isSurcout ? "bg-red-50 text-red-600 border border-red-100" : "bg-emerald-50 text-emerald-600 border border-emerald-100"}`}>
                <Coins className="h-5 w-5" />
              </div>
            </div>

            <div className="flex items-baseline gap-1">
              <span className={`text-2xl font-display font-extrabold tracking-tight tabular-nums ${isSurcout ? "text-red-600" : "text-emerald-600"}`}>
                {isSurcout ? "+" : ""}
                {Math.abs(impactFinancierTotalDH) >= 1_000_000
                  ? `${(impactFinancierTotalDH / 1_000_000).toFixed(2)}M`
                  : Math.abs(impactFinancierTotalDH) >= 10_000
                  ? `${(impactFinancierTotalDH / 1_000).toFixed(1)}k`
                  : impactFinancierTotalDH.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}
              </span>
              <span className="text-xs font-semibold text-slate-400">DH</span>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-100 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                isSurcout
                  ? "bg-red-50 text-red-700 border-red-200/60"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200/60"
              }`}>
                {isSurcout ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {isSurcout ? "Surcoût" : "Économie"}
              </span>
            </div>

            <div className="grid grid-cols-4 gap-0.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200/60 w-full text-center">
              {(["ALL", "GAZ", "GAZOLINE", "FUEL"] as const).map((key) => (
                <button
                  key={key}
                  onClick={() => setFuelMode(key)}
                  className={`py-0.5 rounded text-[8.5px] font-bold transition-all truncate ${
                    fuelMode === key
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-400 hover:text-slate-700"
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* KPI 2 : Conso. Moyenne */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between h-full min-h-[150px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Conso. Moyenne
            </span>
            <div className="p-2.5 bg-amber-50 text-amber-700 rounded-xl border border-amber-100">
              <Flame className="h-5 w-5" />
            </div>
          </div>
          <div>
            <p className="text-2xl font-display font-extrabold text-slate-900 tracking-tight tabular-nums">
              {avgConso.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}
            </p>
            <p className="text-xs font-medium text-slate-400 mt-0.5">kcal/T</p>
          </div>
        </div>

        {/* KPI 3 : Dérive Moyenne */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between h-full min-h-[150px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Dérive Moyenne
            </span>
            <div className={`p-2 rounded-xl border ${
              deriveEstGain ? "bg-emerald-50 text-emerald-600 border-emerald-100" : "bg-red-50 text-red-600 border-red-100"
            }`}>
              {deriveEstGain ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
            </div>
          </div>
          <div>
            <p className={`text-2xl font-display font-extrabold tracking-tight tabular-nums ${deriveEstGain ? "text-emerald-600" : "text-red-600"}`}>
              {avgDerive > 0 ? "+" : ""}
              {avgDerive.toFixed(1)}%
            </p>
            <p className="text-xs font-medium text-slate-400 mt-0.5">
              {deriveEstGain ? "Gain vs baseline" : "Sur-conso vs baseline"}
            </p>
          </div>
        </div>

        {/* KPI 4 : Jours Critiques */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between h-full min-h-[150px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Jours Critiques
            </span>
            <div className="p-2.5 bg-amber-50 text-amber-600 rounded-xl border border-amber-100">
              <Activity className="h-5 w-5" />
            </div>
          </div>
          <div>
            <p className="text-2xl font-display font-extrabold text-slate-900 tracking-tight tabular-nums">{highDeriveDays}</p>
            <p className="text-xs font-medium text-slate-400 mt-0.5">dérive &gt; 15%</p>
          </div>
        </div>

        {/* KPI 5 : Baseline Usine */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-5 border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 flex flex-col justify-between h-full min-h-[150px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Baseline Usine
            </span>
            <div className="p-2.5 bg-teal-50 text-teal-600 rounded-xl border border-teal-100">
              <Target className="h-5 w-5" />
            </div>
          </div>
          <div>
            <p className="text-2xl font-display font-extrabold text-slate-900 tracking-tight tabular-nums">
              {BASELINE_KCALT.toLocaleString("fr-FR")}
            </p>
            <p className="text-xs font-medium text-slate-400 mt-0.5">kcal/T (cible)</p>
          </div>
        </div>
      </div>

      {/* Section Objectifs Énergétiques + Export */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200/70 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)]">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
          <h3 className="text-base font-display font-bold text-slate-900 flex items-center gap-2">
            <Target className="h-4 w-4 text-blue-600" />
            Objectifs Énergétiques
          </h3>
          <a
            href={`${API_BASE}/dashboard/energy/export/`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Exporter (CSV)
          </a>
        </div>

        {objectifsLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
          </div>
        ) : objectifsError ? (
          <p className="text-sm text-rose-600">Indisponible ({objectifsError})</p>
        ) : objectifs ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Baseline</p>
              <p className="text-lg font-extrabold text-slate-900">{objectifs.baseline_kcalt?.toLocaleString("fr-FR") ?? "N/A"}</p>
              <p className="text-xs text-slate-400">kcal/T</p>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Objectif (-{objectifs.marge_progres_pct ?? 0}%)
              </p>
              <p className="text-lg font-extrabold text-blue-600">{objectifs.objectif_kcalt?.toLocaleString("fr-FR") ?? "N/A"}</p>
              <p className="text-xs text-slate-400">kcal/T</p>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Conso. moyenne réalisée</p>
              <p className="text-lg font-extrabold text-slate-900">
                {objectifs.conso_moyenne_kcalt != null ? objectifs.conso_moyenne_kcalt.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) : "N/A"}
              </p>
              <p className="text-xs text-slate-400">
                {objectifs.jours_sous_objectif ?? 0} / {objectifs.nb_jours_evalues ?? 0} jours sous objectif
              </p>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Écart vs objectif</p>
              <p className={`text-lg font-extrabold ${(objectifs.ecart_vs_objectif_pct ?? 0) <= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {objectifs.ecart_vs_objectif_pct != null
                  ? `${objectifs.ecart_vs_objectif_pct > 0 ? "+" : ""}${objectifs.ecart_vs_objectif_pct.toFixed(1)}%`
                  : "N/A"}
              </p>
              <p className="text-xs text-slate-400">{(objectifs.ecart_vs_objectif_pct ?? 0) <= 0 ? "Objectif atteint" : "Dépassement"}</p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Section Graphique Temporel */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200/70 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)]">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-6">
          <h3 className="text-base font-display font-bold text-slate-900">
            {combustibleActif
              ? `${COMBUSTIBLES.find((c) => c.key === combustibleActif)?.label} — Évolution temporelle`
              : "Consommation d'Énergie & Dérive Thermique"}
          </h3>
          {combustibleActif && (
            <button
              onClick={() => setCombustibleActif(null)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              ← Vue globale
            </button>
          )}
        </div>

        {combustibleActif ? (
          <div className="h-[350px] w-full min-h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) =>
                    v ? new Date(v).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : ""
                  }
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  interval="preserveStartEnd"
                />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "#64748b" }} width={70} />
                <Tooltip
                  formatter={(value) => [
                    `${Number(value || 0).toFixed(2)} ${COMBUSTIBLES.find((c) => c.key === combustibleActif)?.unit}`,
                    COMBUSTIBLES.find((c) => c.key === combustibleActif)?.label,
                  ]}
                  labelFormatter={(label) =>
                    new Date(label).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })
                  }
                />
                <Line
                  type="monotone"
                  dataKey={combustibleActif}
                  stroke={COMBUSTIBLES.find((c) => c.key === combustibleActif)?.stroke}
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col gap-6 w-full">
            {/* 1. Conso Énergie */}
            <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-3">
                Consommation d'Énergie (kcal/T)
              </span>
              <div className="h-[200px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" hide={true} />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 11, fill: "#64748b" }}
                      tickFormatter={(v) => Number(v || 0).toLocaleString("fr-FR")}
                      width={70}
                    />
                    <Tooltip
                      formatter={(value) => [
                        `${Number(value || 0).toLocaleString("fr-FR")} kcal/T`,
                        "Consommation",
                      ]}
                      labelFormatter={(label) =>
                        new Date(label).toLocaleDateString("fr-FR", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })
                      }
                    />
                    <Line
                      type="monotone"
                      dataKey="conso_energie_kcalt"
                      stroke="#d97706"
                      strokeWidth={2.5}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 2. Dérive Thermique avec repères */}
            <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Dérive Thermique (%) — Écart / Baseline
                </span>
                <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-slate-500 rounded-full inline-block"></span> Baseline (0%)
                  </span>
                  <span className="flex items-center gap-1.5 text-red-500">
                    <span className="w-3 h-0.5 border-t border-dashed border-red-500 inline-block"></span> Alerte (+15%)
                  </span>
                </div>
              </div>
              <div className="h-[230px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v) =>
                        v ? new Date(v).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : ""
                      }
                      tick={{ fontSize: 10, fill: "#64748b" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 11, fill: "#64748b" }}
                      tickFormatter={(v) => `${Number(v || 0).toFixed(0)}%`}
                      width={70}
                    />

                    <ReferenceLine
                      y={0}
                      stroke="#64748b"
                      strokeWidth={1.5}
                      label={{
                        value: "Baseline (0%)",
                        fill: "#64748b",
                        fontSize: 10,
                        position: "insideBottomLeft",
                      }}
                    />

                    <ReferenceLine
                      y={15}
                      stroke="#ef4444"
                      strokeDasharray="3 3"
                      strokeWidth={1.5}
                      label={{
                        value: "Alerte (+15%)",
                        fill: "#ef4444",
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />

                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || !payload.length) return null;
                        const item = payload[0].payload;
                        const val = Number(item?.derive_thermique_pct || 0);
                        const impact = item?.impact_financier_dh;
                        return (
                          <div className="bg-slate-900/90 backdrop-blur-md text-white p-3 rounded-xl shadow-xl border border-slate-700/50 text-xs space-y-1">
                            <p className="font-bold text-slate-200 border-b border-slate-700/80 pb-1 mb-1">
                              {label ? new Date(label).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : ""}
                            </p>
                            <p className="text-slate-300">
                              Dérive : <span className="font-semibold text-white">{`${val > 0 ? "+" : ""}${val.toFixed(1)} %`}</span>
                            </p>
                            {impact != null && (
                              <p className={`font-semibold ${impact > 0 ? "text-red-400" : "text-emerald-400"}`}>
                                Impact : {formatDH(impact)} / jour
                              </p>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="derive_thermique_pct"
                      stroke="#ef4444"
                      strokeWidth={2.5}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Corrélation + Consommations spécifiques */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* CORRÉLATION */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200/70 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)]">
          <div className="mb-4">
            <h3 className="text-base font-display font-bold text-slate-900">
              Corrélation Débit vs Consommation Énergétique
            </h3>
            {zoneOptimale && (
              <p className="text-xs font-medium text-slate-500 mt-1 flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 bg-emerald-500 rounded-sm" />
                Régime optimal : <strong className="text-slate-800">{zoneOptimale.debut.toFixed(0)}–{zoneOptimale.fin.toFixed(0)} T/h</strong> (conso. moyenne : {zoneOptimale.consoMoyenne.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} kcal/T)
              </p>
            )}
          </div>

          <div className="h-[300px] w-full min-h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="debit"
                  type="number"
                  domain={[0, debitMaxAxe]}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickFormatter={(v) => `${v} T/h`}
                />
                <YAxis
                  dataKey="conso"
                  type="number"
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickFormatter={(v) => Number(v).toLocaleString("fr-FR")}
                />
                <ZAxis dataKey="production" range={[60, 400]} />

                {zoneOptimale && (
                  <ReferenceArea
                    x1={zoneOptimale.debut}
                    x2={zoneOptimale.fin}
                    fill="#10b981"
                    fillOpacity={0.12}
                    stroke="#10b981"
                    strokeOpacity={0.4}
                    strokeDasharray="4 4"
                    label={{ value: "Régime optimal", position: "insideTop", fill: "#059669", fontSize: 11, fontWeight: 600 }}
                  />
                )}

                <Tooltip
                  cursor={{ strokeDasharray: "3 3", stroke: "#94a3b8" }}
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const point = payload[0].payload;
                    return (
                      <div className="bg-slate-900/90 backdrop-blur-md text-white p-3 rounded-xl shadow-xl border border-slate-700/50 text-xs space-y-1">
                        <p className="font-bold text-slate-200 border-b border-slate-700/80 pb-1 mb-1">
                          {point.date ? new Date(point.date).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : "Point de mesure"}
                        </p>
                        <p className="flex justify-between gap-4 text-slate-300">
                          <span>Débit :</span>
                          <span className="font-semibold text-white">{point.debit?.toFixed(1)} T/h</span>
                        </p>
                        <p className="flex justify-between gap-4 text-slate-300">
                          <span>Conso :</span>
                          <span className="font-semibold text-amber-500">{point.conso?.toLocaleString("fr-FR")} kcal/T</span>
                        </p>
                        <p className="flex justify-between gap-4 text-slate-300">
                          <span>Production :</span>
                          <span className="font-semibold text-white">{point.production?.toLocaleString("fr-FR")} T</span>
                        </p>
                      </div>
                    );
                  }}
                />

                <Scatter data={correlationData} fill="#d97706" fillOpacity={0.75} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Consommations Spécifiques */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200/70 shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] flex flex-col justify-between">
          <div>
            <h3 className="text-base font-display font-bold text-slate-900 mb-1">Consommations Spécifiques</h3>
            <p className="text-xs font-medium text-slate-400 mb-5 flex items-center gap-1">
              <Info className="h-3.5 w-3.5" />
              Cliquez sur un combustible pour filtrer sa courbe dans la vue temporelle
            </p>

            <div className="space-y-4">
              {COMBUSTIBLES.map((item) => {
                const values = data.filter((d) => d[item.key] != null).map((d) => d[item.key] as number);
                const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
                const max = values.length > 0 ? Math.max(...values) : 0;
                const isActive = combustibleActif === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => setCombustibleActif(isActive ? null : item.key)}
                    className={`w-full text-left rounded-xl p-3.5 transition-all border ${
                      isActive
                        ? "bg-slate-50 border-slate-300 shadow-sm"
                        : "border-slate-100 hover:border-slate-200 hover:bg-slate-50/50"
                    }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-bold text-slate-800 flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${item.color}`} />
                        {item.label}
                      </span>
                      <span className="text-xs font-semibold text-slate-600">
                        Moy: {avg.toFixed(2)} {item.unit} <span className="text-slate-300 mx-1">|</span> Max: {max.toFixed(2)}
                      </span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                      <div
                        className={`${item.color} h-2 rounded-full transition-all duration-300`}
                        style={{ width: `${Math.min((avg / Math.max(max, 1)) * 100, 100)}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}