from django.urls import path

from . import views

organizer_patterns = [
    path("pos/", views.POSAppView.as_view(), name="organizer.pos"),
    path("pos/jsi18n/", views.POSJavaScriptCatalog.as_view(), name="organizer.pos.jsi18n"),
]
