# OCP Drying Dashboard — Frontend React (branché sur le vrai backend Django)

Ce frontend (Vite + React + TypeScript + Tailwind + shadcn/ui) a été généré
initialement avec des données d'exemple statiques (`public/data/*.json`).
Il consomme désormais les **vraies données** ingérées dans Django, via 5
nouveaux endpoints dédiés (`analytics/dashboard_api.py` côté backend).

## Démarrage (2 serveurs à lancer)

### 1. Backend Django (dans le dossier du projet Django)

```bash
pip install -r requirements.txt      # inclut django-cors-headers
python manage.py migrate
python ingest_ocp_data.py --input-dir ./data
python manage.py runserver 8000
```

### 2. Frontend React (dans ce dossier)

```bash
cp .env.example .env    # ajustez VITE_API_BASE_URL si besoin
npm install
npm run dev
```

Ouvrez `http://localhost:3000`. Le dashboard charge maintenant les données
réelles depuis `http://127.0.0.1:8000/api/analytics/dashboard/*`.

## Ce qui a changé par rapport à la version initiale (données statiques)

### `src/hooks/useData.ts`
Remplace les 5 `fetch("/data/*.json")` (fichiers statiques) par 5 appels
vers l'API Django réelle, configurable via `VITE_API_BASE_URL` (`.env`).

### `src/components/JumeauView.tsx` (réécrit)
L'ancienne version recalculait sa propre simulation physique **côté
navigateur**, avec un flux net **statique** (`débit - cadence trains`)
tout au long de la simulation. Ça pouvait annoncer "saturation dans ~50h"
alors que les fours allaient s'arrêter bien avant, faute de stock amont —
un bug physique découvert et corrigé côté backend (`FluxDigitalTwin.
simulate()`), et automatiquement hérité ici puisque cette vue appelle
maintenant directement `/api/analytics/simulate-flux/` au lieu de dupliquer
la logique. Un champ "Stock amont" a été ajouté à l'UI (absent avant, alors
que la contrainte physique en dépend).

### Accessibilité (`src/components/Layout.tsx`, `JumeauView.tsx`)
- Bouton de repli du menu : `aria-label` ajouté + cible tactile portée à
  44×44px (elle ne faisait que 24×24px — sous le minimum recommandé).
- Items de navigation : `aria-label` + `aria-current="page"` sur l'onglet
  actif, hauteur minimale 44px garantie.
- Les 5 champs du Jumeau Numérique : labels maintenant liés aux champs via
  `htmlFor`/`id` (ils étaient seulement juxtaposés visuellement avant, non
  associés pour un lecteur d'écran).

## Backend — 5 nouveaux endpoints (`analytics/dashboard_api.py`)

| Endpoint | Reproduit la forme de |
|---|---|
| `GET /api/analytics/dashboard/summary/` | `dashboard.json` (kpis, evolution, alertes, monthly) |
| `GET /api/analytics/dashboard/pannes/` | `pannes.json` |
| `GET /api/analytics/dashboard/equipment/` | `equipment.json` |
| `GET /api/analytics/dashboard/energy/` | `energy.json` |
| `GET /api/analytics/dashboard/pareto/` | `pareto.json` |

Ces endpoints réutilisent les pipelines ML existants (`AnomalyDetector`,
`PannePredictor`, `EfficienceEnergetique`) plutôt que de dupliquer leur
logique.

**Note de transparence** : le champ `risk_panne_j1` dans `/summary/` est
une prédiction *in-sample* (calculée à des fins d'exploration visuelle sur
tout l'historique) — ce n'est pas une validation hors-échantillon
rigoureuse. Pour une évaluation fiable du modèle, voir
`/api/analytics/cross-validate-pannes/`.

Trois champs manquaient au modèle `FactJournalier` pour alimenter la vue
Énergie (`cs_gaz_nm3t`, `cs_gazoline_kgt`, `cs_fuel_kgt`) — ajoutés au
modèle et à l'ingestion (`ingest_energie()` dans `ingest_ocp_data.py`).

## Validé avant livraison

- `npm install` + `tsc -b` + `vite build` : compilent sans erreur.
- Test de rendu headless (Playwright) : les 7 onglets se chargent sans
  erreur JavaScript, avec les vraies données (Production Totale 649 527 T,
  OEE 61.6%, etc. — identiques aux valeurs calculées côté Django).
- Simulation du Jumeau Numérique testée via le vrai endpoint : flux net,
  alertes et message de rupture d'alimentation amont s'affichent
  correctement.
- CORS vérifié : `Access-Control-Allow-Origin` bien renvoyé par Django
  pour les requêtes depuis `http://localhost:3000`.

## Point de vigilance pour la suite

Le bundle de production fait ~753 KB (gzip ~206 KB) — Vite avertit que
c'est au-dessus du seuil recommandé (500 KB), à cause du volume de
composants Radix/shadcn utilisés. Pas bloquant pour un usage interne, mais
à garder en tête si le dashboard doit un jour être exposé publiquement
(envisager `React.lazy()` par onglet).
