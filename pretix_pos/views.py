from django.http import Http404
from django.views.generic import TemplateView


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
        return super().get(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["organizer"] = self.request.organizer
        return ctx
