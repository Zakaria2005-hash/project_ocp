"""
Modèles du site de séchage — VERSION CORRIGÉE ET COMPLÉTÉE.

Par rapport à la base actuelle (db.sqlite3 fourni), deux champs manquaient
sur FactArret alors que ingest_ocp_data.py essayait déjà de les renseigner
(`type_arret`, `unite`) — ce qui provoquait un `TypeError` au runtime
("unexpected keyword argument"). Ils sont ajoutés ici.

Un champ `cle_naturelle` unique est aussi ajouté sur FactArret : sans lui,
`update_or_create(date_evenement=..., equipement=..., cause_precision=...)`
fusionnait à tort plusieurs arrêts distincts survenus le même jour, sur le
même équipement, pour la même cause (ex. 2 micro-coupures identiques dans
la journée ne faisaient qu'une seule ligne en base).

IMPORTANT — migration :
Ces changements de schéma nécessitent une nouvelle migration. Le plus sûr
avec des données de démonstration est de repartir propre :
    rm db.sqlite3
    rm maintenance/migrations/0*.py   # garder __init__.py
    python manage.py makemigrations maintenance
    python manage.py migrate
    python manage.py ingest_ocp_data   # ou python ingest_ocp_data.py
"""
from django.db import models

# Baseline usine pour la dérive thermique (kcal/T). Cf. plan d'exécution du
# projet — seuil de référence pour détecter une dérive process/énergie.
BASELINE_CONSO_ENERGIE_KCAL_T = 160000
SEUIL_DERIVE_ENERGIE_PCT = 0.05  # +5% vs baseline => dérive signalée


class FactJournalier(models.Model):
    """Fait journalier : KPIs agrégés + synthèse des arrêts (1 ligne / jour)."""

    date = models.DateField(primary_key=True, verbose_name="Journée")
    journee_partielle = models.BooleanField(
        default=False,
        help_text="True si au moins une source (KPI, arrêts, procédé) n'a pas "
                   "pu être ingérée pour ce jour.",
    )

    # ---- KPIs agrégés (Historique_KPI_journalier) ----
    # CORRIGÉ : production_totale_t vient désormais de "Production totale"
    # (fichier Performance_Journalière_du_mois_*), qui est la somme
    # auto-cohérente Production MC + MP + BG10 + BG22 — vérifié : 5540 +
    # 2163 + 0 = 7703 pour le 1er janvier. L'ancienne source, "Tonnage
    # (TSM)" (fichier Historique_KPI_journalier), mesure autre chose : le
    # ratio entre les deux varie de 0.85x à 12x selon les jours, ce n'est
    # pas une simple différence d'unité. Conservée ci-dessous sous son
    # propre nom pour traçabilité, mais n'est plus utilisée comme "la"
    # production totale du site.
    production_totale_t = models.FloatField(null=True, blank=True)
    tonnage_tsm_t = models.FloatField(
        null=True, blank=True,
        verbose_name="Tonnage (TSM)",
        help_text="Mesure distincte de production_totale_t — voir commentaire du modèle.",
    )
    trs_calc = models.FloatField(null=True, blank=True, verbose_name="OEE")
    disponibilite_globale = models.FloatField(null=True, blank=True, verbose_name="TD")
    debit_th = models.FloatField(null=True, blank=True)
    hm = models.FloatField(null=True, blank=True, verbose_name="Heures de marche")
    a_exploitation_h = models.FloatField(null=True, blank=True)
    a_externe_h = models.FloatField(null=True, blank=True)
    a_maint_planifie_h = models.FloatField(null=True, blank=True)
    arrets_decide_h = models.FloatField(null=True, blank=True)
    a_maint_subie_h = models.FloatField(null=True, blank=True)
    temps_ouverture_h = models.FloatField(null=True, blank=True)
    perte_vitesse = models.FloatField(null=True, blank=True)
    trg = models.FloatField(null=True, blank=True)
    taux_panne = models.FloatField(null=True, blank=True)
    qualite_traitee = models.CharField(max_length=100, null=True, blank=True)

    # AJOUTÉ — nécessaire pour derive_thermique(), utilisée par
    # analytics/serializers.py et analytics/views.py. Extraite du fichier
    # Performance_Journalière_du_mois_*.xlsx (ligne "Consommation d'énergie
    # (kcal/T)", recherchée par libellé — sa position varie selon les mois).
    conso_energie_kcalt = models.FloatField(null=True, blank=True)
    # AJOUTÉ — consommations spécifiques par combustible, nécessaires à la
    # vue "Énergie" du dashboard React (EnergyView.tsx / energy.json).
    # Extraites du fichier Performance_Journalière_du_mois_*.xlsx par
    # recherche de libellé (même méthode robuste que conso_energie_kcalt).
    cs_gaz_nm3t = models.FloatField(null=True, blank=True, verbose_name="Cs Gaz (Nm3/T)")
    cs_gazoline_kgt = models.FloatField(null=True, blank=True, verbose_name="Cs Gazoline (kg/T)")
    cs_fuel_kgt = models.FloatField(null=True, blank=True, verbose_name="Cs Fuel (kg/T)")

    # AJOUTÉ — nécessaire au monitoring par règles métier (analytics/regles_metier.py) :
    # humidité de sortie MC, extraite de Performance_Journalière_du_mois_*.xlsx
    # par recherche de libellé (même méthode robuste que conso_energie_kcalt,
    # cf. common_utils.extraire_valeurs_par_libelle). Un taux de sortie trop
    # élevé signale un risque de sous-séchage de la matière.
    humidite_sortie_mc_pct = models.FloatField(
        null=True, blank=True, verbose_name="Humidité sortie MC (%)"
    )
    humidite_sortie_mp_pct = models.FloatField(
        null=True, blank=True, verbose_name="Humidité sortie MP (%)"
    )

    # ---- Synthèse des arrêts / jour (Synthèse_des_arrets_journaliers_*) ----
    arrets_decides = models.FloatField(null=True, blank=True)
    arrets_externes = models.FloatField(null=True, blank=True)
    arrets_utilisation = models.FloatField(null=True, blank=True)
    heures_de_marche = models.FloatField(null=True, blank=True)
    heures_theoriques = models.FloatField(null=True, blank=True)
    maintenance_planifiee = models.FloatField(null=True, blank=True)
    arrets_oee = models.FloatField(null=True, blank=True)
    pannes_maintenance = models.FloatField(null=True, blank=True)
    arrets_trg = models.FloatField(null=True, blank=True)
    taux_de_disponibilite = models.FloatField(null=True, blank=True)
    arrets_temps_ouverture = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["date"]
        verbose_name = "Fait journalier"
        verbose_name_plural = "Faits journaliers"

    def __str__(self):
        return f"{self.date} — TRG={self.trg}"

    def derive_thermique(self):
        """Compare la consommation spécifique (kcal/T) à la baseline usine.

        Retourne un dict {conso_kcalt, baseline_kcalt, ecart_pct, en_derive}
        ou None si la donnée n'est pas disponible pour ce jour (utilisé par
        analytics/serializers.py et analytics/views.py).
        """
        if self.conso_energie_kcalt is None:
            return None
        ecart_pct = (self.conso_energie_kcalt - BASELINE_CONSO_ENERGIE_KCAL_T) / BASELINE_CONSO_ENERGIE_KCAL_T
        return {
            "conso_kcalt": self.conso_energie_kcalt,
            "baseline_kcalt": BASELINE_CONSO_ENERGIE_KCAL_T,
            "ecart_pct": round(ecart_pct * 100, 2),
            "en_derive": ecart_pct > SEUIL_DERIVE_ENERGIE_PCT,
        }


class ObjectifEnergetique(models.Model):
    """Objectif (baseline) de consommation énergétique spécifique, éditable
    mois par mois par le service méthodes/process — remplace le seuil unique
    et figé BASELINE_CONSO_ENERGIE_KCAL_T (160 000 kcal/T) quand un objectif
    plus ambitieux (ou plus réaliste) a été fixé pour un mois donné.

    Utilisé par analytics/dashboard_api.py::EnergyListView pour calculer la
    dérive thermique et l'impact financier de chaque jour avec la baseline
    du mois correspondant si elle existe, sinon la baseline usine par défaut.
    """

    mois = models.CharField(
        max_length=7, primary_key=True,
        help_text="Format YYYY-MM, ex. '2026-06'.",
    )
    baseline_kcalt = models.FloatField(
        verbose_name="Objectif de consommation (kcal/T)",
        help_text="Cible fixée pour ce mois. Par défaut : 160 000 kcal/T.",
    )
    mis_a_jour_le = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-mois"]
        verbose_name = "Objectif énergétique mensuel"
        verbose_name_plural = "Objectifs énergétiques mensuels"

    def __str__(self):
        return f"{self.mois} — objectif {self.baseline_kcalt:.0f} kcal/T"


class FactArret(models.Model):
    """Événement d'arrêt individuel, rattaché à une journée de production."""

    NATURE_CHOICES = [
        ("Mécanique", "Mécanique"),
        ("Electrique", "Électrique"),
        ("Exploitation", "Exploitation"),
        ("Installation", "Installation"),
        ("Autre", "Autre"),
    ]
    # AJOUTÉ : ces choix manquaient, "Panne" et "Décidé" tombaient dans "Autre".
    TYPE_CHOICES = [
        ("Panne", "Panne"),
        ("M.Planifiée", "Maintenance planifiée"),
        ("M.Subie", "Maintenance subie"),
        ("Utilisation", "Utilisation / process"),
        ("Externe", "Externe"),
        ("Décidé", "Arrêt décidé"),
        ("Autre", "Autre"),
    ]

    date_evenement = models.ForeignKey(
        FactJournalier,
        on_delete=models.CASCADE,
        related_name="arrets",
        verbose_name="Journée de production",
    )
    equipement = models.CharField(max_length=100)
    nature = models.CharField(max_length=50, choices=NATURE_CHOICES, default="Autre")
    # AJOUTÉ — manquait en base alors que le script d'ingestion l'utilisait déjà.
    type_arret = models.CharField(
        max_length=32, choices=TYPE_CHOICES, default="Autre"
    )
    # AJOUTÉ — idem.
    unite = models.CharField(max_length=16, blank=True, default="")
    cause_precision = models.TextField()
    duree_arret_h = models.FloatField()
    semaine = models.PositiveSmallIntegerField(null=True, blank=True)
    mois = models.DateField(null=True, blank=True)

    # AJOUTÉ — clé naturelle pour une idempotence fiable (évite de fusionner
    # à tort deux arrêts distincts du même équipement, même jour, même cause).
    cle_naturelle = models.CharField(max_length=400, unique=True, editable=False)

    class Meta:
        ordering = ["date_evenement", "equipement"]
        verbose_name = "Arrêt"
        verbose_name_plural = "Registre des arrêts"
        indexes = [
            models.Index(fields=["nature"]),
            models.Index(fields=["equipement"]),
        ]

    def __str__(self):
        return f"{self.date_evenement_id} — {self.equipement} ({self.duree_arret_h} h)"

    def save(self, *args, **kwargs):
        if not self.cle_naturelle:
            self.cle_naturelle = "|".join(
                [
                    str(self.date_evenement_id),
                    (self.equipement or "").strip(),
                    (self.cause_precision or "").strip(),
                    self.type_arret,
                    f"{self.duree_arret_h:.6f}",
                ]
            )
        super().save(*args, **kwargs)


class EtatStocksFlux(models.Model):
    """Jumeau numérique de flux (Pilier 4 — vision prospective).

    AJOUTÉ : requis par analytics/serializers.py (EtatStocksFluxSerializer)
    et analytics/views.py (LiveAlertsView) qui référençaient déjà ce modèle
    alors qu'il n'existait pas encore côté maintenance.

    Pas encore alimenté par les fichiers Excel fournis (aucune donnée de
    stock/flux n'est présente dans data/) — prêt à recevoir une source
    (SCADA, MES, relevé manuel) dès qu'elle sera disponible.
    """

    date_enregistrement = models.DateTimeField(verbose_name="Horodatage")
    stock_amont_humide_t = models.FloatField(null=True, blank=True)
    rythme_alimentation_moyen_th = models.FloatField(null=True, blank=True)
    stock_aval_sec_t = models.FloatField(null=True, blank=True)
    capacite_max_silos_t = models.FloatField(null=True, blank=True)
    cadence_expedition_trains_th = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["-date_enregistrement"]
        verbose_name = "État stocks & flux"
        verbose_name_plural = "États stocks & flux"

    def __str__(self):
        return f"Flux @ {self.date_enregistrement:%Y-%m-%d %H:%M}"

    def flux_net_th(self) -> float:
        """Flux net = rythme d'alimentation des fours - cadence d'expédition."""
        if self.rythme_alimentation_moyen_th is None or self.cadence_expedition_trains_th is None:
            return 0.0
        return self.rythme_alimentation_moyen_th - self.cadence_expedition_trains_th

    def heures_avant_saturation(self):
        """Estime le temps restant avant saturation des silos aval, ou None
        si le flux net est négatif/nul (pas de risque) ou si des données
        manquent pour le calcul.
        """
        if (
            self.rythme_alimentation_moyen_th is None
            or self.cadence_expedition_trains_th is None
            or self.capacite_max_silos_t is None
            or self.stock_aval_sec_t is None
        ):
            return None
        flux_net = self.flux_net_th()
        if flux_net <= 0:
            return None  # Silos en décroissance ou stables : pas de risque.
        marge_t = self.capacite_max_silos_t - self.stock_aval_sec_t
        if marge_t <= 0:
            return 0.0
        return round(marge_t / flux_net, 2)