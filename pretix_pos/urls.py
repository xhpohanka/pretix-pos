from django.urls import path

from . import views

organizer_patterns = [
    path("pos/", views.POSAppView.as_view(), name="organizer.pos"),
]
