import { useState } from "react";
import { useData } from "@/hooks/useData";
import Layout from "@/components/Layout";
import DashboardView from "@/components/DashboardView";
import ProductionView from "@/components/ProductionView";
import AnomaliesView from "@/components/AnomaliesView";
import PredictionView from "@/components/PredictionView";
import EnergyView from "@/components/EnergyView";
import EquipmentView from "@/components/EquipmentView";
import JumeauView from "@/components/JumeauView";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Loader2, AlertCircle } from "lucide-react";

function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const { dashboard, equipment, energy, pareto, loading, error } = useData();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="text-center">
          <Loader2 className="h-10 w-10 animate-spin text-emerald-500 mx-auto mb-4" />
          <p className="text-slate-500">Chargement des données OCP...</p>
        </div>
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <p className="text-red-600 font-medium">Erreur de chargement</p>
          <p className="text-slate-500 text-sm mt-1">{error || "Données indisponibles"}</p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case "dashboard":
        return <DashboardView data={dashboard} energyData={energy || undefined} />;
      case "production":
        return <ProductionView data={dashboard} />;
      case "anomalies":
        return <AnomaliesView data={dashboard} />;
      case "prediction":
        return <PredictionView data={dashboard} />;
      case "energy":
        return energy ? <EnergyView data={energy} /> : <div className="text-center py-20 text-slate-400">Données énergétiques non disponibles</div>;
      case "equipment":
        return equipment && pareto ? (
          <EquipmentView equipment={equipment} pareto={pareto} />
        ) : (
          <div className="text-center py-20 text-slate-400">Données équipements non disponibles</div>
        );
      case "jumeau":
        return <JumeauView />;
      default:
        return <DashboardView data={dashboard} energyData={energy || undefined} />;
    }
  };

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {/* key={activeTab} : force un remontage propre du boundary à chaque
          changement d'onglet, pour qu'une erreur sur un onglet n'empêche
          pas de revenir en arrière et de consulter les autres. */}
      <ErrorBoundary key={activeTab} nomVue={activeTab}>
        {renderContent()}
      </ErrorBoundary>
    </Layout>
  );
}

export default App;
