from django.apps import AppConfig
from django.utils.translation import gettext_lazy as _
from pretix.base.plugins import PLUGIN_LEVEL_ORGANIZER

from . import __version__


class PluginApp(AppConfig):
    name = "pretix_pos"
    verbose_name = "Point of sale"

    class PretixPluginMeta:
        name = _("Point of sale")
        author = "Jan Pohanka"
        description = _(
            "Standalone box-office terminal app: pair a device (no pretix login needed), pick an "
            "event, then sell tickets for cash, take reservations, sell existing reservations, and "
            "place or move seats - from any browser on any computer."
        )
        visible = True
        version = __version__
        category = "FEATURE"
        level = PLUGIN_LEVEL_ORGANIZER
        compatibility = "pretix>=4.16.0"

    def ready(self):
        from . import signals  # NOQA
