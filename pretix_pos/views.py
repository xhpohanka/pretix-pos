from django.http import Http404
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from django.views.i18n import JavaScriptCatalog
from i18nfield.strings import LazyI18nString

from .channels import POSSalesChannelType


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
