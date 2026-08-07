from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.translation import gettext_lazy as _
from pretix.api.serializers.order import OrderCreateSerializer
from pretix.base.models import OrderPayment
from pretix.base.models.orders import Quota
from rest_framework.exceptions import ValidationError as DRFValidationError


class POSError(Exception):
    """Raised for anything that should be shown to box-office staff as-is."""


def _flatten_errors(detail):
    if isinstance(detail, dict):
        parts = []
        for key, value in detail.items():
            flat = _flatten_errors(value)
            parts.append(flat if key in ("non_field_errors", "detail") else f"{key}: {flat}")
        return "; ".join(parts)
    if isinstance(detail, list):
        return "; ".join(_flatten_errors(v) for v in detail)
    return str(detail)


def create_order(event, request, positions, email=None, send_email=False, mark_paid=False):
    """
    positions: list of dicts, each at least {"item": <Item pk>}, optionally
    "variation", "subevent", "seat" (a seat_guid string).
    Returns the created Order. Raises POSError with a message safe to show
    to staff on any failure (validation, quota, seat conflict, ...).
    """
    if not positions:
        raise POSError(_("Select at least one item."))

    data = {
        "status": "n",
        "testmode": event.testmode,
        "locale": event.settings.locale,
        "positions": positions,
        "send_email": send_email,
    }
    if email:
        data["email"] = email

    serializer = OrderCreateSerializer(data=data, context={"event": event, "request": request})
    try:
        serializer.is_valid(raise_exception=True)
        order = serializer.save()
    except DRFValidationError as e:
        raise POSError(_flatten_errors(e.detail))
    except DjangoValidationError as e:
        raise POSError(_flatten_errors(e.message_dict if hasattr(e, "message_dict") else e.messages))
    except Quota.QuotaExceededException as e:
        raise POSError(str(e))

    if mark_paid:
        mark_paid_cash(order, request.user)
        order.refresh_from_db()

    return order


def mark_paid_cash(order, user):
    """
    Confirms cash payment for the order's full outstanding amount using core's
    plain "manual" provider - the same mechanism the control panel's own
    "mark as paid" action uses (pretix.control.views.orders.OrderTransition).
    Raises POSError on quota loss between reservation and payment.
    """
    amount = order.pending_sum
    payment = order.payments.create(
        state=OrderPayment.PAYMENT_STATE_CREATED,
        provider="manual",
        amount=amount,
    )
    try:
        payment.confirm(user=user, count_waitinglist=True, send_mail=False)
    except Quota.QuotaExceededException as e:
        raise POSError(str(e))
    return payment
