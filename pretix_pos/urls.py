from django.urls import path

from . import views

urlpatterns = [
    path(
        "control/event/<str:organizer>/<str:event>/pos/",
        views.POSView.as_view(),
        name="control.pos",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/pos/api/items",
        views.api_items,
        name="control.api_items",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/pos/api/search",
        views.api_search,
        name="control.api_search",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/pos/api/order",
        views.api_order_detail,
        name="control.api_order_detail",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/pos/api/create-order",
        views.api_create_order,
        name="control.api_create_order",
    ),
    path(
        "control/event/<str:organizer>/<str:event>/pos/api/pay",
        views.api_pay,
        name="control.api_pay",
    ),
]
