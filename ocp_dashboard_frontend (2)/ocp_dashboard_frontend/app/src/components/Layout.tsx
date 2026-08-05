import { useState } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  AlertTriangle,
  Zap,
  Settings,
  Activity,
  Factory,
  Menu,
  X,
  ShieldCheck,
  ChevronRight,
  Sparkles,
} from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const navItems = [
  { id: "dashboard", label: "Vue d'ensemble", icon: LayoutDashboard, badge: "Live" },
  { id: "production", label: "Production & KPIs", icon: TrendingUp },
  { id: "anomalies", label: "Anomalies & Alertes", icon: AlertTriangle, badge: "AI" },
  { id: "prediction", label: "Prédiction Pannes J+1", icon: Activity },
  { id: "energy", label: "Efficience Énergétique", icon: Zap },
  { id: "equipment", label: "Analyse Équipements", icon: Settings },
  { id: "jumeau", label: "Jumeau Numérique", icon: Factory, badge: "Sim" },
];

export default function Layout({ children, activeTab, onTabChange }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800 font-sans overflow-hidden selection:bg-emerald-500 selection:text-white">
      {/* Halo lumineux arrière-plan — approfondi pour un rendu plus riche */}
      <div className="fixed top-0 left-0 w-96 h-96 bg-emerald-200/40 rounded-full blur-3xl pointer-events-none -translate-x-1/2 -translate-y-1/2 z-0" />
      <div className="fixed bottom-0 right-0 w-[500px] h-[500px] bg-teal-200/30 rounded-full blur-3xl pointer-events-none translate-x-1/3 translate-y-1/3 z-0" />
      <div className="fixed top-1/3 right-1/4 w-72 h-72 bg-amber-100/20 rounded-full blur-3xl pointer-events-none z-0" />

      {/* Sidebar Command Center — Premium Light Style */}
      <aside
        className={`${
          sidebarOpen ? "w-72" : "w-20"
        } bg-white/90 backdrop-blur-xl border-r border-slate-200/80 transition-all duration-300 ease-in-out flex flex-col z-20 shadow-[4px_0_32px_-8px_rgba(15,23,42,0.08)]`}
      >
        {/* Header OCP Branding */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-gradient-to-b from-slate-50/80 to-transparent">
          {sidebarOpen && (
            <div className="flex items-center gap-3.5">
              <div className="relative flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-700 via-teal-600 to-emerald-800 p-0.5 shadow-[0_4px_16px_-2px_rgba(4,120,87,0.4)] ring-1 ring-emerald-900/10">
                <div className="w-full h-full bg-white rounded-[9px] flex items-center justify-center relative overflow-hidden">
                  <Factory className="h-5 w-5 text-emerald-700" />
                  <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <h1 className="text-base font-display font-extrabold tracking-wide text-slate-900">
                    OCP GROUP
                  </h1>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    v2.4
                  </span>
                </div>
                <p className="text-[11px] font-medium text-slate-500 tracking-tight">Séchage & Digitalisation</p>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? "Réduire le menu" : "Ouvrir le menu"}
            className="p-2 rounded-xl bg-slate-100 text-slate-600 hover:text-emerald-700 hover:bg-emerald-50 border border-slate-200 transition-all min-w-[40px] min-h-[40px] flex items-center justify-center"
          >
            {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>

        {/* System Status Pill */}
        {sidebarOpen && (
          <div className="mx-4 my-3 px-3.5 py-2.5 rounded-xl bg-emerald-50/80 border border-emerald-200/60 flex items-center justify-between shadow-[0_1px_2px_rgba(4,120,87,0.06)]">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-600"></span>
              </span>
              <span className="text-[11px] font-semibold text-emerald-900">Jumeau Numérique Actif</span>
            </div>
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          </div>
        )}

        {/* Navigation Items */}
        <nav className="flex-1 py-3 px-3 space-y-1.5 overflow-y-auto custom-scrollbar">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-sm font-semibold transition-all duration-200 min-h-[46px] group relative ${
                  isActive
                    ? "bg-gradient-to-r from-emerald-700 via-teal-600 to-emerald-800 text-white shadow-[0_6px_20px_-4px_rgba(4,120,87,0.45)] ring-1 ring-emerald-900/10"
                    : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900 border border-transparent"
                }`}
                title={!sidebarOpen ? item.label : undefined}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-amber-400" />
                )}
                <div className="flex items-center gap-3.5">
                  <Icon className={`h-5 w-5 flex-shrink-0 transition-transform duration-200 group-hover:scale-110 ${
                    isActive ? "text-white" : "text-slate-400 group-hover:text-emerald-600"
                  }`} />
                  {sidebarOpen && <span className="tracking-wide text-[13px]">{item.label}</span>}
                </div>

                {sidebarOpen && (
                  <div className="flex items-center gap-2">
                    {item.badge && (
                      <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-md tracking-wide ${
                        isActive
                          ? "bg-white/20 text-white"
                          : "bg-slate-100 text-emerald-700 border border-emerald-200"
                      }`}>
                        {item.badge}
                      </span>
                    )}
                    <ChevronRight className={`h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity ${
                      isActive ? "opacity-100 text-white" : "text-slate-400"
                    }`} />
                  </div>
                )}
              </button>
            );
          })}
        </nav>

        {/* Footer OCP Info */}
        {sidebarOpen && (
          <div className="p-4 border-t border-slate-100 bg-gradient-to-t from-slate-50/80 to-transparent flex items-center justify-between text-[11px] text-slate-500">
            <div>
              <p className="font-display font-bold text-slate-700">OCP Group — Gantour</p>
              <p className="text-[10px] text-slate-400">ENSAM Casablanca — 2026</p>
            </div>
            <Sparkles className="h-4 w-4 text-amber-500" />
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto bg-slate-50 relative z-10 custom-scrollbar">
        {/* Top Floating Header */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/80 px-8 py-4 flex items-center justify-between shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]"></span>
            <span className="text-xs font-display font-bold tracking-wider text-slate-700 uppercase">
              Plateforme Intelligente de Supervision et Prédictivité
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="px-3.5 py-1.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700 font-semibold font-mono">
              Site de Séchage Gantour
            </span>
          </div>
        </header>

        <div className="p-8 max-w-7xl mx-auto space-y-8">{children}</div>
      </main>
    </div>
  );
}