# pretix-pos

Box-office point-of-sale tool for pretix staff: a stripped-down control-panel
page (per event) for the workflows a physical ticket counter actually needs,
instead of the full order-management UI.

Internal, closed-source plugin — not for redistribution.

## Development setup

Same as any pretix plugin:

```bash
cd pretix-pos
pip install -e .
cd ../pretix/src && python manage.py migrate
```

Enable it per-event under Control panel → Settings → Plugins. Find it under
"Point of sale" in the event's sidebar.

## Scope

- **Direct sale**: pick items (quantity, or click seats directly for
  seated items) and confirm cash payment in one step - order is created
  already `paid`.
- **Reservation**: same item/seat picking, but the order is left `pending`
  with the event's normal payment term as its expiry - nothing is charged yet.
- **Sell a reservation**: find an existing pending order and confirm cash
  payment for the outstanding amount.
- **Order search**: a single fuzzy field (order code, e-mail, attendee name, …)
  - reuses core's own control-panel order search (`EventOrderFilterForm`),
    scoped to the event currently open.
- **Seat (re)assignment**: not reimplemented here - if the `pretix_seating`
  plugin is enabled for the event, an order's detail panel links straight
  into its seat-assignment page (`?code=...` deep link) for placing/moving
  seats on already-existing orders (e.g. resolving oversold reservations).

## Design decisions / v1 scope

- **Event-scoped, not organizer-scoped.** A box office generally works one
  production/venue (one pretix event) at a time, with many dates
  (subevents) - the built-in event switcher already covers "a different
  show entirely". This also means it reuses the same permission
  (`can_change_orders`) and URL conventions as every other per-event
  control-panel page/plugin in this codebase.
- **Order creation goes through `OrderCreateSerializer`** (the same
  synchronous, transactional order-creation path the public REST API uses),
  not the celery-queued public-checkout cart flow - appropriate for an
  interactive, in-person sale where staff need an immediate result.
- **Cash payment** creates and confirms an `OrderPayment` with the plain
  `manual` provider identifier, exactly like the control panel's own
  "mark as paid" action does - no payment gateway involved.
- **Sales channel**: orders are created on the `web` channel (no dedicated
  "point of sale" channel yet). If you need item availability to differ
  between the box office and the online shop, this would be the first
  thing to add.
- Seated items with **variations** are not supported for direct
  seat-picking in v1 (mirrors the same limitation in `pretix_seating`:
  `SeatCategoryMapping` only maps a layout category to an `Item`, never a
  specific `ItemVariation`).
