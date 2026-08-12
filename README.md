# pretix-pos

Standalone box-office terminal for pretix: a small single-page app that pairs
itself to a pretix organizer via the Device API (no shared staff login) and
talks directly to pretix's public REST API. Any browser with the pairing
token can become a POS terminal.

## Development setup

Same as any pretix plugin:

```bash
cd pretix-pos
pip install -e .
cd ../pretix/src && python manage.py migrate
```

Enable it per-organizer under Control panel → (organizer) → Plugins, then
open `https://<your-instance>/<organizer-slug>/pos/` in any browser - no
pretix login required for that page itself.

## Pairing a terminal

1. In the pretix control panel: organizer → Devices → add a device (or reuse
   an unpaired one) → open its "Connect" page. This is all existing pretix
   core functionality - nothing new was built for it.
2. Copy the "Token" shown there.
3. On the POS page, paste the token and submit. The browser stores the
   resulting device API token in `localStorage` and is now paired - this
   persists across reloads, so a terminal only needs to be paired once.
4. Pick an event from the list (scoped to whatever events the device was
   granted - `all_events` or a specific `limit_events` set).

To un-pair a terminal (e.g. it's being retired or moved to a different
organizer), use the "Unpair this device" link in the app header - this only
clears the browser's local pairing, it does not revoke the device server-side
(do that from the Devices page if the device itself should stop working).

## Scope

- **Direct sale**: pick items (quantity, or click seats for seated items) and
  confirm cash payment in one step - the order is created directly as `paid`
  with the `boxoffice` payment provider.
- **Reservation**: same item/seat picking, but the order is left `pending`
  with the event's normal payment term as its expiry.
- **Sell a reservation**: search for the order, then take its outstanding
  payment.
- **Order search**: a single fuzzy field (order code, e-mail, attendee
  name, …), backed by the public API's own `?search=` order filter.
- **Seat placement / reassignment**: from an order's detail view, drag a
  rectangle over free seats to multi-select them, then place them onto the
  order's checked positions in one action; drag an already-placed seat of
  that order onto a free seat to move it.

## Architecture

Almost no server-side logic lives in this plugin - it's a thin static shell
(`pretix_pos/organizer/pos.html` + `static/pretix_pos/pos.js`) that calls
pretix's own public REST API (`/api/v1/...`) directly from the browser using
`Authorization: Device <token>`, the same mechanism pretixSCAN and other
official terminal apps use:

- **Device pairing**: `POST /api/v1/device/initialize` (pretix core).
- **Event list**: `GET /api/v1/organizers/{organizer}/events/` - naturally
  scoped by the device's `all_events`/`limit_events`.
- **Items**: `GET .../events/{event}/items/`.
- **Order create (sale/reservation)**: `POST .../events/{event}/orders/`
  using `OrderCreateSerializer` - the same synchronous, transactional path
  the public checkout API uses. `payment_provider: "boxoffice"` is used for
  immediate cash sales (pretix core's `BoxOfficeProvider`, always registered,
  no plugin needs to be enabled for it).
- **Paying an existing reservation**: `POST .../orders/{code}/payments/`
  (create, state `created`) then `POST .../payments/{id}/confirm/` -
  deliberately two calls instead of creating the payment directly as
  `confirmed`, because the single-call path silently swallows a
  `QuotaExceededException` instead of surfacing it; the explicit `confirm`
  action returns a proper error if the quota disappeared between reservation
  and payment.
- **Seat (re)assignment**: `PATCH .../events/{event}/orderpositions/{id}/`
  with `{"seat": "<guid>"}` - goes through the same `OrderChangeManager` the
  control panel's own order-editing UI uses, just reachable with a device
  token instead of a staff session.
- **Seat map with coordinates**: pretix core's own public `/seats/` endpoint
  deliberately omits the `x`/`y` drawing coordinates (they only exist because
  `pretix_seatmap` materializes them from a `SeatingPlan` layout). This
  plugin's sibling, `pretix_seatmap`, therefore registers an additional
  `/seatmap/` endpoint (`pretix_seatmap/api.py`) onto the same shared API
  router, adding `x`, `y`, and a precomputed `status` on top of core's own
  `SeatSerializer` fields - reachable with the same device token, read-only.
  This app only draws a seat map at all if `pretix_seatmap` is installed
  (checked via `window.PretixSeatingRenderer` - `pretix_seatmap`'s
  `seatmap.js` is loaded unconditionally and just does nothing if that
  plugin isn't present).

Because the whole thing is client-side and hits the same public API any
other integration would, there is very little bespoke server code to
maintain here - just two Django views in `pretix_pos/views.py`: a
`TemplateView` that renders the static shell and 404s if the plugin isn't
enabled for that organizer, and a `JavaScriptCatalog` view for i18n string
translation in pos.js.

## Known v1 limitations

- **Bulk seat placement is not atomic.** Placing N seats on N positions in
  one action issues N sequential `PATCH` requests; a failure partway through
  leaves the earlier ones placed. The UI reports exactly how many succeeded
  and which failed rather than pretending it's all-or-nothing.
- **Multi-date orders**: the seat map follows whichever date is selected
  in the dropdown at the top of the screen. An order spanning multiple
  dates shows positions for other dates as disabled/greyed-out context
  rows in the position list; switch the date to work with them.
- **Seated items with variations** are not supported for direct seat-picking
  (same underlying limitation as `pretix_seatmap`: `SeatCategoryMapping`
  only maps a layout category to an `Item`, never a specific
  `ItemVariation`).
- **Sales channel**: orders are created on the `pretix_pos` sales channel
  (a dedicated channel type for this plugin, shown as "Point of sale" in the
  control panel).
- **Estimated cart total only.** The cart shows a client-side sum of known
  default prices before submission; the authoritative price is always
  computed server-side by `OrderCreateSerializer`.
- The device's API token is stored in the browser's `localStorage` on
  whatever computer is paired - treat a paired browser like a signed-in
  terminal (it can create/pay orders and move seats for every event the
  device has access to) and unpair it before repurposing that computer.
