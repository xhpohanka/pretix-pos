from django.utils.translation import gettext_lazy as _
from pretix.base.channels import SalesChannelType


class POSSalesChannelType(SalesChannelType):
    """
    Own sales channel type so orders placed through this plugin's terminal
    show up as "Point of sale" instead of the default "Online shop" - matches
    how the real pretixPOS product does this (see the docstring of
    SalesChannelType.payment_restrictions_supported in pretix core, which
    names it as the reference example). Payments are always taken locally at
    the terminal (cash via the "boxoffice" provider, or marked as a pending
    reservation), never through the organizer's configured online payment
    providers, hence payment_restrictions_supported=False.
    """
    identifier = "pretix_pos"
    verbose_name = _("Point of sale")
    icon = "shopping-cart"
    default_created = False
    multiple_allowed = False
    payment_restrictions_supported = False
