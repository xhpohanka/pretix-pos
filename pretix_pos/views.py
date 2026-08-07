import json
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST
from django.views.generic import TemplateView
from pretix.base.models import Order
from pretix.base.services.pricing import get_listed_price
from pretix.control.forms.filter import EventOrderFilterForm
from pretix.control.permissions import (
    EventPermissionRequiredMixin,
    event_permission_required,
)

from .services import POSError, create_order, mark_paid_cash


class POSView(EventPermissionRequiredMixin, TemplateView):
    template_name = "pretix_pos/control/pos.html"
    permission = "can_change_orders"

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        event = self.request.event
        ctx["subevents"] = event.subevents.filter(active=True).order_by("date_from") if event.has_subevents else None

        # Soft dependency: seat picking/assignment is delegated to the Seating
        # plugin if it's enabled for this event, rather than reimplemented here.
        if "pretix_seating" in event.get_plugins():
            kwargs_ = {"organizer": event.organizer.slug, "event": event.slug}
            ctx["seating_api_seats_url"] = reverse("plugins:pretix_seating:control.api_seats", kwargs=kwargs_)
            ctx["seating_assign_url"] = reverse("plugins:pretix_seating:control.assign", kwargs=kwargs_)
        return ctx


def _get_subevent(request):
    if not request.event.has_subevents:
        return None, None
    subevent_id = request.GET.get("subevent") or request.POST.get("subevent")
    if not subevent_id:
        return None, JsonResponse({"ok": False, "error": "subevent_required"}, status=400)
    subevent = get_object_or_404(request.event.subevents, pk=subevent_id)
    return subevent, None


@require_GET
@event_permission_required("can_change_orders")
def api_items(request, organizer, event):
    subevent, err = _get_subevent(request)
    if err:
        return err

    items = []
    qs = request.event.items.filter(active=True).prefetch_related("variations").order_by("category__position", "position")
    for item in qs:
        needs_seat = item.seat_category_mappings.filter(subevent=subevent).exists()
        variations = []
        if item.has_variations:
            for v in item.variations.filter(active=True):
                variations.append({
                    "id": v.pk,
                    "value": str(v.value),
                    "price": str(get_listed_price(item, v, subevent)),
                })
        items.append({
            "id": item.pk,
            "name": str(item.name),
            "price": str(get_listed_price(item, None, subevent)) if not item.has_variations else None,
            "has_variations": item.has_variations,
            "variations": variations,
            "needs_seat": needs_seat,
        })

    resp = JsonResponse({"items": items})
    resp["Cache-Control"] = "no-store"
    return resp


@require_GET
@event_permission_required("can_change_orders")
def api_search(request, organizer, event):
    query = (request.GET.get("q") or "").strip()
    if not query:
        return JsonResponse({"orders": []})

    form = EventOrderFilterForm(data={"query": query}, event=request.event)
    if not form.is_valid():
        return JsonResponse({"orders": []})

    qs = form.filter_qs(Order.objects.filter(event=request.event)).order_by("-datetime").distinct()[:25]
    orders = [_order_summary(o) for o in qs]
    resp = JsonResponse({"orders": orders})
    resp["Cache-Control"] = "no-store"
    return resp


def _order_summary(order):
    return {
        "code": order.code,
        "email": order.email,
        "status": order.status,
        "status_display": order.get_status_display(),
        "total": str(order.total),
        "pending_sum": str(order.pending_sum),
        "datetime": order.datetime.isoformat(),
    }


def _order_detail(order):
    positions = []
    for p in order.positions.filter(canceled=False).select_related("item", "variation", "seat", "subevent"):
        positions.append({
            "id": p.pk,
            "item": str(p.item.name),
            "variation": str(p.variation.value) if p.variation_id else None,
            "price": str(p.price),
            "subevent": p.subevent_id,
            "needs_seat": p.item.seat_category_mappings.filter(subevent=p.subevent).exists(),
            "seat_guid": p.seat.seat_guid if p.seat else None,
            "seat_label": str(p.seat) if p.seat else None,
        })
    data = _order_summary(order)
    data["ok"] = True
    data["positions"] = positions
    return data


@require_GET
@event_permission_required("can_change_orders")
def api_order_detail(request, organizer, event):
    code = (request.GET.get("code") or "").strip().upper()
    if not code:
        return JsonResponse({"ok": False, "error": "code_required"}, status=400)
    try:
        order = Order.objects.get(event=request.event, code=code)
    except Order.DoesNotExist:
        return JsonResponse({"ok": False, "error": "order_not_found"}, status=404)

    resp = JsonResponse(_order_detail(order))
    resp["Cache-Control"] = "no-store"
    return resp


@require_POST
@event_permission_required("can_change_orders")
def api_create_order(request, organizer, event):
    try:
        body = json.loads(request.body.decode())
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"ok": False, "error": "invalid_body"}, status=400)

    raw_positions = body.get("positions") or []
    mode = body.get("mode")  # "sell" (direct sale, mark paid) or "reserve" (pending)
    email = (body.get("email") or "").strip() or None

    if mode not in ("sell", "reserve"):
        return JsonResponse({"ok": False, "error": "invalid_mode"}, status=400)

    subevent_id = body.get("subevent")
    positions = []
    for rp in raw_positions:
        pos = {"item": rp.get("item")}
        if rp.get("variation"):
            pos["variation"] = rp["variation"]
        if subevent_id:
            pos["subevent"] = subevent_id
        if rp.get("seat"):
            pos["seat"] = rp["seat"]
        positions.append(pos)

    try:
        order = create_order(
            request.event, request, positions,
            email=email, send_email=bool(body.get("send_email")),
            mark_paid=(mode == "sell"),
        )
    except POSError as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=400)

    resp = JsonResponse(_order_detail(order))
    resp.status_code = 201
    return resp


@require_POST
@event_permission_required("can_change_orders")
def api_pay(request, organizer, event):
    try:
        body = json.loads(request.body.decode())
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"ok": False, "error": "invalid_body"}, status=400)

    code = (body.get("code") or "").strip().upper()
    try:
        order = Order.objects.get(event=request.event, code=code)
    except Order.DoesNotExist:
        return JsonResponse({"ok": False, "error": "order_not_found"}, status=404)

    if order.status == Order.STATUS_PAID:
        return JsonResponse(_order_detail(order))

    if order.status != Order.STATUS_PENDING:
        return JsonResponse({"ok": False, "error": "order_not_payable"}, status=409)

    try:
        mark_paid_cash(order, request.user)
    except POSError as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=400)

    order.refresh_from_db()
    return JsonResponse(_order_detail(order))
