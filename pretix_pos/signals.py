from django.dispatch import receiver
from django.urls import resolve, reverse
from django.utils.translation import gettext_lazy as _
from pretix.control.signals import nav_event


@receiver(nav_event, dispatch_uid="pretix_pos_nav_event")
def control_nav_pos(sender, request=None, **kwargs):
    if not request.user.has_event_permission(
        request.organizer, request.event, "can_change_orders", request=request
    ):
        return []
    url = resolve(request.path_info)
    return [
        {
            "label": _("Point of sale"),
            "url": reverse(
                "plugins:pretix_pos:control.pos",
                kwargs={"event": request.event.slug, "organizer": request.event.organizer.slug},
            ),
            "active": url.namespace == "plugins:pretix_pos",
            "icon": "shopping-cart",
        },
    ]
