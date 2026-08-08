from django.dispatch import receiver
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from pretix.control.signals import nav_organizer


@receiver(nav_organizer, dispatch_uid="pretix_pos_nav_organizer")
def control_nav_pos(sender, request=None, organizer=None, **kwargs):
    if not request.user.has_organizer_permission(
        organizer, "can_change_organizer_settings", request=request
    ):
        return []
    return [
        {
            "label": _("Point of sale"),
            "url": reverse("plugins:pretix_pos:organizer.pos", kwargs={"organizer": organizer.slug}),
            "active": False,
            "icon": "shopping-cart",
        },
    ]
