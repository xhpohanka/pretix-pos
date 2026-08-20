from django.db.models import Case, Count, Exists, F, Min, OuterRef, Q, When
from django.http import Http404
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from django.views.i18n import JavaScriptCatalog
from i18nfield.strings import LazyI18nString
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from pretix.api.auth.permission import EventPermission
from pretix.api.pagination import Pagination
from pretix.base.models import Order, OrderPosition

from .channels import POSSalesChannelType


class POSOrderSummaryView(APIView):
    """A small, paginated order list for the POS find screen.

    Full ``OrderSerializer`` responses contain every position, payment and fee,
    which is unnecessary while browsing. The detail screen continues to load
    that authoritative representation only after staff select an order.
    """
    permission_classes = [EventPermission]
    permission = "event.orders:read"
    ordering_fields = {
        "datetime", "-datetime", "total", "-total", "last_modified", "-last_modified",
        "code", "-code", "status", "-status",
    }

    def get(self, request, *args, **kwargs):
        if "pretix_pos" not in request.organizer.get_plugins():
            raise Http404("Point of sale is not enabled for this organizer.")

        ordering = request.query_params.get("ordering", "-datetime")
        if ordering not in self.ordering_fields:
            raise ValidationError({"ordering": ["Unsupported ordering."]})

        statuses = [s for s in request.query_params.get("status", "").split(",") if s]
        valid_statuses = {c[0] for c in Order.STATUS_CHOICE}
        if statuses and not set(statuses) <= valid_statuses:
            raise ValidationError({"status": ["Unknown order status."]})

        queryset = Order.annotate_overpayments(request.event.orders.all(), results=False)
        if statuses:
            queryset = queryset.filter(status__in=statuses)

        query = request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(Q(code__iexact=query) | Q(email__icontains=query))

        subevent = request.query_params.get("subevent")
        if subevent:
            if not request.event.subevents.filter(pk=subevent).exists():
                raise ValidationError({"subevent": ["Unknown subevent."]})
            queryset = queryset.filter(Exists(OrderPosition.objects.filter(
                order=OuterRef("pk"), subevent_id=subevent, canceled=False,
            )))

        queryset = queryset.annotate(
            position_count=Count("all_positions", filter=Q(all_positions__canceled=False)),
            customer_name=Min("all_positions__attendee_name_cached", filter=Q(all_positions__canceled=False)),
            pending_sum=Case(
                When(status=Order.STATUS_CANCELED, then=F("pending_sum_rc")),
                default=F("pending_sum_t"),
            ),
        ).order_by(ordering, "pk")

        page = Pagination()
        summaries = queryset.values(
            "code", "status", "datetime", "last_modified", "expires", "total", "pending_sum",
            "email", "customer_name", "position_count", "sales_channel_id",
        )
        result_page = page.paginate_queryset(summaries, request, view=self)
        return page.get_paginated_response(result_page)


class POSJavaScriptCatalog(JavaScriptCatalog):
    """
    pos.js's own translatable strings (djangojs domain) - separate from
    pretix core's own /jsi18n/<lang>/ (pretix.base.views.js_catalog), which
    is scoped to the "pretix" package only and would never include this
    plugin's catalog.
    """
    domain = "djangojs"
    packages = ["pretix_pos"]


class POSAppView(TemplateView):
    """
    Serves the POS single-page app shell - a static, publicly reachable page
    (no pretix login) that pairs itself to a Device via pretix's own device
    initialization API and then talks to pretix's public REST API directly.
    All actual order/seat logic lives in static/pretix_pos/pos.js; this view
    exists only to render the page and to respect the organizer's plugin
    toggle (this route bypasses the per-event plugin gate that ordinary
    presale plugin URLs get, since there is no event in this URL, so the
    check has to happen here instead).
    """
    template_name = "pretix_pos/organizer/pos.html"

    def get(self, request, *args, **kwargs):
        if "pretix_pos" not in request.organizer.get_plugins():
            raise Http404("Point of sale is not enabled for this organizer.")
        # POSSalesChannelType.default_created is False (see channels.py), so
        # core never auto-provisions this for organizers that already existed
        # before the plugin was installed - lazily get_or_create it here
        # instead of requiring a manual one-time setup step in the control
        # panel. Idempotent, and cheap enough to just always check on load.
        request.organizer.sales_channels.get_or_create(
            identifier=POSSalesChannelType.identifier,
            defaults={"label": LazyI18nString.from_gettext(_("Point of sale")), "type": POSSalesChannelType.identifier},
        )
        return super().get(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["organizer"] = self.request.organizer
        ctx["sales_channel_identifier"] = POSSalesChannelType.identifier
        return ctx
