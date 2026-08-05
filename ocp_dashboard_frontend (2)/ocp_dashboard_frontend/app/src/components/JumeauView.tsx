import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
  ReferenceLine,
} from "recharts";
import {
  Factory,
  Play,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Loader2,
  Lightbulb,
  Train,
  Pause as PauseIcon,
  Shuffle,
  Plus,
  X,
  Sparkles,
} from "lucide-react";

const CAPACITE_MAX_SILOS = 25000;
const CAPACITE_NOMINALE_FOURS = 450;
const CADENCE_NOMINALE_TRAINS = 150;

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000/api/analytics";

interface TrajectoirePoint {
  heure: number;
  stock_amont_t: number;
  stock_aval_t: number;
  taux_remplissage_pct: number;
  statut: "VERT" | "ORANGE" | "ROUGE";
}

interface AlerteFlux {
  heure: number;
  niveau: "ORANGE" | "ROUGE";
  message: string;
}

interface EvenementFlux {
  heure: number;
  type: "train" | "pause_debut" | "pause_fin";
  detail: string;
}

interface BandePoint {
  heure: number;
  stock_aval_min: number;
  stock_aval_moyen: number;
  stock_aval_max: number;
  stock_amont_moyen: number;
  taux_min: number;
  taux_moyen: number;
  taux_max: number;
}

interface Pause {
  debut_h: number;
  duree_h: number;
}

interface ParametresSimulation {
  stock_amont_initial_t: number;
  debit_fours_th: number;
  stock_aval_initial_t: number;
  capacite_silos_t: number;
  cadence_trains_th: number;
  horizon_h: number;
  flux_net_th: number;
  mode_trains: "continu" | "discret";
  train_capacite_t: number | null;
  train_intervalle_h: number | null;
  pauses: Pause[];
}

interface PlanActionOption {
  titre: string;
  description: string;
  parametre: "debit_fours_th" | "cadence_trains_th";
  valeur_actuelle: number;
  valeur_suggeree: number;
}

interface SimulationResponse {
  mode: "deterministe" | "monte_carlo";
  parametres: ParametresSimulation;
  trajectoire: TrajectoirePoint[];
  evenements: EvenementFlux[];
  alertes: AlerteFlux[];
  saturation_prevue_h: number | null;
  rupture_prevue_h: number | null;
  rupture_amont_prevue_h: number | null;
  suggestion: string | null;
  plan_action: PlanActionOption[];
  resume: string;
  bande?: BandePoint[];
  probabilite_saturation_pct?: number;
  probabilite_rupture_pct?: number;
  probabilite_rupture_amont_pct?: number;
  n_iterations?: number;
}

interface ScenarioSauvegarde {
  label: string;
  simulation: SimulationResponse;
}

export default function JumeauView() {
  const [stockAmont, setStockAmont] = useState(8000);
  const [debitProd, setDebitProd] = useState(200);
  const [stockAval, setStockAval] = useState(4000);
  const [cadenceTrains, setCadenceTrains] = useState(CADENCE_NOMINALE_TRAINS);
  const [dureeSim, setDureeSim] = useState(24);

  // Configuration des trains
  const [modeTrains, setModeTrains] = useState<"continu" | "discret">("discret");
  const [trainCapacite, setTrainCapacite] = useState(3500);
  const [trainIntervalle, setTrainIntervalle] = useState(4);

  // Pauses programmées
  const [pauses, setPauses] = useState<Pause[]>([]);
  const ajouterPause = () => setPauses((p) => [...p, { debut_h: 10, duree_h: 3 }]);
  const retirerPause = (index: number) => setPauses((p) => p.filter((_, i) => i !== index));
  const modifierPause = (index: number, champ: keyof Pause, valeur: number) =>
    setPauses((p) => p.map((pause, i) => (i === index ? { ...pause, [champ]: valeur } : pause)));

  // Variabilité stochastique / Monte-Carlo
  const [aleas, setAleas] = useState(false);
  const [aleasPct, setAleasPct] = useState(10);
  const [nIterations, setNIterations] = useState(200);

  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [planActionVisible, setPlanActionVisible] = useState(false);

  function appliquerOption(option: PlanActionOption) {
    if (option.parametre === "debit_fours_th") setDebitProd(Math.round(option.valeur_suggeree));
    else setCadenceTrains(Math.round(option.valeur_suggeree));
    setPlanActionVisible(false);
  }

  const [scenarioA, setScenarioA] = useState<ScenarioSauvegarde | null>(null);
  const [scenarioB, setScenarioB] = useState<ScenarioSauvegarde | null>(null);

  function enregistrerScenario(slot: "A" | "B") {
    if (!simulation) return;
    const label = window.prompt(
      `Nom du scénario ${slot} :`,
      slot === "A" ? "Nominale" : `Alternatif`
    );
    if (label === null) return;
    const snapshot: ScenarioSauvegarde = { label: label || `Scénario ${slot}`, simulation };
    if (slot === "A") setScenarioA(snapshot);
    else setScenarioB(snapshot);
  }

  const donneesComparaison = useMemo(() => {
    if (!scenarioA || !scenarioB) return [];
    const horizonMax = Math.max(
      scenarioA.simulation.trajectoire.length,
      scenarioB.simulation.trajectoire.length
    );
    const parHeureA = new Map(scenarioA.simulation.trajectoire.map((p) => [p.heure, p]));
    const parHeureB = new Map(scenarioB.simulation.trajectoire.map((p) => [p.heure, p]));
    return Array.from({ length: horizonMax }, (_, h) => ({
      heure: h,
      A_stock_aval: parHeureA.get(h)?.stock_aval_t ?? null,
      B_stock_aval: parHeureB.get(h)?.stock_aval_t ?? null,
    }));
  }, [scenarioA, scenarioB]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSimulation = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/simulate-flux/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stock_amont_t: stockAmont,
          debit_fours_th: debitProd,
          stock_aval_t: stockAval,
          capacite_silos_t: CAPACITE_MAX_SILOS,
          cadence_trains_th: cadenceTrains,
          horizon_h: dureeSim,
          mode_trains: modeTrains,
          train_capacite_t: modeTrains === "discret" ? trainCapacite : null,
          train_intervalle_h: modeTrains === "discret" ? trainIntervalle : null,
          pauses,
          aleas,
          aleas_pct: aleasPct,
          n_iterations: nIterations,
        }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const corpsErreur = await res.json();
          if (corpsErreur?.error) detail = corpsErreur.error;
        } catch {}
        throw new Error(`Échec de la simulation : ${detail}`);
      }
      const json: SimulationResponse = await res.json();
      setSimulation(json);
    } catch (err) {
      setError((err as Error).message);
      setSimulation(null);
    } finally {
      setLoading(false);
    }
  };

  const derniereAlerte = simulation?.alertes[simulation.alertes.length - 1];
  const alertLevel: "vert" | "orange" | "rouge" =
    derniereAlerte?.niveau === "ROUGE" ? "rouge" : derniereAlerte?.niveau === "ORANGE" ? "orange" : "vert";
  const finalPoint = simulation?.trajectoire[simulation.trajectoire.length - 1];

  const fluxEvacuationEffectif =
    modeTrains === "continu" ? cadenceTrains : trainCapacite / trainIntervalle;
  const fluxNetAffiche = debitProd - fluxEvacuationEffectif;

  const capaciteRestante = finalPoint ? Math.max(0, CAPACITE_MAX_SILOS - finalPoint.stock_aval_t) : null;

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 p-6 rounded-2xl shadow-[0_8px_32px_-8px_rgba(4,120,87,0.35)] border border-emerald-800/40 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="h-4 w-4" />
            <span>OCP Digital Analytics Platform</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-display font-extrabold tracking-tight flex items-center gap-3">
            <span className="flex items-center justify-center h-9 w-9 rounded-xl bg-white/10 border border-white/10 shadow-inner">
              <Factory className="h-4.5 w-4.5 text-emerald-300" />
            </span>
            Jumeau Numérique de Flux
          </h2>
          <p className="text-emerald-100/70 text-sm mt-1 max-w-xl ml-[46px]">
            Simulation prédictive de la balance des masses — calculée par le backend Django
          </p>
        </div>
      </div>

      {/* Paramètres */}
      <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
        <h3 className="text-lg font-display font-bold text-slate-800 mb-4">Paramètres de Simulation</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div>
            <label htmlFor="sim-stock-amont" className="text-sm font-medium text-slate-700 mb-1 block">
              Stock amont (T)
            </label>
            <input
              id="sim-stock-amont"
              type="number"
              value={stockAmont}
              onChange={(e) => setStockAmont(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
              min={0}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">Minerai humide disponible</p>
          </div>
          <div>
            <label htmlFor="sim-debit-prod" className="text-sm font-medium text-slate-700 mb-1 block">
              Débit production (T/h)
            </label>
            <input
              id="sim-debit-prod"
              type="number"
              value={debitProd}
              onChange={(e) => setDebitProd(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
              min={0}
              max={CAPACITE_NOMINALE_FOURS}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">Nominal: {CAPACITE_NOMINALE_FOURS} T/h</p>
          </div>
          <div>
            <label htmlFor="sim-cadence-trains" className="text-sm font-medium text-slate-700 mb-1 block">
              Cadence trains (T/h)
            </label>
            <input
              id="sim-cadence-trains"
              type="number"
              value={cadenceTrains}
              onChange={(e) => setCadenceTrains(Number(e.target.value))}
              readOnly={modeTrains === "discret"}
              className={`w-full px-3 py-2 border rounded-lg text-sm transition-colors ${
                modeTrains === "discret"
                  ? "bg-slate-100 border-slate-200 text-slate-500 cursor-not-allowed"
                  : "border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
              }`}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">
              {modeTrains === "continu"
                ? "Éditable en mode continu"
                : `Désactivé en mode discret (${trainCapacite} T / ${trainIntervalle}h)`}
            </p>
          </div>
          <div>
            <label htmlFor="sim-stock-aval" className="text-sm font-medium text-slate-700 mb-1 block">
              Stock aval initial (T)
            </label>
            <input
              id="sim-stock-aval"
              type="number"
              value={stockAval}
              onChange={(e) => setStockAval(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
              min={0}
              max={CAPACITE_MAX_SILOS}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">
              Capacité max silos: {CAPACITE_MAX_SILOS.toLocaleString()} T
            </p>
          </div>
          <div>
            <label htmlFor="sim-duree" className="text-sm font-medium text-slate-700 mb-1 block">
              Durée sim (h)
            </label>
            <input
              id="sim-duree"
              type="number"
              value={dureeSim}
              onChange={(e) => setDureeSim(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
              min={1}
              max={72}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">Max 72 heures</p>
          </div>
        </div>

        {/* Évacuation par trains */}
        <div className="mt-5 pt-4 border-t border-slate-100">
            <div className="flex items-center gap-2 mb-2">
              <Train className="h-4 w-4 text-slate-500" />
              <h4 className="text-sm font-display font-bold text-slate-700">Mode d'évacuation ferroviaire</h4>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                <input
                  type="radio"
                  checked={modeTrains === "continu"}
                  onChange={() => setModeTrains("continu")}
                />
                Débit continu lissé
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                <input
                  type="radio"
                  checked={modeTrains === "discret"}
                  onChange={() => setModeTrains("discret")}
                />
                Trains discrets (Événementiel)
              </label>

              {modeTrains === "discret" && (
                <div className="flex items-center gap-3 flex-wrap ml-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    Capacité (T):
                    <input
                      type="number"
                      value={trainCapacite}
                      onChange={(e) => setTrainCapacite(Number(e.target.value))}
                      min={1}
                      className="w-20 px-2 py-1 bg-white border border-slate-200 rounded text-xs text-slate-700 font-medium text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    Intervalle (h):
                    <input
                      type="number"
                      value={trainIntervalle}
                      onChange={(e) => setTrainIntervalle(Number(e.target.value))}
                      min={1}
                      className="w-16 px-2 py-1 bg-white border border-slate-200 rounded text-xs text-slate-700 font-medium text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-colors"
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

        {/* Pauses programmées */}
        <div className="mt-5 pt-4 border-t border-slate-100">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <PauseIcon className="h-4 w-4 text-slate-500" />
              <h4 className="text-sm font-display font-bold text-slate-700">Pauses programmées (maintenance)</h4>
            </div>
            <button
              onClick={ajouterPause}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Ajouter une pause
            </button>
          </div>
          {pauses.length === 0 ? (
            <p className="text-xs text-slate-400">Aucune pause programmée — production continue sur tout l'horizon.</p>
          ) : (
            <div className="space-y-2">
              {pauses.map((p, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    Début à H+
                    <input
                      type="number"
                      value={p.debut_h}
                      onChange={(e) => modifierPause(i, "debut_h", Number(e.target.value))}
                      className="w-16 px-2 py-1 border border-slate-200 rounded-md text-sm"
                      min={0}
                      max={dureeSim}
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    Durée (h)
                    <input
                      type="number"
                      value={p.duree_h}
                      onChange={(e) => modifierPause(i, "duree_h", Number(e.target.value))}
                      className="w-16 px-2 py-1 border border-slate-200 rounded-md text-sm"
                      min={1}
                    />
                  </label>
                  <button onClick={() => retirerPause(i)} className="text-slate-400 hover:text-red-500">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Variabilité stochastique / Monte-Carlo */}
        <div className="mt-5 pt-4 border-t border-slate-100">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={aleas} onChange={(e) => setAleas(e.target.checked)} />
            <Shuffle className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-display font-bold text-slate-700">Prendre en compte les aléas (Monte-Carlo)</span>
          </label>
          {aleas && (
            <div className="flex items-center gap-4 mt-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Variation débit prod & retards trains
                <input
                  type="number"
                  value={aleasPct}
                  onChange={(e) => setAleasPct(Number(e.target.value))}
                  className="w-16 px-2 py-1 border border-slate-200 rounded-md text-sm"
                  min={1}
                  max={50}
                />
                %
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Nombre de tirages
                <input
                  type="number"
                  value={nIterations}
                  onChange={(e) => setNIterations(Number(e.target.value))}
                  className="w-20 px-2 py-1 border border-slate-200 rounded-md text-sm"
                  min={10}
                  max={500}
                  step={10}
                />
              </label>
              <p className="text-[10px] text-slate-400 max-w-sm">
                Perturbations appliquées uniquement sur le débit horaire de prod et les retards d'arrivée des trains.
              </p>
            </div>
          )}
        </div>

        <button
          onClick={runSimulation}
          disabled={loading}
          className="mt-4 px-5 py-2.5 bg-gradient-to-r from-emerald-700 via-teal-600 to-emerald-800 text-white rounded-xl text-sm font-semibold shadow-[0_4px_16px_-4px_rgba(4,120,87,0.4)] hover:shadow-[0_6px_20px_-4px_rgba(4,120,87,0.5)] hover:-translate-y-0.5 transition-all flex items-center gap-2 disabled:opacity-50 disabled:translate-y-0"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {loading ? "Simulation en cours..." : "Lancer la simulation"}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {/* Résultats */}
      {simulation && finalPoint && (
        <>
          {/* Status */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 border border-slate-200/70 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Stock aval final</span>
                <div
                  className={`p-2.5 rounded-xl border ${
                    alertLevel === "rouge"
                      ? "bg-red-50 text-red-600 border-red-100"
                      : alertLevel === "orange"
                      ? "bg-amber-50 text-amber-600 border-amber-100"
                      : "bg-emerald-50 text-emerald-600 border-emerald-100"
                  }`}
                >
                  <Factory className="h-5 w-5" />
                </div>
              </div>
              <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {Math.round(finalPoint.stock_aval_t).toLocaleString()} T
              </p>
            </div>
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 border border-slate-200/70 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Flux net moyen</span>
                <div className="p-2.5 bg-teal-50 text-teal-600 rounded-xl border border-teal-100">
                  <TrendingUp className="h-5 w-5" />
                </div>
              </div>
              <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {fluxNetAffiche > 0 ? "+" : ""}
                {Math.round(fluxNetAffiche)} T/h
              </p>
            </div>
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 border border-slate-200/70 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Capacité restante</span>
                <div className="p-2.5 bg-emerald-50 text-emerald-800 rounded-xl border border-emerald-100">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </div>
              <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {capaciteRestante?.toLocaleString()} T
              </p>
            </div>
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 border border-slate-200/70 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Saturation dans</span>
                <div
                  className={`p-2.5 rounded-xl border ${
                    simulation.saturation_prevue_h !== null && simulation.saturation_prevue_h < 6
                      ? "bg-red-50 text-red-600 border-red-100"
                      : "bg-emerald-50 text-emerald-600 border-emerald-100"
                  }`}
                >
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </div>
              <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {simulation.saturation_prevue_h === null ? "∞" : `${simulation.saturation_prevue_h}h`}
              </p>
            </div>
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_20px_-8px_rgba(15,23,42,0.08)] hover:shadow-[0_8px_28px_-6px_rgba(4,120,87,0.16)] hover:-translate-y-0.5 transition-all duration-300 border border-slate-200/70 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Rupture stock aval dans</span>
                <div
                  className={`p-2.5 rounded-xl border ${
                    simulation.rupture_prevue_h !== null && simulation.rupture_prevue_h < 12
                      ? "bg-red-50 text-red-600 border-red-100"
                      : simulation.rupture_prevue_h !== null
                      ? "bg-amber-50 text-amber-600 border-amber-100"
                      : "bg-emerald-50 text-emerald-600 border-emerald-100"
                  }`}
                >
                  <TrendingDown className="h-5 w-5" />
                </div>
              </div>
              <p className="text-2xl font-display font-extrabold text-slate-900 tabular-nums">
                {simulation.rupture_prevue_h === null ? "∞" : `${simulation.rupture_prevue_h}h`}
              </p>
            </div>
          </div>

          {/* Comparateur de scénarios */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => enregistrerScenario("A")}
              className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              💾 Enregistrer comme Scénario A{scenarioA ? ` (« ${scenarioA.label} » enregistré)` : ""}
            </button>
            <button
              onClick={() => enregistrerScenario("B")}
              className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              💾 Enregistrer comme Scénario B{scenarioB ? ` (« ${scenarioB.label} » enregistré)` : ""}
            </button>
            {(scenarioA || scenarioB) && (
              <button
                onClick={() => {
                  setScenarioA(null);
                  setScenarioB(null);
                }}
                className="text-xs px-3 py-1.5 rounded-md text-slate-400 hover:text-red-500"
              >
                Effacer la comparaison
              </button>
            )}
          </div>

          {/* Probabilités empiriques Monte-Carlo */}
          {simulation.mode === "monte_carlo" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-4">
                <p className="text-xs text-slate-500">Probabilité de saturation</p>
                <p
                  className={`text-xl font-bold ${
                    (simulation.probabilite_saturation_pct ?? 0) > 50
                      ? "text-red-600"
                      : (simulation.probabilite_saturation_pct ?? 0) > 10
                      ? "text-amber-600"
                      : "text-emerald-600"
                  }`}
                >
                  {simulation.probabilite_saturation_pct}%
                </p>
              </div>
              <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-4">
                <p className="text-xs text-slate-500">Probabilité de rupture stock aval</p>
                <p
                  className={`text-xl font-bold ${
                    (simulation.probabilite_rupture_pct ?? 0) > 50
                      ? "text-red-600"
                      : (simulation.probabilite_rupture_pct ?? 0) > 10
                      ? "text-amber-600"
                      : "text-emerald-600"
                  }`}
                >
                  {simulation.probabilite_rupture_pct}%
                </p>
              </div>
              <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-4">
                <p className="text-xs text-slate-500">Tirages simulés</p>
                <p className="text-xl font-bold text-slate-800">{simulation.n_iterations}</p>
              </div>
            </div>
          )}

          {/* Résumé + alertes */}
          <div className="p-4 rounded-lg border bg-slate-50 border-slate-200 text-slate-700">
            <p className="text-sm font-medium">
              Simulation sur {dureeSim}h (
              {modeTrains === "discret"
                ? `Trains discrets : ${trainCapacite} T / ${trainIntervalle}h`
                : `Cadence continue : ${cadenceTrains} T/h`}
              ). Flux net moyen : {fluxNetAffiche > 0 ? "+" : ""}{Math.round(fluxNetAffiche)} T/h.
            </p>
            {simulation.mode === "monte_carlo" && (
              <p className="text-xs text-slate-500 mt-1">
                Monte-Carlo ({simulation.n_iterations} tirages, ±{aleasPct}% sur prod/retards) :
                Prob. Saturation {simulation.probabilite_saturation_pct}%,
                Prob. Rupture {simulation.probabilite_rupture_pct}%.
              </p>
            )}
          </div>

          {/* Prescription automatique */}
          {simulation.plan_action.length > 0 && (
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-teal-200/70 p-4">
              <button
                onClick={() => setPlanActionVisible((v) => !v)}
                className="flex items-center gap-2 text-sm font-display font-bold text-teal-800"
              >
                <Lightbulb className="h-4 w-4 text-amber-500" />
                {planActionVisible ? "Masquer le plan d'action" : "Suggérer un plan d'action"}
              </button>
              {planActionVisible && (
                <div className="mt-3 space-y-2">
                  {simulation.plan_action.map((option, i) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-3 p-3 rounded-xl bg-teal-50/70 border border-teal-100"
                    >
                      <div>
                        <p className="text-sm font-semibold text-teal-900">{option.titre}</p>
                        <p className="text-xs text-teal-800 mt-0.5">{option.description}</p>
                      </div>
                      <button
                        onClick={() => appliquerOption(option)}
                        className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-gradient-to-r from-teal-700 to-emerald-800 text-white font-medium hover:shadow-md transition-shadow"
                      >
                        Appliquer ({option.valeur_suggeree.toFixed(0)})
                      </button>
                    </div>
                  ))}
                  <p className="text-[10px] text-slate-400">
                    "Appliquer" renseigne le paramètre correspondant ci-dessus — relancez la simulation pour vérifier
                    l'effet.
                  </p>
                </div>
              )}
            </div>
          )}
          {simulation.alertes.map((a, i) => (
            <div
              key={i}
              className={`p-4 rounded-lg border ${
                a.niveau === "ROUGE"
                  ? "bg-red-50 border-red-200 text-red-700"
                  : "bg-amber-50 border-amber-200 text-amber-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <p className="font-medium">
                  H+{a.heure} — {a.message}
                </p>
              </div>
            </div>
          ))}

          {/* Frise des événements discrets */}
          {simulation.evenements.length > 0 && (
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-4">
              <h4 className="text-sm font-display font-bold text-slate-700 mb-2">Événements de la simulation</h4>
              <div className="flex flex-wrap gap-2">
                {simulation.evenements.map((e, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border ${
                      e.type === "train"
                        ? "bg-teal-50 border-teal-200 text-teal-700"
                        : "bg-slate-50 border-slate-200 text-slate-600"
                    }`}
                  >
                    {e.type === "train" ? <Train className="h-3 w-3" /> : <PauseIcon className="h-3 w-3" />}
                    H+{e.heure} — {e.detail}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Graphiques */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Graphique 1 : Évolution des Stocks */}
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
              <h3 className="text-lg font-display font-bold text-slate-800 mb-4 flex items-center justify-between">
                <span>Évolution des Stocks</span>
                <span className="text-xs font-normal text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
                  {simulation.mode === "monte_carlo" ? "Mode Stochastique (Monte-Carlo)" : "Mode Déterministe"}
                </span>
              </h3>

              <ResponsiveContainer width="100%" height={320}>
                {simulation.mode === "monte_carlo" ? (
                  /* --- MODE STOCHASTIQUE (MONTE-CARLO) --- */
                  <AreaChart data={simulation.bande}>
                    <defs>
                      <linearGradient id="bandeGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="heure"
                      tick={{ fontSize: 11 }}
                      label={{ value: "Heures", position: "insideBottom", offset: -5 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        `${Math.round(value).toLocaleString()} T`,
                        name,
                      ]}
                    />
                    <Legend verticalAlign="top" height={36} />

                    <ReferenceLine
                      y={CAPACITE_MAX_SILOS}
                      stroke="#ef4444"
                      strokeDasharray="6 4"
                      label={{ value: "Capacité max silos", fill: "#ef4444", fontSize: 11 }}
                    />

                    {/* Enveloppe d'incertitude entre stock_aval_max et stock_aval_min */}
                    <Area
                      type="monotone"
                      dataKey="stock_aval_max"
                      stroke="#0d9488"
                      strokeDasharray="2 2"
                      fill="url(#bandeGrad)"
                      name="stock_aval_max"
                    />
                    <Area
                      type="monotone"
                      dataKey="stock_aval_min"
                      stroke="#0d9488"
                      strokeDasharray="2 2"
                      fill="#ffffff"
                      name="stock_aval_min"
                    />

                    {/* Courbes de moyennes */}
                    <Line
                      type="monotone"
                      dataKey="stock_aval_moyen"
                      stroke="#0d9488"
                      strokeWidth={2.5}
                      dot={false}
                      name="stock_aval_moyen"
                    />
                    <Line
                      type="monotone"
                      dataKey="stock_amont_moyen"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      strokeDasharray="4 3"
                      name="stock_amont_moyen"
                    />
                  </AreaChart>
                ) : (
                  /* --- MODE DÉTERMINISTE --- */
                  <AreaChart data={simulation.trajectoire}>
                    <defs>
                      <linearGradient id="avalGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="heure"
                      tick={{ fontSize: 11 }}
                      label={{ value: "Heures", position: "insideBottom", offset: -5 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        `${Math.round(value).toLocaleString()} T`,
                        name === "stock_aval_t" ? "Stock Aval (Silos)" : "Stock Amont (Minerai)",
                      ]}
                    />
                    <Legend verticalAlign="top" height={36} />

                    <ReferenceLine
                      y={CAPACITE_MAX_SILOS}
                      stroke="#ef4444"
                      strokeDasharray="6 4"
                      label={{ value: "Capacité max silos", fill: "#ef4444", fontSize: 11 }}
                    />

                    <Area
                      type="monotone"
                      dataKey="stock_aval_t"
                      stroke="#0d9488"
                      fill="url(#avalGrad)"
                      strokeWidth={2}
                      name="stock_aval_t"
                    />
                    <Line
                      type="monotone"
                      dataKey="stock_amont_t"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      name="stock_amont_t"
                    />
                  </AreaChart>
                )}
              </ResponsiveContainer>
            </div>

            {/* Graphique 2 : Taux de Remplissage */}
            <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
              <h3 className="text-lg font-display font-bold text-slate-800 mb-4 flex items-center justify-between">
                <span>Taux de Remplissage Silos Aval</span>
                {simulation.mode === "monte_carlo" && (
                  <span className="text-xs font-normal text-slate-400">(bande min / moyen / max)</span>
                )}
              </h3>
              <ResponsiveContainer width="100%" height={320}>
                {simulation.mode === "monte_carlo" ? (
                  <AreaChart
                    data={simulation.bande?.map((b) => ({
                      ...b,
                      taux_range: Math.max(b.taux_max - b.taux_min, 0),
                    }))}
                  >
                    <defs>
                      <linearGradient id="tauxGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0d9488" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#0d9488" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="heure"
                      tick={{ fontSize: 11 }}
                      label={{ value: "Heures", position: "insideBottom", offset: -5 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <Tooltip formatter={(v: number, n: string) => [`${v.toFixed(1)}%`, n]} />
                    <ReferenceLine
                      y={95}
                      stroke="#ef4444"
                      strokeDasharray="4 4"
                      label={{ value: "Critique", fill: "#ef4444", fontSize: 10 }}
                    />
                    <ReferenceLine
                      y={80}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{ value: "Vigilance", fill: "#f59e0b", fontSize: 10 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="taux_min"
                      stackId="bande"
                      stroke="none"
                      fill="transparent"
                      name="taux_min"
                    />
                    <Area
                      type="monotone"
                      dataKey="taux_range"
                      stackId="bande"
                      stroke="none"
                      fill="url(#tauxGrad)"
                      name="Plage de variation"
                    />
                    <Line
                      type="monotone"
                      dataKey="taux_moyen"
                      stroke="#0d9488"
                      strokeWidth={2}
                      dot={false}
                      name="taux_moyen"
                    />
                  </AreaChart>
                ) : (
                  <LineChart data={simulation.trajectoire}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="heure"
                      tick={{ fontSize: 11 }}
                      label={{ value: "Heures", position: "insideBottom", offset: -5 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                    <Tooltip formatter={(v: number) => [`${v.toFixed(1)}%`, "Remplissage"]} />
                    <ReferenceLine
                      y={95}
                      stroke="#ef4444"
                      strokeDasharray="4 4"
                      label={{ value: "Critique", fill: "#ef4444", fontSize: 10 }}
                    />
                    <ReferenceLine
                      y={80}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{ value: "Vigilance", fill: "#f59e0b", fontSize: 10 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="taux_remplissage_pct"
                      stroke="#0d9488"
                      strokeWidth={2}
                      name="taux_remplissage_pct"
                    />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {/* Comparateur de scénarios côte à côte */}
      {scenarioA && scenarioB && (
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_24px_-8px_rgba(15,23,42,0.10)] border border-slate-200/70 p-5">
          <h3 className="text-lg font-display font-bold text-slate-800 mb-1">Comparaison de scénarios</h3>
          <p className="text-xs text-slate-400 mb-4">
            <span className="text-teal-700 font-medium">A — {scenarioA.label}</span>
            {"  vs  "}
            <span className="text-orange-600 font-medium">B — {scenarioB.label}</span>
            {"  ·  stock aval (silos)"}
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={donneesComparaison}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="heure"
                tick={{ fontSize: 11 }}
                label={{ value: "Heures", position: "insideBottom", offset: -5 }}
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v: number) => (v == null ? ["—", ""] : [`${Math.round(v).toLocaleString()} T`, ""])}
              />
              <Legend />
              <ReferenceLine
                y={CAPACITE_MAX_SILOS}
                stroke="#ef4444"
                strokeDasharray="6 4"
                label={{ value: "Capacité max", fill: "#ef4444", fontSize: 11 }}
              />
              <Line
                type="monotone"
                dataKey="A_stock_aval"
                stroke="#0d9488"
                strokeWidth={2}
                dot={false}
                connectNulls
                name={`A — ${scenarioA.label}`}
              />
              <Line
                type="monotone"
                dataKey="B_stock_aval"
                stroke="#f97316"
                strokeWidth={2}
                dot={false}
                connectNulls
                name={`B — ${scenarioB.label}`}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
            {[
              { label: "A — " + scenarioA.label, sim: scenarioA.simulation, couleur: "text-teal-800" },
              { label: "B — " + scenarioB.label, sim: scenarioB.simulation, couleur: "text-orange-700" },
            ].map((s, i) => (
              <div key={i} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <p className={`font-semibold ${s.couleur} mb-1`}>{s.label}</p>
                <p className="text-xs text-slate-600">
                  Saturation : {s.sim.saturation_prevue_h !== null ? `H+${s.sim.saturation_prevue_h}` : "aucune"}
                </p>
                <p className="text-xs text-slate-600">
                  Rupture aval : {s.sim.rupture_prevue_h !== null ? `H+${s.sim.rupture_prevue_h}` : "aucune"}
                </p>
                <p className="text-xs text-slate-600">
                  Rupture amont : {s.sim.rupture_amont_prevue_h !== null ? `H+${s.sim.rupture_amont_prevue_h}` : "aucune"}
                </p>
                <p className="text-xs text-slate-600">
                  Flux net : {s.sim.parametres.flux_net_th > 0 ? "+" : ""}
                  {s.sim.parametres.flux_net_th} T/h
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}