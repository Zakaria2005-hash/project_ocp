import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Settings, Wrench, AlertTriangle, Clock, Sparkles } from "lucide-react";
import type { EquipmentKPI, ParetoItem } from "@/types";

interface Props {
  equipment: EquipmentKPI[];
  pareto: ParetoItem[];
}

// Palette catégorielle curatée (nuances profondes de la famille de marque +
// accents complémentaires) — nécessaire ici car le nombre de "natures" est
// dynamique et doit rester lisible même au-delà de 5-6 catégories.
const COLORS = ["#0d9488", "#059669", "#d97706", "#e11d48", "#7c3aed", "#0891b2", "#c2410c", "#65a30d"];

export default function EquipmentView({ equipment, pareto }: Props) {
  const [selectedEquip, setSelectedEquip] = useState<string | null>(null);

  const topEquip = equipment.slice(0, 15);
  const selectedData = equipment.find((e) => e.equipement === selectedEquip);

  // Pareto cumulatif
  const totalDuree = pareto.reduce((a, b) => a + b.duree_totale_h, 0);
  let cumul = 0;
  const paretoCumul = pareto.map((p) => {
    cumul += p.duree_totale_h;
    return { ...p, cumul_pct: (cumul / totalDuree) * 100 };
  });

  return (
    <div className="space-y-6">
      {/* En-tête — bande sombre uniforme avec les autres vues */}
      <div className="bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-2xl font-display font-extrabold tracking-tight flex items-center gap-3">
            <span className="flex items-center justify-center h-9 w-9 rounded-xl bg-white/10 border border-white/10 shadow-inner">
              <Settings className="h-4.5 w-4.5 text-emerald-300" />
            </span>
            Analyse par Équipement
          </h2>
          <p className="text-sm text-emerald-100/70 mt-1 ml-[46px]">
            Pareto des arrêts — MTTR/MTBF — Répartition par nature
          </p>
        </div>
      </div>

      {/* Cartes KPI récapitulatives — anatomie unifiée avec les autres vues */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Équipements suivis</span>
            <div className="p-2.5 rounded-xl bg-teal-50 text-teal-600 border border-teal-100">
              <Wrench className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">{equipment.length}</p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Durée totale d'arrêt</span>
            <div className="p-2.5 rounded-xl bg-rose-50 text-rose-600 border border-rose-100">
              <AlertTriangle className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {equipment.reduce((a, b) => a + b.duree_totale_h, 0).toFixed(0)}h
          </p>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-slate-200/70 shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Durée moyenne/arrêt</span>
            <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600 border border-amber-100">
              <Clock className="h-5 w-5" />
            </div>
          </div>
          <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
            {(
              equipment.reduce((a, b) => a + b.duree_totale_h, 0) /
              Math.max(equipment.reduce((a, b) => a + b.occurrences, 0), 1)
            ).toFixed(2)}h
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pareto */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-lg font-display font-bold text-slate-800 mb-4">Pareto des Causes de Panne (Top 10)</h3>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={paretoCumul.slice(0, 10)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis dataKey="cause" type="category" tick={{ fontSize: 9 }} width={180} />
              <Tooltip
                formatter={(v: number, n: string) => {
                  if (n === "duree_totale_h") return [`${v.toFixed(1)}h`, "Durée"];
                  if (n === "cumul_pct") return [`${v.toFixed(1)}%`, "% cumulé"];
                  return [v, n];
                }}
              />
              <Legend />
              <Bar dataKey="duree_totale_h" fill="#0d9488" name="Durée (h)" radius={[0, 4, 4, 0]} />
              <Bar dataKey="cumul_pct" fill="#d97706" name="% cumulé" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Equipment bar chart */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-lg font-display font-bold text-slate-800 mb-4">Top Équipements par Durée d'Arrêt</h3>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={topEquip} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis dataKey="equipement" type="category" tick={{ fontSize: 10 }} width={80} />
              <Tooltip formatter={(v: number) => [`${v.toFixed(1)}h`, "Durée totale"]} />
              <Bar dataKey="duree_totale_h" fill="#e11d48" radius={[0, 4, 4, 0]} name="Durée (h)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Equipment detail table */}
      <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
        <h3 className="text-lg font-display font-bold text-slate-800 mb-4">Détail par Équipement</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left p-3 text-[11px] font-bold uppercase tracking-wider">Équipement</th>
                <th className="text-right p-3 text-[11px] font-bold uppercase tracking-wider">Durée totale (h)</th>
                <th className="text-right p-3 text-[11px] font-bold uppercase tracking-wider">Occurrences</th>
                <th className="text-right p-3 text-[11px] font-bold uppercase tracking-wider">Durée moy (h)</th>
                <th className="text-left p-3 text-[11px] font-bold uppercase tracking-wider">Répartition nature</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {equipment.slice(0, 20).map((eq) => (
                <tr
                  key={eq.equipement}
                  className={`hover:bg-teal-50/50 cursor-pointer transition-colors ${selectedEquip === eq.equipement ? "bg-teal-50" : ""}`}
                  onClick={() => setSelectedEquip(eq.equipement === selectedEquip ? null : eq.equipement)}
                >
                  <td className="p-3 font-semibold text-slate-700">{eq.equipement}</td>
                  <td className="p-3 text-right tabular-nums text-slate-600">{eq.duree_totale_h.toFixed(2)}</td>
                  <td className="p-3 text-right tabular-nums text-slate-600">{eq.occurrences}</td>
                  <td className="p-3 text-right tabular-nums text-slate-600">{eq.duree_moyenne_h.toFixed(2)}</td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {eq.by_nature.slice(0, 3).map((bn, i) => (
                        <span
                          key={i}
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200"
                        >
                          {bn.nature}: {bn.count}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected equipment detail */}
      {selectedData && (
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-lg font-display font-bold text-slate-800 mb-4">
            Détail: {selectedData.equipement}
          </h3>
          <div className="flex justify-center">
            <ResponsiveContainer width={400} height={300}>
              <PieChart>
                <Pie
                  data={selectedData.by_nature}
                  dataKey="duree"
                  nameKey="nature"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {selectedData.by_nature.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => [`${v.toFixed(2)}h`, "Durée"]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}