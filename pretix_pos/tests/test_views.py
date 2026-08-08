from django.test import TestCase
from django_scopes import scopes_disabled
from pretix.base.models import Organizer


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

    def test_404s_when_plugin_not_enabled(self):
        self.organizer.plugins = ""
        self.organizer.save()
        resp = self.client.get(f"/{self.organizer.slug}/pos/")
        self.assertEqual(resp.status_code, 404)

    def test_unknown_organizer_404s(self):
        resp = self.client.get("/does-not-exist/pos/")
        self.assertEqual(resp.status_code, 404)
