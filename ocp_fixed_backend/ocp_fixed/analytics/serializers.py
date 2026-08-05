"""
================================================================================
  analytics/serializers.py — Sérialiseurs DRF pour les endpoints API REST
                              (VERSION CORRIGÉE)
================================================================================
Correction : `serializers.models.Sum(...)` n'existe pas — le module DRF
`rest_framework.serializers` n'a pas d'attribut `models`. Cela provoquait un
`AttributeError` à chaque appel de `get_duree_totale_arrets_h()`. Corrigé en
important `Sum` directement depuis `django.db.models`.
================================================================================
"""
from django.db.models import Sum
from rest_framework import serializers

from maintenance.models import FactJournalier, FactArret, EtatStocksFlux


class FactArretSerializer(serializers.ModelSerializer):
    class Meta:
        model = FactArret
        fields = "__all__"


class FactJournalierSerializer(serializers.ModelSerializer):
    nb_arrets = serializers.SerializerMethodField()
    duree_totale_arrets_h = serializers.SerializerMethodField()
    derive_thermique_pct = serializers.SerializerMethodField()

    class Meta:
        model = FactJournalier
        fields = "__all__"

    def get_nb_arrets(self, obj):
        return obj.arrets.count()

    def get_duree_totale_arrets_h(self, obj):
        # CORRIGÉ : Sum importé de django.db.models, pas de serializers.models.
        total = obj.arrets.aggregate(total=Sum("duree_arret_h"))["total"]
        return round(total, 2) if total else 0.0

    def get_derive_thermique_pct(self, obj):
        return obj.derive_thermique()


class EtatStocksFluxSerializer(serializers.ModelSerializer):
    flux_net_th = serializers.SerializerMethodField()
    heures_avant_saturation = serializers.SerializerMethodField()

    class Meta:
        model = EtatStocksFlux
        fields = "__all__"

    def get_flux_net_th(self, obj):
        return round(obj.flux_net_th(), 2)

    def get_heures_avant_saturation(self, obj):
        return obj.heures_avant_saturation()


class AlertSerializer(serializers.Serializer):
    """Sérialiseur générique pour les alertes (ML + Flux)."""
    date = serializers.CharField()
    niveau = serializers.CharField()
    type = serializers.CharField()
    score = serializers.FloatField(required=False)
    details = serializers.CharField(required=False)
    message = serializers.CharField(required=False)
