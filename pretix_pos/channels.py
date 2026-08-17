from django.utils.translation import gettext_lazy as _
from pretix.base.channels import SalesChannelType


class POSSalesChannelType(SalesChannelType):
    """
    Own sales channel type so orders placed through this plugin's terminal
    show up as "Point of sale" instead of the default "Online shop".

    Immediate POS sales still handle their payment locally, but reservations
    created through this channel can deliberately stay unpaid so the customer
    can later choose one of the organizer's configured online payment methods.
    Therefore payment providers must be able to opt in to this sales channel.
    """
    identifier = "pretix_pos"
    verbose_name = _("Point of sale")
    icon = "shopping-cart"
    default_created = False
    multiple_allowed = False
    payment_restrictions_supported = True
