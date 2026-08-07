import json
from django.test import TestCase
from django.urls import reverse
from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import Event, Item, Order, Organizer, Team, User
from pretix.base.services.seating import generate_seats

SAMPLE_PLAN = json.dumps({
    "name": "Sample plan",
    "categories": [{"name": "Stalls", "color": "#33ffff"}],
    "zones": [
        {
            "name": "Main Area",
            "position": {"x": 0, "y": 0},
            "rows": [
                {
                    "row_number": "0",
                    "position": {"x": 40, "y": 25},
                    "seats": [
                        {"seat_guid": "0-0", "seat_number": "0", "position": {"x": 0, "y": 0}, "category": "Stalls"},
                        {"seat_guid": "0-1", "seat_number": "1", "position": {"x": 30, "y": 0}, "category": "Stalls"},
                    ],
                }
            ],
        }
    ],
    "size": {"width": 600, "height": 500},
})


class POSSeatedItemTest(TestCase):
    @scopes_disabled()
    def setUp(self):
        self.organizer = Organizer.objects.create(name="Dummy", slug="dummy")
        self.event = Event.objects.create(
            organizer=self.organizer, name="Dummy", slug="dummy",
            date_from=now(), plugins="pretix_pos,pretix_seating", live=True,
        )
        self.item = Item.objects.create(event=self.event, name="Ticket", default_price=23, admission=True)
        quota = self.event.quotas.create(name="Q", size=100)
        quota.items.add(self.item)

        plan = self.organizer.seating_plans.create(name="Plan", layout=SAMPLE_PLAN)
        self.event.seating_plan = plan
        self.event.save()
        generate_seats(self.event, None, plan, {"Stalls": self.item})
        self.event.seat_category_mappings.create(layout_category="Stalls", product=self.item)

        self.user = User.objects.create_user("dummy@dummy.dummy", "dummy")
        t = Team.objects.create(organizer=self.organizer, all_event_permissions=True)
        t.members.add(self.user)
        t.limit_events.add(self.event)
        self.client.login(email="dummy@dummy.dummy", password="dummy")

    def _url(self, name, **kwargs):
        return reverse(f"plugins:pretix_pos:{name}", kwargs={
            "organizer": self.organizer.slug, "event": self.event.slug, **kwargs,
        })

    def _create_order(self, mode, positions):
        return self.client.post(
            self._url("control.api_create_order"),
            data=json.dumps({"mode": mode, "positions": positions}),
            content_type="application/json",
        )

    def test_items_endpoint_flags_seated_item(self):
        resp = self.client.get(self._url("control.api_items"))
        items = {i["name"]: i for i in resp.json()["items"]}
        self.assertTrue(items["Ticket"]["needs_seat"])

    @scopes_disabled()
    def test_direct_sale_with_seat_sets_position_seat(self):
        resp = self._create_order("sell", [{"item": self.item.id, "seat": "0-0"}])
        self.assertEqual(resp.status_code, 201, resp.content)
        order = Order.objects.get(code=resp.json()["code"])
        pos = order.positions.get()
        self.assertEqual(pos.seat.seat_guid, "0-0")
        self.assertEqual(order.status, Order.STATUS_PAID)

    @scopes_disabled()
    def test_cannot_sell_the_same_seat_twice(self):
        first = self._create_order("sell", [{"item": self.item.id, "seat": "0-0"}])
        self.assertEqual(first.status_code, 201, first.content)

        second = self._create_order("sell", [{"item": self.item.id, "seat": "0-0"}])
        self.assertEqual(second.status_code, 400)

    @scopes_disabled()
    def test_seated_item_requires_a_seat(self):
        resp = self._create_order("sell", [{"item": self.item.id}])
        self.assertEqual(resp.status_code, 400)
