from datetime import datetime, timedelta, timezone
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone as dj_timezone
from django_scopes import scopes_disabled
from pretix.base.models import Event, Order, Organizer, SalesChannel, Team, User

from pretix_pos.channels import POSSalesChannelType


class POSAppViewTest(TestCase):
    @scopes_disabled()
    def setUp(self):
        self.organizer = Organizer.objects.create(name="Dummy", slug="dummy")

    def test_serves_without_any_login(self):
        self.organizer.plugins = "pretix_pos"
        self.organizer.save()
        resp = self.client.get(f"/{self.organizer.slug}/pos/")
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "pos-app")

    @scopes_disabled()
    def test_creates_pos_sales_channel_on_first_load(self):
        # POSSalesChannelType.default_created is False, so core never
        # auto-provisions this for organizers that already existed before the
        # plugin was installed - the view has to lazily create it itself.
        self.organizer.plugins = "pretix_pos"
        self.organizer.save()
        self.assertFalse(self.organizer.sales_channels.filter(identifier="pretix_pos").exists())
        resp = self.client.get(f"/{self.organizer.slug}/pos/")
        self.assertEqual(resp.status_code, 200)
        channel = self.organizer.sales_channels.get(identifier="pretix_pos")
        self.assertEqual(channel.type, "pretix_pos")
        self.assertContains(resp, 'data-sales-channel="pretix_pos"')

    @scopes_disabled()
    def test_does_not_duplicate_pos_sales_channel_on_repeat_loads(self):
        self.organizer.plugins = "pretix_pos"
        self.organizer.save()
        self.client.get(f"/{self.organizer.slug}/pos/")
        self.client.get(f"/{self.organizer.slug}/pos/")
        self.assertEqual(self.organizer.sales_channels.filter(identifier="pretix_pos").count(), 1)

    def test_pos_sales_channel_supports_payment_restrictions(self):
        self.assertTrue(POSSalesChannelType().payment_restrictions_supported)

    def test_404s_when_plugin_not_enabled(self):
        self.organizer.plugins = ""
        self.organizer.save()
        resp = self.client.get(f"/{self.organizer.slug}/pos/")
        self.assertEqual(resp.status_code, 404)

    def test_unknown_organizer_404s(self):
        resp = self.client.get("/does-not-exist/pos/")
        self.assertEqual(resp.status_code, 404)


class POSOrderSummaryViewTest(TestCase):
    @scopes_disabled()
    def setUp(self):
        self.organizer = Organizer.objects.create(name="Dummy", slug="dummy")
        self.organizer.plugins = "pretix_pos"
        self.organizer.save()
        self.event = Event.objects.create(
            organizer=self.organizer, name="Event", slug="event",
            date_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        self.event.plugins = "pretix_pos"
        self.event.save()
        self.user = User.objects.create_user("staff@example.com", "test")
        team = Team.objects.create(organizer=self.organizer, name="Staff", all_event_permissions=True)
        team.all_events = True
        team.save()
        team.members.add(self.user)
        self.client.force_login(self.user)

    def test_returns_paginated_summary_and_validates_status(self):
        url = f"/{self.organizer.slug}/pos/api/events/{self.event.slug}/orders/"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"], [])

        response = self.client.get(url, {"status": "not-a-status"})
        self.assertEqual(response.status_code, 400)

    @scopes_disabled()
    def test_filters_payment_source_and_overdue_orders(self):
        web, _ = SalesChannel.objects.get_or_create(
            organizer=self.organizer, identifier="web",
            defaults={"label": "Web", "type": "web"},
        )
        pos = SalesChannel.objects.create(
            organizer=self.organizer, identifier=POSSalesChannelType.identifier,
            label="POS", type=POSSalesChannelType.identifier,
        )
        now = dj_timezone.now()
        Order.objects.create(
            code="POSPAID", event=self.event, email="pos@example.com",
            status=Order.STATUS_PAID, secret="a" * 32, datetime=now,
            expires=now + timedelta(days=1), sales_channel=pos,
            total=Decimal("0.00"), locale="en",
        )
        Order.objects.create(
            code="WEBLATE", event=self.event, email="web@example.com",
            status=Order.STATUS_PENDING, secret="b" * 32, datetime=now,
            expires=now - timedelta(minutes=1), sales_channel=web,
            total=Decimal("10.00"), locale="en",
        )
        url = f"/{self.organizer.slug}/pos/api/events/{self.event.slug}/orders/"

        response = self.client.get(url, {"payment": "paid", "source": "pos"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([o["code"] for o in response.json()["results"]], ["POSPAID"])

        response = self.client.get(url, {"payment": "unpaid", "expiry": "overdue", "source": "other"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([o["code"] for o in response.json()["results"]], ["WEBLATE"])

        response = self.client.get(url, {"seating": "unknown"})
        self.assertEqual(response.status_code, 400)
