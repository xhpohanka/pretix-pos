import json
from django.test import TestCase
from django.urls import reverse
from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import Event, Item, Order, Organizer, Quota, Team, User


class POSSubeventTest(TestCase):
    @scopes_disabled()
    def setUp(self):
        self.organizer = Organizer.objects.create(name="Dummy", slug="dummy")
        self.event = Event.objects.create(
            organizer=self.organizer, name="Dummy", slug="dummy",
            date_from=now(), has_subevents=True, plugins="pretix_pos", live=True,
        )
        self.se1 = self.event.subevents.create(name="Date 1", date_from=now(), active=True)
        self.se2 = self.event.subevents.create(name="Date 2", date_from=now(), active=True)

        self.item = Item.objects.create(event=self.event, name="Ticket", default_price=10, admission=True)
        quota = Quota.objects.create(event=self.event, subevent=self.se1, size=100)
        quota.items.add(self.item)
        quota2 = Quota.objects.create(event=self.event, subevent=self.se2, size=100)
        quota2.items.add(self.item)

        self.user = User.objects.create_user("dummy@dummy.dummy", "dummy")
        t = Team.objects.create(organizer=self.organizer, all_event_permissions=True)
        t.members.add(self.user)
        t.limit_events.add(self.event)
        self.client.login(email="dummy@dummy.dummy", password="dummy")

    def _url(self, name, **kwargs):
        return reverse(f"plugins:pretix_pos:{name}", kwargs={
            "organizer": self.organizer.slug, "event": self.event.slug, **kwargs,
        })

    @scopes_disabled()
    def test_order_requires_subevent(self):
        resp = self.client.post(
            self._url("control.api_create_order"),
            data=json.dumps({"mode": "sell", "positions": [{"item": self.item.id}]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    @scopes_disabled()
    def test_order_with_subevent_succeeds(self):
        resp = self.client.post(
            self._url("control.api_create_order"),
            data=json.dumps({
                "mode": "sell", "subevent": self.se1.pk, "positions": [{"item": self.item.id}],
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        order = Order.objects.get(code=resp.json()["code"])
        self.assertEqual(order.positions.get().subevent_id, self.se1.pk)

    def test_items_endpoint_requires_subevent_param(self):
        resp = self.client.get(self._url("control.api_items"))
        self.assertEqual(resp.status_code, 400)

        resp2 = self.client.get(self._url("control.api_items"), {"subevent": self.se2.pk})
        self.assertEqual(resp2.status_code, 200)
