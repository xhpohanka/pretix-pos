import json
from django.test import TestCase
from django.urls import reverse
from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import (
    Event,
    Item,
    ItemVariation,
    Order,
    OrderPayment,
    Organizer,
    Quota,
    Team,
    User,
)


class POSViewsTest(TestCase):
    @scopes_disabled()
    def setUp(self):
        self.organizer = Organizer.objects.create(name="Dummy", slug="dummy")
        self.event = Event.objects.create(
            organizer=self.organizer, name="Dummy", slug="dummy",
            date_from=now(), plugins="pretix_pos", live=True,
        )
        self.item = Item.objects.create(event=self.event, name="Ticket", default_price=23, admission=True)
        quota = Quota.objects.create(event=self.event, size=100)
        quota.items.add(self.item)

        self.item_var = Item.objects.create(event=self.event, name="T-Shirt", default_price=15)
        self.var_s = ItemVariation.objects.create(item=self.item_var, value="S", default_price=15)
        self.var_l = ItemVariation.objects.create(item=self.item_var, value="L", default_price=17)
        quota2 = Quota.objects.create(event=self.event, size=100)
        quota2.variations.add(self.var_s, self.var_l)
        quota2.items.add(self.item_var)

        self.user = User.objects.create_user("dummy@dummy.dummy", "dummy")
        t = Team.objects.create(organizer=self.organizer, all_event_permissions=True)
        t.members.add(self.user)
        t.limit_events.add(self.event)
        self.client.login(email="dummy@dummy.dummy", password="dummy")

    def _url(self, name, **kwargs):
        return reverse(f"plugins:pretix_pos:{name}", kwargs={
            "organizer": self.organizer.slug, "event": self.event.slug, **kwargs,
        })

    def _create_order(self, mode, positions, email=None):
        return self.client.post(
            self._url("control.api_create_order"),
            data=json.dumps({"mode": mode, "positions": positions, "email": email}),
            content_type="application/json",
        )

    # --- items -------------------------------------------------------

    def test_items_endpoint_lists_items_with_prices(self):
        resp = self.client.get(self._url("control.api_items"))
        self.assertEqual(resp.status_code, 200)
        items = {i["name"]: i for i in resp.json()["items"]}
        self.assertEqual(items["Ticket"]["price"], "23.00")
        self.assertFalse(items["Ticket"]["needs_seat"])
        self.assertTrue(items["T-Shirt"]["has_variations"])
        variations = {v["value"]: v for v in items["T-Shirt"]["variations"]}
        self.assertEqual(variations["L"]["price"], "17.00")

    # --- direct sale ---------------------------------------------------

    @scopes_disabled()
    def test_direct_sale_creates_paid_order_with_cash_payment(self):
        resp = self._create_order("sell", [{"item": self.item.id}, {"item": self.item.id}])
        self.assertEqual(resp.status_code, 201, resp.content)
        data = resp.json()
        self.assertEqual(data["status"], "p")
        self.assertEqual(len(data["positions"]), 2)

        order = Order.objects.get(code=data["code"])
        self.assertEqual(order.status, Order.STATUS_PAID)
        payment = order.payments.get()
        self.assertEqual(payment.provider, "manual")
        self.assertEqual(payment.state, OrderPayment.PAYMENT_STATE_CONFIRMED)
        self.assertEqual(payment.amount, order.total)

    @scopes_disabled()
    def test_direct_sale_with_variation(self):
        resp = self._create_order("sell", [{"item": self.item_var.id, "variation": self.var_l.id}])
        self.assertEqual(resp.status_code, 201, resp.content)
        order = Order.objects.get(code=resp.json()["code"])
        pos = order.positions.get()
        self.assertEqual(pos.variation_id, self.var_l.id)
        self.assertEqual(pos.price, 17)

    # --- reservation -----------------------------------------------------

    @scopes_disabled()
    def test_reservation_creates_pending_order_without_payment(self):
        resp = self._create_order("reserve", [{"item": self.item.id}])
        self.assertEqual(resp.status_code, 201, resp.content)
        data = resp.json()
        self.assertEqual(data["status"], "n")

        order = Order.objects.get(code=data["code"])
        self.assertEqual(order.status, Order.STATUS_PENDING)
        self.assertFalse(order.payments.exists())
        self.assertIsNotNone(order.expires)

    @scopes_disabled()
    def test_invalid_mode_rejected(self):
        resp = self._create_order("bogus", [{"item": self.item.id}])
        self.assertEqual(resp.status_code, 400)

    @scopes_disabled()
    def test_empty_cart_rejected(self):
        resp = self._create_order("reserve", [])
        self.assertEqual(resp.status_code, 400)

    # --- selling a reservation (find + pay) -------------------------------

    @scopes_disabled()
    def test_sell_a_reservation(self):
        resp = self._create_order("reserve", [{"item": self.item.id}])
        code = resp.json()["code"]

        pay_resp = self.client.post(
            self._url("control.api_pay"),
            data=json.dumps({"code": code}),
            content_type="application/json",
        )
        self.assertEqual(pay_resp.status_code, 200, pay_resp.content)
        self.assertEqual(pay_resp.json()["status"], "p")

        order = Order.objects.get(code=code)
        self.assertEqual(order.status, Order.STATUS_PAID)

    @scopes_disabled()
    def test_paying_already_paid_order_is_a_no_op(self):
        resp = self._create_order("sell", [{"item": self.item.id}])
        code = resp.json()["code"]

        pay_resp = self.client.post(
            self._url("control.api_pay"),
            data=json.dumps({"code": code}),
            content_type="application/json",
        )
        self.assertEqual(pay_resp.status_code, 200)
        order = Order.objects.get(code=code)
        self.assertEqual(order.payments.count(), 1)  # no second payment created

    # --- search ------------------------------------------------------

    @scopes_disabled()
    def test_search_finds_order_by_code_and_email(self):
        resp = self._create_order("reserve", [{"item": self.item.id}], email="buyer@example.org")
        code = resp.json()["code"]

        by_code = self.client.get(self._url("control.api_search"), {"q": code})
        self.assertEqual([o["code"] for o in by_code.json()["orders"]], [code])

        by_email = self.client.get(self._url("control.api_search"), {"q": "buyer@example.org"})
        self.assertEqual([o["code"] for o in by_email.json()["orders"]], [code])

    def test_search_without_query_returns_empty(self):
        resp = self.client.get(self._url("control.api_search"))
        self.assertEqual(resp.json()["orders"], [])

    # --- quota ---------------------------------------------------------

    @scopes_disabled()
    def test_quota_exceeded_is_reported_cleanly(self):
        quota = Quota.objects.create(event=self.event, size=1)
        item = Item.objects.create(event=self.event, name="Limited", default_price=5, admission=True)
        quota.items.add(item)

        first = self._create_order("reserve", [{"item": item.id}])
        self.assertEqual(first.status_code, 201, first.content)

        second = self._create_order("reserve", [{"item": item.id}])
        self.assertEqual(second.status_code, 400)
        self.assertIn("error", second.json())
