# OCP Drying Project — Version Corrigée

## Démarrage rapide

```bash
pip install -r requirements.txt
python manage.py makemigrations maintenance   # si vous repartez de zéro
python manage.py migrate
python ingest_ocp_data.py --input-dir ./data
python process_data.py --input-dir ./data
python run_ml.py --input-dir ./data
```

Tous les scripts acceptent `--input-dir` (ou la variable d'environnement
`OCP_DATA_DIR`) au lieu d'un chemin Windows codé en dur. Par défaut : `./data`.

## Bugs corrigés (tous vérifiés avec vos vraies données : 181 jours, 290 arrêts)

### 1. Collision de colonnes → plantage caché (`ingest_ocp_data.py`)
`clean_col_name()` transformait **"DUREE"** et **"Duree(h)"** en la même
colonne `"duree"`. `row.get('duree')` renvoyait alors une `pandas.Series`
au lieu d'un scalaire, ce qui provoque `ValueError: truth value of a Series
is ambiguous...` — souvent avalé silencieusement par un `except` générique.
**Corrigé** : `ingest_pannes()` référence désormais les colonnes réelles
(`Duree(h)`, `DUREE` en repli) sans passer par `clean_col_name()`.
`common_utils.dedupliquer_colonnes()` sert de filet de sécurité partout
ailleurs.

### 2. Fichiers introuvables → ingestion silencieusement vide
Le code cherchait `"Historique KPI journalier.xlsx"` (espaces) alors que
vos fichiers réels utilisent des underscores :
`Historique_KPI_journalier.xlsx`. Résultat : `os.path.exists()` renvoyait
toujours `False`, et le script affichait "terminé avec succès" sans avoir
rien inséré. **Corrigé** : motifs regex tolérants (espaces OU underscores,
avec ou sans accents) dans `common_utils.py`.

### 3. Mauvais accent dans une regex → `qualite_traitee` jamais extraite
Un second bug, plus subtil, faisait que même après la correction #2 les
fichiers `Performance_Journalière_*` n'étaient toujours pas détectés : le
motif contenait `journali[ée]re` (é) alors que le mot réel est
"journal**iè**re" (è). **Corrigé** : les noms de fichiers sont maintenant
comparés après suppression de leurs accents, ce qui évite d'avoir à
énumérer chaque variante accentuée dans chaque regex. Vérifié : 181/181
jours ont désormais `qualite_traitee` renseignée (0 avant correction).

### 4. `TYPE_MAPPING` incomplet → 48 arrêts mal classés
Les valeurs réelles `"Panne"` et `"M.Planifiée"` ne matchaient aucune clé
de l'ancien mapping et tombaient à tort dans `"Autre"`. **Corrigé** et
vérifié : répartition finale = Externe 98, Utilisation 85, Panne 54,
M.Planifiée 48, Décidé 5 (total 290, 0 "Autre" résiduel côté type).

### 5. Champs manquants sur `FactArret`
`ingest_ocp_data.py` renseignait déjà `type_arret` et `unite`, mais ces
champs n'existaient pas dans `maintenance/models.py` → `TypeError`.
**Ajoutés** au modèle, avec une clé naturelle (`cle_naturelle`) pour une
idempotence fiable (évite de fusionner à tort deux arrêts distincts du
même équipement, le même jour, pour la même cause).

### 6. `TRG` parfois textuel (`"100%"`) traité comme catégoriel
`process_data.py` faisait un one-hot encoding (`pd.get_dummies`) sur `TRG`,
une variable **numérique continue**, générant des colonnes absurdes comme
`TRG_100%`. **Corrigé** : `TRG` est nettoyé en float `[0, 1]` (gère les
`"100%"`) puis reste numérique ; seule `qualite_traitee` (réellement
catégorielle) est one-hot encodée. Vérifié : `TRG` dans `base_ml_kpi.csv`
est bien `float64`, moyenne ≈ 0.55, sans colonnes `TRG_*`.

### 7. Chemins Windows codés en dur
`r"c:\Users\user\Documents\data_US"` ne fonctionne que sur une machine
précise. **Corrigé** : argument `--input-dir` partout, portable
Windows/Mac/Linux.

### 8. Warnings matplotlib (`FixedLocator`)
`ax.set_xticklabels(...)` sans `set_xticks()` préalable déclenche un
`UserWarning`. **Corrigé** avec `rotation_xticks()` dans `process_data.py`.
Testé avec `-W error::UserWarning` : aucune erreur.

### 9. Performance (`ingest_synthese_arrets`)
L'ancienne version faisait un `get_or_create` + `.save()` par
(jour × nature), soit des centaines de requêtes SQL individuelles.
**Corrigé** : agrégation en mémoire, une seule requête par jour.

### 10. Fuite de données potentielle (`run_ml.py`)
`"A Maintenance Subie (h)"` était à la fois une cible du modèle et
disponible comme feature pour d'autres cibles. **Exclue** explicitement
des features.

## Fichiers du projet

| Fichier | Rôle |
|---|---|
| `common_utils.py` | Logique partagée (conversions, recherche de fichiers, normalisation) — **nouveau**, évite la duplication de bugs entre scripts |
| `maintenance/models.py` | Modèles Django, complétés (`type_arret`, `unite`, `cle_naturelle`) |
| `maintenance/admin.py` | Interface d'administration |
| `ingest_ocp_data.py` | Ingestion Excel → base de données (idempotent) |
| `process_data.py` | Nettoyage, visualisations, exports CSV/JSON |
| `run_ml.py` | Feature engineering + modèles prédictifs (HistGradientBoosting) |
| `inspect_data.py` | Inspection rapide des fichiers Excel sources |

## À propos de `config/`

Un `config/settings.py` minimal est fourni **uniquement si vous n'en aviez
pas déjà un fonctionnel** — gardez le vôtre si c'est le cas (assurez-vous
juste que `"maintenance"` figure dans `INSTALLED_APPS`).

## Limite connue signalée en toute transparence

Le modèle prédictif MTBF/MTTR (`run_ml.py`) a un R² négatif sur juin —
attendu avec un historique aussi court (5 mois d'entraînement). Utile
pour la structure du pipeline, mais à ne pas prendre pour argent comptant
tant que l'historique n'est pas plus long.

## App `analytics` (ré-intégrée et corrigée)

L'app `analytics` (ml_pipeline, serializers, views) a été ré-intégrée à
partir de tes fichiers, avec plusieurs bugs corrigés — vérifiés à
l'exécution réelle des 6 endpoints :

### Bugs corrigés

1. **Bug d'accent critique** : `nature__in=['Mécanique', 'Électrique']`
   ne matchait **jamais** la vraie valeur stockée `"Electrique"` (sans
   accent). Toutes les pannes électriques étaient invisibles pour le
   modèle prédictif ET les agrégats MTBF/MTTR. **Vérifié** : sur juin,
   3 pannes Mécanique+Electrique réelles, contre 1 seule détectée avec
   le bug (les 2 Electrique manquées). Corrigé via la constante partagée
   `NATURES_PANNES_MAJEURES` dans `ml_pipeline.py`.

2. **`serializers.models.Sum(...)` n'existe pas** — `rest_framework.
   serializers` n'a pas d'attribut `models`. Provoquait un `AttributeError`
   à chaque sérialisation de `FactJournalier`. Corrigé en important `Sum`
   depuis `django.db.models`.

3. **`HistGradientBoostingClassifier` n'a pas d'attribut
   `feature_importances_`** (contrairement à `RandomForestClassifier`) —
   plantait `/train-model/` avec un 500 à chaque appel. Corrigé avec
   `sklearn.inspection.permutation_importance`, agnostique au type de
   modèle.

4. **Code mort buggé** : `PannePredictor.build_features()` utilisait
   `models_Count`/`models_Sum` sans les avoir importés dans son scope —
   jamais appelée en pratique (`_build_features_with_django_agg` faisait
   double emploi), donc silencieuse, mais aurait planté si appelée.
   Supprimée, une seule méthode `_build_features()` fait foi désormais.

5. **Message trompeur dans `FluxDigitalTwin.simulate()`** : une alerte
   ORANGE annonçait un délai avant saturation même quand le flux net
   était négatif (silos en décroissance). Corrigé : le message dépend
   maintenant du signe du flux net.

6. **`EtatStocksFlux` et `derive_thermique()` manquants** :
   `serializers.py`/`views.py` référençaient déjà ce modèle et cette
   méthode alors qu'ils n'existaient pas dans `maintenance/models.py`.
   Ajoutés, avec une nouvelle étape d'ingestion (`ingest_energie()`) qui
   extrait la consommation d'énergie par recherche de libellé (position
   de ligne variable selon les mois — 56 pour janvier-mars, 58-59 pour
   avril-juin).

7. `analytics/urls.py` n'existait pas dans les fichiers fournis —
   créé, et branché dans `config/urls.py` + `INSTALLED_APPS`.

### Endpoints — tous testés en conditions réelles (200 OK)

| Endpoint | Méthode | Résultat du test |
|---|---|---|
| `/api/analytics/powerbi-dashboard/?month=6` | GET | OK — MTBF=254h, 3 pannes juin |
| `/api/analytics/live-alerts/` | GET | OK — statut ORANGE, 3 alertes |
| `/api/analytics/anomalies/` | GET | OK — 3 anomalies/30 jours (juin) |
| `/api/analytics/train-model/` | POST | OK — 148 train / 30 test |
| `/api/analytics/predict-tomorrow/` | GET | OK — VERT, proba 0.0 |
| `/api/analytics/simulate-flux/` | POST | OK — trajectoire + alertes cohérentes |

**Note de transparence** : l'accuracy du modèle de pannes est de 100 % sur
juin, mais le jeu de test ne contient qu'une seule classe (aucune panne
majeure le lendemain sur cette période) — un score parfait ici reflète
la simplicité du cas de test, pas une garantie de performance générale.
À réévaluer avec un historique plus long.
