import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon } from "lucide-react";

/**
 * Filet de sécurité applicatif : sans ce composant, une erreur JS non
 * interceptée dans N'IMPORTE QUELLE vue (ex. AnomaliesView) démonte tout
 * l'arbre React et laisse une PAGE BLANCHE — exactement le symptôme
 * signalé ("page vierge, aucun traceback en terminal Django", ce qui est
 * cohérent : une erreur JS côté navigateur n'apparaît jamais dans la
 * console du serveur Django, seulement dans la console du navigateur,
 * F12 → Console).
 *
 * Avec ce composant, la même erreur reste cantonnée à l'onglet concerné,
 * et surtout : le message d'erreur exact s'affiche directement à l'écran
 * (plus besoin d'ouvrir les DevTools pour nous le transmettre).
 */
interface Props {
  children: ReactNode;
  /** Optionnel : nom de l'onglet affiché, pour situer l'erreur. */
  nomVue?: string;
}

interface State {
  erreur: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { erreur: null };

  static getDerivedStateFromError(erreur: Error): State {
    return { erreur };
  }

  componentDidCatch(erreur: Error, info: ErrorInfo) {
    // Toujours loggé en console navigateur pour investigation approfondie
    // (stack complet), en plus de l'affichage résumé ci-dessous.
    console.error(`[ErrorBoundary${this.props.nomVue ? ` — ${this.props.nomVue}` : ""}]`, erreur, info.componentStack);
  }

  // Permet de réessayer sans recharger toute la page (utile si l'erreur
  // était due à des données transitoires, ex. re-fetch en cours).
  reinitialiser = () => this.setState({ erreur: null });

  render() {
    if (this.state.erreur) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 px-6 text-center">
          <AlertOctagon className="h-10 w-10 text-red-500" />
          <p className="text-lg font-semibold text-slate-800">
            Cette vue{this.props.nomVue ? ` (${this.props.nomVue})` : ""} a rencontré une erreur.
          </p>
          <p className="text-sm text-slate-500 max-w-xl">
            Erreur exacte (à transmettre telle quelle pour diagnostic) :
          </p>
          <pre className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 max-w-2xl overflow-auto text-left">
            {this.state.erreur.message}
          </pre>
          <button
            onClick={this.reinitialiser}
            className="mt-2 text-sm px-4 py-2 rounded-md bg-slate-800 text-white hover:bg-slate-700"
          >
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
