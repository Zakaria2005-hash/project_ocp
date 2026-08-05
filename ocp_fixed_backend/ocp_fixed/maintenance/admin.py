from django.contrib import admin

from .models import FactJournalier, FactArret, EtatStocksFlux, ObjectifEnergetique


@admin.register(FactJournalier)
class FactJournalierAdmin(admin.ModelAdmin):
    list_display = (
        "date",
        "production_totale_t",
        "trs_calc",
        "trg",
        "disponibilite_globale",
        "taux_panne",
        "qualite_traitee",
        "conso_energie_kcalt",
        "journee_partielle",
    )
    list_filter = ("qualite_traitee", "journee_partielle")
    date_hierarchy = "date"
    ordering = ("-date",)


@admin.register(FactArret)
class FactArretAdmin(admin.ModelAdmin):
    list_display = (
        "date_evenement",
        "equipement",
        "nature",
        "type_arret",
        "duree_arret_h",
        "unite",
    )
    list_filter = ("nature", "type_arret", "unite")
    search_fields = ("equipement", "cause_precision")


@admin.register(ObjectifEnergetique)
class ObjectifEnergetiqueAdmin(admin.ModelAdmin):
    list_display = ("mois", "baseline_kcalt", "mis_a_jour_le")
    ordering = ("-mois",)


@admin.register(EtatStocksFlux)
class EtatStocksFluxAdmin(admin.ModelAdmin):
    list_display = (
        "date_enregistrement",
        "stock_amont_humide_t",
        "stock_aval_sec_t",
        "capacite_max_silos_t",
    )
    date_hierarchy = "date_enregistrement"

