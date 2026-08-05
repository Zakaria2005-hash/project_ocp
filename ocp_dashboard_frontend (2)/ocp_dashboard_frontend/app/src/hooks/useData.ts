import { useState, useEffect } from "react";
import type { DashboardData, PanneItem, EquipmentKPI, EnergyData, ParetoItem } from "@/types";

interface AllData {
  dashboard: DashboardData | null;
  pannes: PanneItem[] | null;
  equipment: EquipmentKPI[] | null;
  energy: EnergyData[] | null;
  pareto: ParetoItem[] | null;
  loading: boolean;
  error: string | null;
}

// Base URL du backend Django (analytics). Configurable via .env
// (VITE_API_BASE_URL) — voir .env.example. Remplace les anciens
// fetch("/data/*.json") statiques, qui servaient des données d'exemple
// générées hors-ligne : le dashboard consomme désormais les vraies
// données ingérées (FactJournalier / FactArret), calculées en direct par
// analytics/dashboard_api.py.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000/api/analytics";

const FALLBACK_MAP: Record<string, string> = {
  "/dashboard/summary/": "/data/dashboard.json",
  "/dashboard/pannes/": "/data/pannes.json",
  "/dashboard/equipment/": "/data/equipment.json",
  "/dashboard/energy/": "/data/energy.json",
  "/dashboard/pareto/": "/data/pareto.json",
};

export async function fetchJson<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (res.ok) {
      return (await res.json()) as T;
    }
  } catch (_e) {
    // Si l'API Django n'est pas joignable, basculer sur le fichier statique local de secours
  }

  const fallbackPath = FALLBACK_MAP[path];
  if (fallbackPath) {
    const resFallback = await fetch(fallbackPath);
    if (resFallback.ok) {
      return (await resFallback.json()) as T;
    }
  }

  throw new Error(`Échec de récupération de ${path}. Le serveur Django est-il lancé sur ${API_BASE} ?`);
}

export function useData(): AllData {
  const [data, setData] = useState<AllData>({
    dashboard: null,
    pannes: null,
    equipment: null,
    energy: null,
    pareto: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    async function loadAll() {
      try {
        const [dashboard, pannes, equipment, energy, pareto] = await Promise.all([
          fetchJson<DashboardData>("/dashboard/summary/"),
          fetchJson<PanneItem[]>("/dashboard/pannes/"),
          fetchJson<EquipmentKPI[]>("/dashboard/equipment/"),
          fetchJson<EnergyData[]>("/dashboard/energy/"),
          fetchJson<ParetoItem[]>("/dashboard/pareto/"),
        ]);

        setData({ dashboard, pannes, equipment, energy, pareto, loading: false, error: null });
      } catch (err) {
        setData((prev) => ({ ...prev, loading: false, error: (err as Error).message }));
      }
    }

    loadAll();
  }, []);

  return data;
}
