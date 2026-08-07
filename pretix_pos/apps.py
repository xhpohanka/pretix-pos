from django.apps import AppConfig
from django.utils.translation import gettext_lazy as _

from . import __version__


class PluginApp(AppConfig):
    name = "pretix_pos"
    verbose_name = "Point of sale"

    class PretixPluginMeta:
        name = _("Point of sale")
        author = "Jan Pohanka"
        description = _(
            "Box-office tool for staff: search orders, sell tickets directly, take reservations, "
            "confirm cash payment, and hand off to Seating for seat assignment."
        )
        visible = True
        version = __version__
        category = "FEATURE"
        compatibility = "pretix>=4.16.0"

    def ready(self):
        from . import signals  # NOQA
