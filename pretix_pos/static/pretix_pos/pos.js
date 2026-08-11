(function () {
    "use strict";

    var root = document.getElementById("pos-app");
    if (!root) return;

    var API_BASE = root.dataset.apiBase;
    var ORGANIZER = root.dataset.organizer;
    var SALES_CHANNEL = root.dataset.salesChannel;
    var STORAGE_KEY = "pretix_pos_state:" + ORGANIZER;
    var DRAG_THRESHOLD = 4;

    var state = loadState();
    var itemsById = {};
    var sellItems = [];
    var sellSeats = [];
    var cart = [];
    var activeSeatItem = null;
    var currentOrder = null;
    var placementPool = {}; // seat_guid -> seat, pending bulk placement on the loaded order
    var orderSeats = [];
    var subeventPriceOverrides = {}; // subeventId -> {items: {itemId: price}, variations: {variationId: price}}
    var subeventSeatingPlans = {}; // subeventId -> true if that date has a seating plan at all

    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function clearState() {
        localStorage.removeItem(STORAGE_KEY);
        state = {};
    }

    function api(path, opts) {
        opts = opts || {};
        var headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
        if (state.token) headers.Authorization = "Device " + state.token;
        return fetch(API_BASE + path, Object.assign({}, opts, {headers: headers, cache: "no-store"}))
            .then(function (r) {
                return r.text().then(function (t) {
                    var data = null;
                    if (t) {
                        try {
                            data = JSON.parse(t);
                        } catch (e) {
                            // non-JSON error body, leave data null
                        }
                    }
                    return {status: r.status, ok: r.ok, data: data};
                });
            });
    }

    // The public API paginates list endpoints (PAGE_SIZE=50) - a plan with
    // more than 50 seats (any real venue above ~3 rows of 15) silently lost
    // every seat past the first page, since api() alone only ever fetched
    // page 1. Deliberately does NOT follow the response's own "next" URL -
    // that's an *absolute* URL built server-side from the request host, which
    // doesn't match the browser's actual origin behind a reverse proxy/tunnel
    // (confirmed live behind this deployment's ngrok tunnel: fetching it
    // outright failed with "TypeError: Failed to fetch", a cross-origin/
    // unreachable-host failure, not an HTTP error status). Instead just
    // increments our own "page" query param on the same relative path we
    // already know works, using "next" only as a boolean "is there more".
    // Concatenates into the same {status, ok, data: {results}} shape api()
    // returns, so callers don't need to change beyond swapping which
    // function they call.
    function apiAllPages(path) {
        var results = [];
        var sep = path.indexOf("?") === -1 ? "?" : "&";
        function loadPage(page) {
            var p = page === 1 ? path : path + sep + "page=" + page;
            return api(p).then(function (res) {
                if (!res.ok || !res.data) return {status: res.status, ok: res.ok, data: {results: results}};
                results = results.concat(res.data.results || []);
                if (res.data.next) return loadPage(page + 1);
                return {status: res.status, ok: true, data: {results: results}};
            });
        }
        return loadPage(1);
    }

    function pickI18n(v) {
        if (v == null) return "";
        if (typeof v === "string") return v;
        var lang = document.documentElement.lang;
        if (v[lang]) return v[lang];
        if (v.en) return v.en;
        var keys = Object.keys(v);
        return keys.length ? v[keys[0]] : "";
    }

    // The order-create endpoint's `positions` errors are an array with one
    // entry per submitted position (empty {} for positions with no error) -
    // a naive Array.isArray(v) ? v.join(" ") : ... (the previous approach)
    // stringified each per-position *object* via join(), producing literal
    // "[object Object]" text instead of the actual nested field errors.
    // Recurses through strings/arrays/objects uniformly instead, and drops
    // empty branches (like the no-error {} placeholders) instead of turning
    // them into noise.
    function flattenError(data) {
        if (data == null) return "";
        if (typeof data === "string") return data;
        if (Array.isArray(data)) {
            var items = [];
            data.forEach(function (item, i) {
                var s = flattenError(item);
                if (s) items.push((data.length > 1 ? "[" + i + "] " : "") + s);
            });
            return items.join(" | ");
        }
        if (typeof data === "object") {
            if (data.detail) return String(data.detail);
            var parts = [];
            Object.keys(data).forEach(function (key) {
                var flat = flattenError(data[key]);
                if (flat) parts.push(key === "non_field_errors" ? flat : (key + ": " + flat));
            });
            return parts.join(" | ");
        }
        return String(data);
    }

    function describeError(data) {
        return flattenError(data) || "Unknown error.";
    }

    function setMsg(el, text, kind) {
        el.textContent = text || "";
        el.className = "pos-msg" + (kind ? " pos-" + kind : "");
    }

    function fmtMoney(v) {
        return v == null ? "" : String(v);
    }

    // ---------------------------------------------------------------- screens

    var screens = {
        pair: document.getElementById("pos-screen-pair"),
        events: document.getElementById("pos-screen-events"),
        main: document.getElementById("pos-screen-main"),
    };

    function showScreen(name) {
        Object.keys(screens).forEach(function (k) {
            screens[k].hidden = k !== name;
        });
    }

    var headerInfo = document.getElementById("pos-header-info");
    var btnChangeEvent = document.getElementById("pos-btn-change-event");
    var btnUnpair = document.getElementById("pos-btn-unpair");

    btnUnpair.addEventListener("click", function () {
        if (!window.confirm("Unpair this terminal? You will need a new initialization token to reconnect.")) return;
        clearState();
        boot();
    });

    btnChangeEvent.addEventListener("click", function () {
        delete state.event;
        saveState();
        boot();
    });

    // ---------------------------------------------------------------- pairing

    var pairForm = document.getElementById("pos-pair-form");
    var pairTokenInput = document.getElementById("pos-pair-token");
    var pairMsg = document.getElementById("pos-pair-msg");

    pairForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var token = pairTokenInput.value.trim();
        if (!token) return;
        setMsg(pairMsg, "Connecting…", null);
        api("/device/initialize", {
            method: "POST",
            body: JSON.stringify({
                token: token,
                hardware_brand: "Web browser",
                hardware_model: navigator.userAgent.slice(0, 190),
                software_brand: "pretix_pos",
                software_version: "1",
            }),
        }).then(function (res) {
            if (!res.ok) {
                setMsg(pairMsg, describeError(res.data), "error");
                return;
            }
            state = {
                token: res.data.api_token,
                deviceId: res.data.device_id,
                uniqueSerial: res.data.unique_serial,
                deviceName: res.data.name,
            };
            saveState();
            boot();
        }).catch(function () {
            setMsg(pairMsg, "Network error.", "error");
        });
    });

    // ---------------------------------------------------------------- events

    var eventsList = document.getElementById("pos-events-list");

    function loadEvents() {
        showScreen("events");
        eventsList.textContent = "Loading…";
        api("/organizers/" + ORGANIZER + "/events/?ordering=-date_from").then(function (res) {
            if (!res.ok) {
                eventsList.textContent = "Could not load events (" + describeError(res.data) + ").";
                return;
            }
            var events = (res.data && res.data.results) || [];
            if (!events.length) {
                eventsList.textContent = "This device has no events assigned to it. Ask an administrator to grant it access on the Devices page.";
                return;
            }
            eventsList.innerHTML = "";
            events.forEach(function (ev) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "pos-event-btn";
                var when = ev.date_from ? new Date(ev.date_from).toLocaleDateString() : "";
                btn.textContent = pickI18n(ev.name) + (when ? " — " + when : "");
                btn.addEventListener("click", function () {
                    state.event = {
                        slug: ev.slug, hasSubevents: ev.has_subevents, name: pickI18n(ev.name),
                        // Only meaningful (and only used) for events without
                        // subevents - see orderIsSeated(). Events *with*
                        // subevents track this per-date instead, in
                        // subeventSeatingPlans (loadSubevents()).
                        seatingPlan: ev.seating_plan || null,
                    };
                    saveState();
                    boot();
                });
                eventsList.appendChild(btn);
            });
        });
    }

    // ------------------------------------------------------------- main app

    var subeventBar = document.getElementById("pos-subevent-bar");
    var subeventSelect = document.getElementById("pos-subevent");

    var tabs = Array.prototype.slice.call(document.querySelectorAll(".pos-tab"));
    var panels = {
        sell: document.getElementById("pos-tab-sell"),
        find: document.getElementById("pos-tab-find"),
    };
    tabs.forEach(function (btn) {
        btn.addEventListener("click", function () {
            tabs.forEach(function (b) { b.classList.toggle("active", b === btn); });
            Object.keys(panels).forEach(function (k) {
                panels[k].hidden = k !== btn.dataset.tab;
            });
            if (btn.dataset.tab === "find" && !searchInput.value.trim()) {
                loadDefaultOrderList();
            }
        });
    });

    function currentSubeventId() {
        return state.event.hasSubevents ? (subeventSelect.value || null) : null;
    }

    function subeventLabel(id) {
        var opt = subeventSelect.querySelector('option[value="' + id + '"]');
        return opt ? opt.textContent : ("#" + id);
    }

    // Order positions come from the API with a numeric `subevent` (or null);
    // currentSubeventId() reads a <select>'s value, always a string. A plain
    // `===` between the two is always false even when they mean the same
    // date - normalize both sides through this before comparing anywhere a
    // position's subevent needs to be checked against "the date currently on
    // screen" (null/undefined/"" all mean "no subevent", for events that
    // don't have any).
    function subeventsMatch(a, b) {
        var na = (a == null || a === "") ? null : String(a);
        var nb = (b == null || b === "") ? null : String(b);
        return na === nb;
    }

    // The price actually charged for an item/variation on a given date - a
    // date can override the base default_price (see loadSubevents()), so the
    // cart's displayed total can be shown as a real final amount instead of
    // hedging with "estimated" - POS doesn't support vouchers/memberships/
    // bundles at all (see the v1 limitations note), which are the only other
    // things that could otherwise make the server-computed price differ.
    function priceFor(itemId, variationId, subeventId) {
        var it = itemsById[itemId];
        var overrides = subeventId != null && subeventPriceOverrides[subeventId];
        if (variationId) {
            if (overrides && overrides.variations[variationId] != null) return overrides.variations[variationId];
            var v = it && (it.variations || []).find(function (vv) { return vv.id === variationId; });
            return v && v.default_price != null ? v.default_price : (it ? it.default_price : null);
        }
        if (overrides && overrides.items[itemId] != null) return overrides.items[itemId];
        return it ? it.default_price : null;
    }

    function eventPath(suffix) {
        return "/organizers/" + ORGANIZER + "/events/" + state.event.slug + suffix;
    }

    function loadMainScreen() {
        showScreen("main");
        headerInfo.textContent = (state.deviceName ? state.deviceName + " · " : "") + state.event.name;
        btnChangeEvent.hidden = false;
        btnUnpair.hidden = false;

        // A cart can span several dates of the same event (see subeventSelect's
        // change handler below) but never several events - this is the one
        // place a genuinely fresh session starts, whether from initial page
        // load or from "Change event".
        cart = [];
        activeSeatItem = null;
        renderCart();

        loadItemsIndex().then(function () {
            if (state.event.hasSubevents) {
                subeventBar.hidden = false;
                loadSubevents();
            } else {
                subeventBar.hidden = true;
                loadForCurrentContext();
            }
        });
    }

    function loadItemsIndex() {
        return api(eventPath("/items/")).then(function (res) {
            itemsById = {};
            if (res.ok && res.data) {
                (res.data.results || []).forEach(function (it) {
                    itemsById[it.id] = it;
                });
            }
        });
    }

    function loadSubevents() {
        subeventSelect.innerHTML = "";
        api(eventPath("/subevents/?active=true&ordering=date_from")).then(function (res) {
            var subs = (res.ok && res.data && res.data.results) || [];
            subeventPriceOverrides = {};
            subeventSeatingPlans = {};
            subs.forEach(function (se) {
                var opt = document.createElement("option");
                opt.value = se.id;
                opt.textContent = pickI18n(se.name) + " — " + new Date(se.date_from).toLocaleString();
                subeventSelect.appendChild(opt);

                // Whether this date has a seating plan at all - used by
                // orderIsSeated() to tell "still needs a seat" apart from
                // "seating doesn't apply here", which a bare "does every
                // position have a seat" check can't distinguish on its own.
                subeventSeatingPlans[se.id] = !!se.seating_plan;

                // A date can override an item's/variation's price from the base
                // default_price - needed to show a genuinely final total instead
                // of hedging with "estimated" (see priceFor()).
                var items = {}, variations = {};
                (se.item_price_overrides || []).forEach(function (o) {
                    if (o.price != null) items[o.item] = o.price;
                });
                (se.variation_price_overrides || []).forEach(function (o) {
                    if (o.price != null) variations[o.variation] = o.price;
                });
                subeventPriceOverrides[se.id] = {items: items, variations: variations};
            });
            loadForCurrentContext();
        });
    }

    subeventSelect.addEventListener("change", function () {
        // Switching the date must NOT drop whatever is already in the cart for
        // other dates - only the in-progress seat-picking UI (tied to this one
        // date's seatmap) needs resetting. Each cart entry carries its own
        // subeventId (see adjustQty/renderSeatpick), so buildPositions() below
        // still submits everything to the right date regardless of which date
        // is currently selected.
        activeSeatItem = null;
        loadForCurrentContext();

        // An order loaded in "Find order" has its own seatmap tied to
        // whichever date is on screen (see renderOrderDetail()) - if one is
        // open, switching the date here must re-fetch/rebuild it for the new
        // date, not just leave the old date's map showing. Clears the
        // placement pool too: pool entries are seat objects from the *old*
        // date's map, and dates sharing a seating plan reuse the same seat
        // guids (see the isCartSeat()/isOwnSeat() comments elsewhere in this
        // file) - carrying them over could silently misplace a seat search on
        // the new date's identically-numbered seat instead.
        if (currentOrder) {
            placementPool = {};
            renderOrderDetail();
        }
    });

    function loadForCurrentContext() {
        activeSeatItem = null;
        loadSellItems();
    }

    // --------------------------------------------------------------- sell tab

    var sellItemsEl = document.getElementById("pos-items");
    var seatpickWrap = document.getElementById("pos-seatpick-wrap");
    var seatpickTitle = document.getElementById("pos-seatpick-title");
    var svgSell = document.getElementById("pos-svg-sell");
    var cartEl = document.getElementById("pos-cart");
    var emailInput = document.getElementById("pos-email");
    var btnReserve = document.getElementById("pos-btn-reserve");
    var btnSell = document.getElementById("pos-btn-sell");
    var sellMsg = document.getElementById("pos-sell-msg");

    function loadSellItems() {
        sellItemsEl.textContent = "Loading…";
        if (state.event.hasSubevents && !subeventSelect.value) {
            sellItemsEl.textContent = "Choose a date above.";
            sellItems = [];
            sellSeats = [];
            return;
        }
        var seId = currentSubeventId();
        var seatsPromise = window.PretixSeatingRenderer
            ? apiAllPages(seId ? eventPath("/subevents/" + seId + "/seatmap/") : eventPath("/seatmap/"))
            : Promise.resolve({ok: true, data: {results: []}});

        seatsPromise.then(function (seatsRes) {
            var raw = (seatsRes.ok && seatsRes.data && seatsRes.data.results) || [];
            sellSeats = raw.map(toDrawSeat);
            var itemList = Object.keys(itemsById).map(function (id) { return itemsById[id]; })
                .filter(function (it) { return it.active; })
                .sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
            sellItems = itemList.map(function (it) {
                return {
                    id: it.id,
                    name: pickI18n(it.name),
                    price: priceFor(it.id, null, seId),
                    hasVariations: it.has_variations,
                    variations: (it.variations || []).filter(function (v) { return v.active; }).map(function (v) {
                        return {id: v.id, value: pickI18n(v.value), price: priceFor(it.id, v.id, seId)};
                    }),
                    needsSeat: sellSeats.some(function (s) { return s.product_id === it.id; }),
                };
            });
            // Auto-open seat picking for the first seated item instead of
            // requiring an extra "Pick seats" click first - there's nothing to
            // disambiguate for the common case of one seated item, and even
            // with several, showing the map right away (defaulting to the
            // first) is still one click less than before.
            if (activeSeatItem == null || !sellItems.some(function (it) { return it.id === activeSeatItem && it.needsSeat; })) {
                var firstSeated = sellItems.find(function (it) { return it.needsSeat; });
                activeSeatItem = firstSeated ? firstSeated.id : null;
            }
            renderSellItems();
        });
    }

    // pretix_seating's seatmap.js (drawSeats) expects short field names (guid, zone,
    // product_id) from its own internal endpoints; the public REST API - including
    // pretix_seating's own /seatmap/ addition to it - uses the API's normal naming
    // (seat_guid, zone_name, product). Adapt at the boundary rather than either
    // renaming the public API's fields (inconsistent with every other endpoint) or
    // reaching into seatmap.js's internals (a separate plugin's static asset).
    function toDrawSeat(s) {
        return {
            guid: s.seat_guid, x: s.x, y: s.y, zone: s.zone_name,
            row_label: s.row_label, seat_label: s.seat_label,
            status: s.status, product_id: s.product,
            category_color: s.category_color, radius: s.radius,
            order_code: s.order_code,
        };
    }

    function renderSellItems() {
        sellItemsEl.innerHTML = "";
        if (!sellItems.length) {
            sellItemsEl.textContent = "No items available.";
            return;
        }
        sellItems.forEach(function (item) {
            sellItemsEl.appendChild(renderSellItemRow(item));
        });
        renderSeatpick();
    }

    // Scoped to the currently-selected date - a cart can hold items for other
    // dates too (see subeventSelect's change handler), but the quantity
    // stepper shown next to each item must only reflect what's already queued
    // for the date currently on screen, or it would look wrong/confusing.
    function cartCountFor(itemId, variationId) {
        var seId = currentSubeventId();
        return cart.filter(function (c) {
            return c.itemId === itemId && c.variationId === (variationId || null) && !c.seatGuid && c.subeventId === seId;
        }).length;
    }

    function renderSellItemRow(item) {
        var row = document.createElement("div");
        row.className = "pos-item-row";

        if (item.needsSeat) {
            var label = document.createElement("div");
            label.className = "pos-item-title";
            label.textContent = item.name + " (" + fmtMoney(item.price) + ") — seated";
            row.appendChild(label);

            var seId = currentSubeventId();
            var seatCount = cart.filter(function (c) { return c.itemId === item.id && c.seatGuid && c.subeventId === seId; }).length;
            if (activeSeatItem === item.id) {
                // The map below is already showing this item's seats - nothing
                // to click here, just a status readout.
                var status = document.createElement("span");
                status.className = "pos-item-price";
                status.textContent = seatCount ? seatCount + " selected" : "Pick seats below";
                row.appendChild(status);
            } else {
                // Only reachable when more than one seated item exists - the map
                // auto-opens for the first one, this just lets staff switch which
                // item a click on the (shared) seatmap adds to.
                var btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = "Switch to this item" + (seatCount ? " (" + seatCount + ")" : "");
                btn.addEventListener("click", function () {
                    activeSeatItem = item.id;
                    renderSellItems();
                });
                row.appendChild(btn);
            }
            return row;
        }

        if (item.hasVariations) {
            var wrap = document.createElement("div");
            wrap.style.width = "100%";
            var title = document.createElement("div");
            title.className = "pos-item-title";
            title.textContent = item.name;
            wrap.appendChild(title);
            item.variations.forEach(function (v) {
                wrap.appendChild(qtyRow(v.value + " (" + fmtMoney(v.price) + ")", cartCountFor(item.id, v.id), function (delta) {
                    adjustQty(item.id, v.id, v.price, delta);
                }));
            });
            row.appendChild(wrap);
            return row;
        }

        var title2 = document.createElement("div");
        title2.className = "pos-item-title";
        title2.textContent = item.name + " (" + fmtMoney(item.price) + ")";
        row.appendChild(title2);
        row.appendChild(qtyControls(cartCountFor(item.id, null), function (delta) {
            adjustQty(item.id, null, item.price, delta);
        }));
        return row;
    }

    function qtyRow(label, count, onDelta) {
        var r = document.createElement("div");
        r.className = "pos-item-row";
        var l = document.createElement("span");
        l.textContent = label;
        r.appendChild(l);
        r.appendChild(qtyControls(count, onDelta));
        return r;
    }

    function qtyControls(count, onDelta) {
        var wrap = document.createElement("div");
        wrap.className = "pos-qty-controls";
        var minus = document.createElement("button");
        minus.type = "button";
        minus.textContent = "−";
        minus.disabled = count <= 0;
        minus.addEventListener("click", function () { onDelta(-1); });
        var span = document.createElement("span");
        span.textContent = String(count);
        var plus = document.createElement("button");
        plus.type = "button";
        plus.textContent = "+";
        plus.addEventListener("click", function () { onDelta(1); });
        wrap.appendChild(minus);
        wrap.appendChild(span);
        wrap.appendChild(plus);
        return wrap;
    }

    function adjustQty(itemId, variationId, price, delta) {
        var seId = currentSubeventId();
        if (delta > 0) {
            cart.push({itemId: itemId, variationId: variationId, seatGuid: null, price: price, subeventId: seId});
        } else {
            var idx = cart.findIndex(function (c) {
                return c.itemId === itemId && c.variationId === (variationId || null) && !c.seatGuid && c.subeventId === seId;
            });
            if (idx >= 0) cart.splice(idx, 1);
        }
        renderSellItems();
        renderCart();
    }

    function renderSeatpick() {
        if (activeSeatItem == null || !window.PretixSeatingRenderer || !itemsById[activeSeatItem]) {
            seatpickWrap.hidden = true;
            return;
        }
        seatpickWrap.hidden = false;
        seatpickTitle.textContent = "Seats for: " + pickI18n(itemsById[activeSeatItem].name);
        var seId = currentSubeventId();
        // Same ring-only, no-fill treatment as pretix_seating's eshop picker for
        // "in cart, not yet submitted" - a solid fixed color could collide with
        // some category's own color, same reason as everywhere else this pattern
        // is used. Matching by seatGuid alone is not enough once a cart can span
        // several dates (see subeventSelect's change handler): dates that share
        // the same underlying SeatingPlan reuse the exact same guid per seat
        // position, so a seat picked for one date would incorrectly show as
        // already-selected - and clicking it would remove *that other date's*
        // cart line instead of adding this one - on every other date using the
        // same plan. subeventId must match too.
        function isCartSeat(s) {
            return cart.some(function (c) { return c.seatGuid === s.guid && c.subeventId === seId; });
        }
        window.PretixSeatingRenderer.drawSeats(svgSell, sellSeats, function (s) {
            return isCartSeat(s) ? "transparent" : window.PretixSeatingRenderer.seatColor(s);
        }, function (s) {
            var idx = cart.findIndex(function (c) { return c.seatGuid === s.guid && c.subeventId === seId; });
            if (idx >= 0) {
                cart.splice(idx, 1);
            } else {
                if (s.status !== "free") return;
                if (s.product_id != null && s.product_id !== activeSeatItem) return;
                var label = [s.zone, s.row_label, s.seat_label].filter(Boolean).join(" / ") || s.guid;
                cart.push({
                    itemId: activeSeatItem, variationId: null, seatGuid: s.guid,
                    price: priceFor(activeSeatItem, null, seId), seatLabel: label, subeventId: seId,
                });
            }
            renderSellItems();
            renderCart();
        }, null, "pointer", function (s) {
            return isCartSeat(s) ? {color: window.PretixSeatingRenderer.SELECTED_COLOR, width: 3} : null;
        }, function (s) {
            return isCartSeat(s) ? window.PretixSeatingRenderer.SELECTED_COLOR : null;
        });
    }

    function renderCart() {
        cartEl.innerHTML = "";
        if (!cart.length) {
            cartEl.textContent = "Empty.";
            btnReserve.disabled = true;
            btnSell.disabled = true;
            return;
        }
        var ul = document.createElement("ul");
        ul.className = "pos-cart-list";
        var total = 0;
        cart.forEach(function (c, i) {
            var it = itemsById[c.itemId];
            var name = it ? pickI18n(it.name) : ("#" + c.itemId);
            if (c.variationId && it) {
                var v = (it.variations || []).find(function (vv) { return vv.id === c.variationId; });
                if (v) name += " (" + pickI18n(v.value) + ")";
            }
            if (c.seatGuid) name += " — " + (c.seatLabel || c.seatGuid);
            // A cart can now span several dates (see subeventSelect's change
            // handler) - each line needs to say which one it's for, since that's
            // no longer implied by "whichever date happens to be on screen".
            if (state.event.hasSubevents) name += " [" + subeventLabel(c.subeventId) + "]";
            if (c.price != null) total += parseFloat(c.price) || 0;
            var li = document.createElement("li");
            var span = document.createElement("span");
            span.textContent = name + (c.price != null ? " (" + c.price + ")" : "");
            var rm = document.createElement("button");
            rm.type = "button";
            rm.textContent = "Remove";
            rm.addEventListener("click", function () {
                cart.splice(i, 1);
                renderSellItems();
                renderCart();
            });
            li.appendChild(span);
            li.appendChild(rm);
            ul.appendChild(li);
        });
        cartEl.appendChild(ul);
        var totalDiv = document.createElement("div");
        totalDiv.className = "pos-cart-total";
        // Genuinely the final amount, not a hedge - priceFor() already accounts
        // for the only thing that could otherwise make this diverge from what
        // the server charges (per-date price overrides), and POS doesn't
        // support vouchers/memberships/bundles that could shift it further.
        totalDiv.textContent = "Total: " + total.toFixed(2);
        cartEl.appendChild(totalDiv);
        btnReserve.disabled = false;
        btnSell.disabled = false;
    }

    function buildPositions() {
        // Each line carries its own subeventId (set when added, see adjustQty/
        // renderSeatpick) - a cart can span several dates of this event at
        // once, so this must NOT fall back to "whichever date is on screen
        // right now" for every line.
        return cart.map(function (c) {
            var p = {item: c.itemId};
            if (c.variationId) p.variation = c.variationId;
            if (c.subeventId) p.subevent = c.subeventId;
            if (c.seatGuid) p.seat = c.seatGuid;
            return p;
        });
    }

    function submitOrder(mode) {
        var positions = buildPositions();
        if (!positions.length) return;
        btnReserve.disabled = true;
        btnSell.disabled = true;
        setMsg(sellMsg, "Submitting…", null);
        var body = {status: mode === "sell" ? "p" : "n", positions: positions};
        if (SALES_CHANNEL) body.sales_channel = SALES_CHANNEL;
        var email = emailInput.value.trim();
        if (email) body.email = email;
        if (mode === "sell") body.payment_provider = "boxoffice";
        api(eventPath("/orders/"), {method: "POST", body: JSON.stringify(body)}).then(function (res) {
            if (!res.ok) {
                setMsg(sellMsg, describeError(res.data), "error");
                renderCart();
                return;
            }
            setMsg(sellMsg, (mode === "sell" ? "Sold" : "Reserved") + " — order " + res.data.code + ".", "success");
            cart = [];
            activeSeatItem = null;
            emailInput.value = "";
            renderCart();
            loadSellItems();
        });
    }

    btnReserve.addEventListener("click", function () { submitOrder("reserve"); });
    btnSell.addEventListener("click", function () { submitOrder("sell"); });

    // --------------------------------------------------------------- find tab

    var searchInput = document.getElementById("pos-search");
    var searchBtn = document.getElementById("pos-search-btn");
    var searchResultsEl = document.getElementById("pos-search-results");
    var orderDetailEl = document.getElementById("pos-order-detail");
    var orderSeatmapWrapEl = document.getElementById("pos-order-seatmap-wrap");

    function doSearch() {
        var q = searchInput.value.trim();
        if (!q) {
            loadDefaultOrderList();
            return;
        }
        searchResultsEl.textContent = "Searching…";
        api(eventPath("/orders/?search=" + encodeURIComponent(q) + "&ordering=-datetime")).then(function (res) {
            if (!res.ok) {
                searchResultsEl.textContent = describeError(res.data);
                return;
            }
            renderSearchResults((res.data && res.data.results) || []);
        });
    }

    searchBtn.addEventListener("click", doSearch);
    searchInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    });

    // A position only "needs a seat" if its date actually has a seating plan
    // at all - a date with none can never have any seated position, so those
    // positions must not count against "seated" or every order for a plain,
    // unseated date would wrongly show as "still needs seats" (white)
    // instead of just not applying at all. This is still an approximation
    // one level down: an item without its own SeatCategoryMapping on an
    // otherwise-seated date isn't detected (there's no direct API filter for
    // "this position's item actually requires a seat", and pulling in a full
    // seatmap fetch per date just to check would be expensive for a browsing
    // list) - acceptable since almost every sold item in this deployment is
    // seated wherever a plan exists at all.
    function dateHasSeatingPlan(subeventId) {
        return state.event.hasSubevents ? !!subeventSeatingPlans[subeventId] : !!state.event.seatingPlan;
    }

    // "Seated" means "nothing left for staff to seat" - true both when every
    // seatable position already has a seat, and (vacuously) when none of the
    // order's positions are on a date with a seating plan in the first place.
    function orderIsSeated(o) {
        var positions = (o.positions || []).filter(function (p) {
            return !p.canceled && dateHasSeatingPlan(p.subevent);
        });
        return positions.every(function (p) { return !!p.seat; });
    }

    function orderSortKey(o) {
        var needsSeat = !orderIsSeated(o);
        var unpaid = o.status !== "p";
        return (needsSeat ? 0 : 2) + (unpaid ? 0 : 1);
    }

    // Shown by default on the "Find order" tab (before any search) so staff
    // can browse rather than always having to know a code/name/e-mail
    // upfront - sorted with whatever most likely still needs attention first.
    function loadDefaultOrderList() {
        searchResultsEl.textContent = "Loading…";
        api(eventPath("/orders/?ordering=-datetime")).then(function (res) {
            if (!res.ok) {
                searchResultsEl.textContent = describeError(res.data);
                return;
            }
            var orders = ((res.data && res.data.results) || []).slice();
            orders.sort(function (a, b) { return orderSortKey(a) - orderSortKey(b); });
            renderSearchResults(orders);
        });
    }

    function renderSearchResults(orders) {
        searchResultsEl.innerHTML = "";
        if (!orders.length) {
            searchResultsEl.textContent = "No matching orders.";
            return;
        }
        orders.forEach(function (o) {
            var div = document.createElement("div");
            // Seated+paid (green) / seated+unpaid (yellow) / not yet seated
            // (plain/white) - staff's main question at a glance is "does this
            // still need seats", with payment status as a secondary cue only
            // once seating is already done.
            var seated = orderIsSeated(o);
            div.className = "pos-search-result" +
                (seated ? (o.status === "p" ? " pos-order-seated-paid" : " pos-order-seated-unpaid") : "");
            div.innerHTML = "<span class=\"pos-order-code\"></span>";
            div.querySelector(".pos-order-code").textContent = o.code;
            var pending = pendingSum(o);
            div.appendChild(document.createTextNode(
                " — " + (o.email || "no e-mail") + " — " + o.status + " — total " + o.total +
                (parseFloat(pending) > 0 ? ", pending " + pending : "")
            ));
            div.addEventListener("click", function () { loadOrderDetail(o.code); });
            searchResultsEl.appendChild(div);
        });
    }

    function loadOrderDetail(code) {
        api(eventPath("/orders/" + encodeURIComponent(code) + "/")).then(function (res) {
            if (!res.ok) {
                orderDetailEl.hidden = false;
                orderDetailEl.textContent = describeError(res.data);
                return;
            }
            currentOrder = res.data;
            placementPool = {};
            renderOrderDetail();
        });
    }

    // The public API's OrderSerializer has no pending_sum field (unlike the
    // internal Order model, which computes it server-side) - derive it from
    // the confirmed payments actually present in the order's own response.
    function pendingSum(order) {
        var paid = (order.payments || [])
            .filter(function (p) { return p.state === "confirmed"; })
            .reduce(function (sum, p) { return sum + parseFloat(p.amount); }, 0);
        return (parseFloat(order.total) - paid).toFixed(2);
    }

    function positionLabel(p) {
        var it = itemsById[p.item];
        var name = it ? pickI18n(it.name) : ("Item #" + p.item);
        if (p.variation && it) {
            var v = (it.variations || []).find(function (vv) { return vv.id === p.variation; });
            if (v) name += " (" + pickI18n(v.value) + ")";
        }
        return name;
    }

    // (Re)builds the position checkbox/label/seat-badge rows into container from
    // currentOrder.positions - factored out so a seat placement/move can refresh
    // just this list in place (see applyPositionSeat()) instead of the whole
    // order detail having to be refetched and rebuilt from scratch.
    function renderPositionList(container) {
        container.innerHTML = "";
        var seId = currentSubeventId();
        var positions = (currentOrder.positions || []).filter(function (pos) { return !pos.canceled; });
        positions.forEach(function (pos) {
            // An order can span several dates (see subeventSelect's change
            // handler) but the seatmap below only ever shows one date at a
            // time - a position for any *other* date is shown for context
            // (so staff can see the whole order) but can't be checked/placed
            // from here, since there's no seatmap on screen for it right now.
            var otherDate = !subeventsMatch(pos.subevent, seId);

            var row = document.createElement("div");
            row.className = "pos-position-row" + (otherDate ? " pos-position-row-other-date" : "");

            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.positionId = pos.id;
            cb.disabled = otherDate;
            cb.checked = !otherDate && !pos.seat;
            row.appendChild(cb);

            var label = document.createElement("span");
            label.textContent = positionLabel(pos);
            row.appendChild(label);

            if (otherDate) {
                var dateBadge = document.createElement("span");
                dateBadge.className = "pos-seat-badge pos-date-badge";
                dateBadge.textContent = subeventLabel(pos.subevent);
                row.appendChild(dateBadge);
            }

            var badge = document.createElement("span");
            if (pos.seat) {
                badge.className = "pos-seat-badge";
                badge.textContent = pos.seat.name || pos.seat.seat_guid;
            } else {
                badge.className = "pos-seat-badge pos-seat-missing";
                badge.textContent = "no seat";
            }
            row.appendChild(badge);

            container.appendChild(row);
        });
    }

    // Applies a successful seat PATCH's result to local state instead of a full
    // loadOrderDetail() reload - reloading (refetch + tear down and rebuild the
    // whole seatmap and position list) after every single placement during a
    // multi-seat editing session was "hodne nepohodlny" (very inconvenient) for
    // what's really just one seat's status changing. patchedSeat is the updated
    // position's own `seat` field from the PATCH response (has seat_guid/name/etc,
    // same shape as everywhere else a seat is represented).
    function applyPositionSeat(positionId, patchedSeat) {
        var pos = (currentOrder.positions || []).find(function (p) { return p.id === positionId; });
        var oldGuid = pos && pos.seat && pos.seat.seat_guid;
        if (pos) pos.seat = patchedSeat || null;
        if (oldGuid && oldGuid !== (patchedSeat && patchedSeat.seat_guid)) {
            var oldSeat = orderSeats.find(function (s) { return s.guid === oldGuid; });
            if (oldSeat) oldSeat.status = "free";
        }
        if (patchedSeat) {
            var newSeat = orderSeats.find(function (s) { return s.guid === patchedSeat.seat_guid; });
            if (newSeat) newSeat.status = "taken";
        }
    }

    function renderOrderDetail() {
        orderDetailEl.hidden = false;
        orderDetailEl.innerHTML = "";
        orderSeatmapWrapEl.innerHTML = "";
        var order = currentOrder;

        var h = document.createElement("h3");
        h.textContent = order.code + " — " + order.status;
        orderDetailEl.appendChild(h);

        var pending = pendingSum(order);
        var p = document.createElement("p");
        p.textContent = "Total: " + order.total + (parseFloat(pending) > 0 ? " — pending: " + pending : " — fully paid");
        orderDetailEl.appendChild(p);

        var list = document.createElement("div");
        renderPositionList(list);
        orderDetailEl.appendChild(list);

        if (order.status === "n") {
            var payBtn = document.createElement("button");
            payBtn.type = "button";
            payBtn.className = "pos-btn-primary";
            payBtn.textContent = "Take payment (cash)";
            payBtn.addEventListener("click", function () { payOrder(order); });
            orderDetailEl.appendChild(payBtn);
        }

        // The seatmap always follows whichever date is selected in the bar at
        // the top of the screen (shared with Sell/Reserve) - NOT "whichever
        // date(s) this order happens to have positions for". An order that
        // spans several dates just shows this date's positions as checkable/
        // placeable and every other date's positions as disabled context rows
        // in the list above (see renderPositionList()) - switching the date
        // above re-renders this whole thing for the newly selected date (see
        // subeventSelect's change handler).
        var seId = currentSubeventId();
        var seatMapPromise;
        if (!window.PretixSeatingRenderer) {
            seatMapPromise = Promise.resolve({noDate: false, results: []});
        } else if (state.event.hasSubevents && !seId) {
            seatMapPromise = Promise.resolve({noDate: true, results: []});
        } else {
            seatMapPromise = apiAllPages(seId ? eventPath("/subevents/" + seId + "/seatmap/") : eventPath("/seatmap/"))
                .then(function (res) {
                    var raw = (res.ok && res.data && res.data.results) || [];
                    return {noDate: false, results: raw.map(toDrawSeat)};
                });
        }

        var placeMsg = document.createElement("div");
        placeMsg.id = "pos-place-msg";
        placeMsg.className = "pos-msg";

        seatMapPromise.then(function (info) {
            orderSeats = info.results;
            orderSeatmapWrapEl.innerHTML = "";
            if (info.noDate) {
                orderSeatmapWrapEl.textContent = "Choose a date above to place seats for that date.";
                return;
            }
            if (!orderSeats.length) {
                orderSeatmapWrapEl.textContent = "This date has no seated positions.";
                return;
            }

            var hint = document.createElement("p");
            hint.className = "pos-hint";
            hint.textContent = "This order's own seats (for the date selected above) are shown in a muted highlight color. Click a free seat (or drag a rectangle over several) to select up to as many as there are checked positions - shown with a ring only until you click \"Place selected\"; click empty space to clear that selection. Click one of this order's own seats to remove it. Drag one of this order's own seats onto a free seat to move it (shown as a translucent preview while dragging); hold Ctrl while dragging to move its whole block of seats together. Hover any occupied seat to see which order holds it, or double-click it to jump straight to that order. Positions for other dates are listed above, greyed out - switch the date to work with them.";
            orderSeatmapWrapEl.appendChild(hint);

            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = "pos-svg-order";
            svg.setAttribute("class", "pos-seatmap");
            orderSeatmapWrapEl.appendChild(svg);

            var placeBtn = document.createElement("button");
            placeBtn.type = "button";
            placeBtn.textContent = "Place selected seats on checked positions";
            placeBtn.style.marginTop = "10px";
            orderSeatmapWrapEl.appendChild(placeBtn);
            orderSeatmapWrapEl.appendChild(placeMsg);

            initOrderSeatMap(svg, placeBtn, placeMsg, list, seId);
        });
    }

    function payOrder(order) {
        var msg = document.createElement("div");
        msg.className = "pos-msg";
        orderDetailEl.appendChild(msg);
        setMsg(msg, "Charging…", null);
        api(eventPath("/orders/" + order.code + "/payments/"), {
            method: "POST",
            body: JSON.stringify({provider: "boxoffice", amount: pendingSum(order), state: "created"}),
        }).then(function (res) {
            if (!res.ok) {
                setMsg(msg, describeError(res.data), "error");
                return null;
            }
            return api(eventPath("/orders/" + order.code + "/payments/" + res.data.local_id + "/confirm/"), {method: "POST"});
        }).then(function (res2) {
            if (!res2) return;
            if (!res2.ok) {
                setMsg(msg, describeError(res2.data), "error");
                return;
            }
            loadOrderDetail(order.code);
        });
    }

    // ---- rubber-band multi-select + drag-to-move on the order's seat map ----

    var seatMapMouseUpHandler = null;

    function initOrderSeatMap(svg, placeBtn, msgEl, positionListEl, subeventId) {
        var seats = orderSeats;
        var drag = null;

        if (seatMapMouseUpHandler) window.removeEventListener("mouseup", seatMapMouseUpHandler);

        // Scoped to *this date* (subeventId, whatever renderOrderDetail() is
        // currently showing) - not just "any position with a matching seat
        // guid". An order can span several dates, and dates sharing a seating
        // plan reuse the exact same seat guids (see subeventsMatch()'s own
        // comment and the isCartSeat()/isOwnSeat() precedent elsewhere in
        // this file) - without this, a position for a *different* date could
        // be shown/dragged/unassigned as if it were on today's map just
        // because some other date's seat happens to share this map's guid.
        function ownPositionOfSeat(seat) {
            return (currentOrder.positions || []).find(function (p) {
                return !p.canceled && p.seat && p.seat.seat_guid === seat.guid && subeventsMatch(p.subevent, subeventId);
            }) || null;
        }

        // Every seat currently assigned to this order *for this date* - used
        // both for the Ctrl+drag block-move preview (see updateGhosts()) and
        // to know which seats moveBlock() itself needs to move.
        function ownSeats() {
            return (currentOrder.positions || [])
                .filter(function (p) { return !p.canceled && p.seat && subeventsMatch(p.subevent, subeventId); })
                .map(function (p) { return seats.find(function (s) { return s.guid === p.seat.seat_guid; }); })
                .filter(Boolean);
        }

        // Two distinct "yours" states, same split as the eshop picker's own
        // isSelected/mine (see initPick in seatmap.js): a pool seat is only
        // *staged* - it still needs "Place selected" clicked to actually take
        // effect - so it keeps the ring-only, no-fill "chosen but not committed"
        // treatment. A seat already assigned to this order is already real, so
        // it gets pretix_seating's MINE_COLOR (solid, muted fill+ring) instead -
        // otherwise the two looked identical and staff couldn't tell "about to
        // place" from "already placed" without checking the position list.
        function isOwnSeat(s) {
            return !!ownPositionOfSeat(s);
        }

        function colorFn(s) {
            if (placementPool[s.guid]) return "transparent";
            if (isOwnSeat(s)) return window.PretixSeatingRenderer.MINE_COLOR;
            return window.PretixSeatingRenderer.seatColor(s);
        }

        function strokeFn(s) {
            if (placementPool[s.guid]) return {color: window.PretixSeatingRenderer.SELECTED_COLOR, width: 3};
            if (isOwnSeat(s)) return {color: window.PretixSeatingRenderer.MINE_COLOR, width: 3};
            return null;
        }

        function labelColorFn(s) {
            // Only the transparent-fill "pool" state needs a label color override
            // (white-on-transparent is invisible) - MINE_COLOR's fill is solid, so
            // the default white seat-number label already reads fine on it.
            return placementPool[s.guid] ? window.PretixSeatingRenderer.SELECTED_COLOR : null;
        }

        // Lets staff see which order a seat they don't recognize belongs to
        // without leaving the map - order_code comes from the seatmap API
        // (added specifically for this), present whenever a non-canceled
        // pending/paid order holds the seat (so also for this order's own
        // seats, which is harmless/informative rather than confusing).
        function titleFn(s) {
            var base = [s.zone, s.row_label, s.seat_label].filter(Boolean).join(" / ") +
                " (" + s.guid + ") — " + s.status;
            return s.order_code ? (base + " — Order " + s.order_code) : base;
        }

        function render() {
            window.PretixSeatingRenderer.drawSeats(svg, seats, colorFn, null, null, "pointer", strokeFn, labelColorFn, titleFn);
        }

        // The number of positions actually checked to receive a seat - the hard
        // cap on how many free seats can be gathered into placementPool at once,
        // so staff can no longer select more seats than the order actually needs
        // (previously uncapped, silently truncated only once "Place selected"
        // was clicked, which was confusing).
        function checkedCount() {
            return positionListEl.querySelectorAll("input[type=checkbox]:checked").length;
        }

        function renderPlaceBtn() {
            var n = Object.keys(placementPool).length;
            var checked = Array.prototype.slice.call(positionListEl.querySelectorAll("input[type=checkbox]:checked"));
            placeBtn.textContent = "Place " + n + " selected seat(s) on " + checked.length + " checked position(s)";
            placeBtn.disabled = n === 0 || checked.length === 0;
        }
        positionListEl.addEventListener("change", renderPlaceBtn);

        function svgPoint(evt) {
            var pt = svg.createSVGPoint();
            pt.x = evt.clientX;
            pt.y = evt.clientY;
            var ctm = svg.getScreenCTM();
            if (!ctm) return {x: 0, y: 0};
            var p = pt.matrixTransform(ctm.inverse());
            return {x: p.x, y: p.y};
        }

        function seatAtEvent(evt) {
            var el = evt.target.closest && evt.target.closest("[data-guid]");
            return el ? seats.find(function (s) { return s.guid === el.getAttribute("data-guid"); }) : null;
        }

        function ensureRubberRect() {
            if (drag.rectEl) return drag.rectEl;
            var r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            r.setAttribute("class", "pos-rubber-band");
            svg.appendChild(r);
            drag.rectEl = r;
            return r;
        }

        function updateRubberRect(pt) {
            var r = ensureRubberRect();
            var x0 = Math.min(drag.startPt.x, pt.x), x1 = Math.max(drag.startPt.x, pt.x);
            var y0 = Math.min(drag.startPt.y, pt.y), y1 = Math.max(drag.startPt.y, pt.y);
            r.setAttribute("x", x0);
            r.setAttribute("y", y0);
            r.setAttribute("width", x1 - x0);
            r.setAttribute("height", y1 - y0);
        }

        // Translucent preview of where a seat-move drag would land, so staff
        // don't have to drop first to see the result - just the one dragged
        // seat normally, or the whole block (see ownSeats()) while Ctrl is
        // held, matching whichever action mouseup would actually take.
        // Cleaned up at mouseup by removing drag.ghostEls directly (drag is
        // already nulled out to `d` by then, see seatMapMouseUpHandler).
        function updateGhosts(pt, ctrlHeld) {
            var dx = pt.x - drag.startPt.x, dy = pt.y - drag.startPt.y;
            var sourceSeats = ctrlHeld ? ownSeats() : [drag.clickSeat];
            while (drag.ghostEls.length < sourceSeats.length) {
                var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                c.setAttribute("class", "pos-drag-ghost");
                c.setAttribute("fill", window.PretixSeatingRenderer.MINE_COLOR);
                svg.appendChild(c);
                drag.ghostEls.push(c);
            }
            while (drag.ghostEls.length > sourceSeats.length) {
                drag.ghostEls.pop().remove();
            }
            sourceSeats.forEach(function (s, i) {
                drag.ghostEls[i].setAttribute("cx", s.x + dx);
                drag.ghostEls[i].setAttribute("cy", s.y + dy);
                drag.ghostEls[i].setAttribute("r", s.radius || 10);
            });
        }

        svg.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            var seat = seatAtEvent(e);
            drag = {
                startPt: svgPoint(e),
                moved: false,
                clickSeat: seat,
                movePosition: seat ? ownPositionOfSeat(seat) : null,
                rectEl: null,
                ghostEls: [],
            };
            e.preventDefault();
        });

        svg.addEventListener("mousemove", function (e) {
            if (!drag) return;
            var pt = svgPoint(e);
            var dx = pt.x - drag.startPt.x, dy = pt.y - drag.startPt.y;
            if (!drag.moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            drag.moved = true;
            if (drag.movePosition) {
                updateGhosts(pt, e.ctrlKey);
            } else {
                updateRubberRect(pt);
            }
        });

        // Double-clicking a seat that belongs to some *other* order jumps
        // straight to that order, instead of making staff go back to search
        // and type/remember its code - the two single clicks that make up the
        // double-click already no-op harmlessly for a seat like this (neither
        // the free-seat pool toggle nor the own-seat unassign branch applies).
        // Deliberately excludes this order's own seats - those already have a
        // real, different action on a single click (unassign), so a double-
        // click there just means "unassign, then reload the same order",
        // which would be a confusing surprise rather than a shortcut.
        svg.addEventListener("dblclick", function (e) {
            var seat = seatAtEvent(e);
            if (!seat || seat.status === "free" || !seat.order_code) return;
            if (ownPositionOfSeat(seat)) return;
            loadOrderDetail(seat.order_code);
        });

        seatMapMouseUpHandler = function (e) {
            if (!drag || !svg.isConnected) { drag = null; return; }
            var d = drag;
            drag = null;

            if (!d.moved) {
                // A plain click (no drag) on one of this order's own already-
                // assigned seats removes it from that position - dragging it
                // instead moves it (see the d.movePosition branch below).
                if (d.movePosition) {
                    unassignSeat(d.movePosition);
                    return;
                }
                if (d.clickSeat && d.clickSeat.status === "free") {
                    if (placementPool[d.clickSeat.guid]) {
                        delete placementPool[d.clickSeat.guid];
                    } else if (Object.keys(placementPool).length < checkedCount()) {
                        placementPool[d.clickSeat.guid] = d.clickSeat;
                    }
                    render();
                    renderPlaceBtn();
                    return;
                }
                // A plain click that didn't land on any seat at all - clears
                // whatever's pending in the placement pool, so staff have an
                // easy way out of a selection without having to click every
                // pooled seat again individually. A *drag* starting from empty
                // space is the rubber-band multi-select (the d.moved branch
                // below) and is unaffected by this - only a non-dragging click
                // clears.
                if (!d.clickSeat && Object.keys(placementPool).length) {
                    placementPool = {};
                    render();
                    renderPlaceBtn();
                }
                return;
            }

            if (d.rectEl) d.rectEl.remove();
            d.ghostEls.forEach(function (el) { el.remove(); });

            if (d.movePosition) {
                var target = seatAtEvent(e);
                if (target && target.status === "free") {
                    if (e.ctrlKey) {
                        moveBlock(d.clickSeat, target);
                    } else {
                        movePositionSeat(d.movePosition, target.guid);
                    }
                }
                return;
            }

            var pt = svgPoint(e);
            var rect = {
                x0: Math.min(d.startPt.x, pt.x), x1: Math.max(d.startPt.x, pt.x),
                y0: Math.min(d.startPt.y, pt.y), y1: Math.max(d.startPt.y, pt.y),
            };
            var cap = checkedCount();
            seats.forEach(function (s) {
                if (s.status !== "free" || s.x == null || s.y == null) return;
                if (!(s.x >= rect.x0 && s.x <= rect.x1 && s.y >= rect.y0 && s.y <= rect.y1)) return;
                if (placementPool[s.guid]) return;
                if (Object.keys(placementPool).length >= cap) return;
                placementPool[s.guid] = s;
            });
            render();
            renderPlaceBtn();
        };
        window.addEventListener("mouseup", seatMapMouseUpHandler);

        placeBtn.addEventListener("click", function () {
            var poolSeats = Object.keys(placementPool).map(function (g) { return placementPool[g]; });
            var positionIds = Array.prototype.slice.call(positionListEl.querySelectorAll("input[type=checkbox]:checked"))
                .map(function (cb) { return parseInt(cb.dataset.positionId, 10); });
            var n = Math.min(poolSeats.length, positionIds.length);
            if (!n) return;
            poolSeats.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
            placeBtn.disabled = true;
            setMsg(msgEl, "Placing seats one by one - this is not a single atomic action, a failure partway through leaves earlier placements in place…", null);

            var i = 0, ok = 0, failed = [];
            function next() {
                if (i >= n) {
                    setMsg(msgEl, "Placed " + ok + "/" + n + " seat(s)." + (failed.length ? " Failed: " + failed.join("; ") : ""), failed.length ? "error" : "success");
                    placementPool = {};
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    return;
                }
                var seat = poolSeats[i];
                var posId = positionIds[i];
                i += 1;
                api(eventPath("/orderpositions/" + posId + "/"), {
                    method: "PATCH",
                    body: JSON.stringify({seat: seat.guid}),
                }).then(function (res) {
                    if (res.ok) {
                        ok += 1;
                        applyPositionSeat(posId, res.data.seat);
                    } else {
                        failed.push("#" + posId + ": " + describeError(res.data));
                    }
                    next();
                });
            }
            next();
        });

        // Nested (rather than a standalone top-level function) so it can update
        // this map in place after a move instead of the whole order detail
        // having to be refetched and rebuilt - see applyPositionSeat().
        function movePositionSeat(position, seatGuid) {
            setMsg(msgEl, "Moving seat…", null);
            api(eventPath("/orderpositions/" + position.id + "/"), {
                method: "PATCH",
                body: JSON.stringify({seat: seatGuid}),
            }).then(function (res) {
                if (!res.ok) {
                    setMsg(msgEl, describeError(res.data), "error");
                    return;
                }
                setMsg(msgEl, "Seat moved.", "success");
                applyPositionSeat(position.id, res.data.seat);
                renderPositionList(positionListEl);
                render();
            });
        }

        // A plain click on one of this order's own seats removes it - the
        // OrderPositionChangeSerializer's `seat` field accepts null explicitly
        // to unassign (confirmed in orderchange.py: it goes through
        // OrderChangeManager.change_seat(position, None), same as a real move).
        function unassignSeat(position) {
            setMsg(msgEl, "Removing seat…", null);
            api(eventPath("/orderpositions/" + position.id + "/"), {
                method: "PATCH",
                body: JSON.stringify({seat: null}),
            }).then(function (res) {
                if (!res.ok) {
                    setMsg(msgEl, describeError(res.data), "error");
                    return;
                }
                setMsg(msgEl, "Seat removed.", "success");
                applyPositionSeat(position.id, null);
                renderPositionList(positionListEl);
                render();
                renderPlaceBtn();
            });
        }

        // Ctrl+drag moves this order's whole block of assigned seats together,
        // by the same x/y offset as the one seat that was actually dragged.
        // Every other seat in the block must resolve to a seat at the offset
        // position that's either free or itself part of the block (about to be
        // vacated by this same move) - otherwise the whole move is refused
        // rather than silently moving only some of the seats.
        function moveBlock(draggedSeat, targetSeat) {
            var dx = targetSeat.x - draggedSeat.x, dy = targetSeat.y - draggedSeat.y;
            if (!dx && !dy) return;

            var blockPositions = (currentOrder.positions || []).filter(function (p) {
                return !p.canceled && p.seat && subeventsMatch(p.subevent, subeventId);
            });
            var blockGuids = {};
            blockPositions.forEach(function (p) { blockGuids[p.seat.seat_guid] = true; });

            var TOL = 0.5;
            var moves = [];
            var targetGuidsUsed = {};
            for (var i = 0; i < blockPositions.length; i++) {
                var pos = blockPositions[i];
                var seat = seats.find(function (s) { return s.guid === pos.seat.seat_guid; });
                if (!seat) {
                    setMsg(msgEl, "Cannot move block: a seat's location is unknown.", "error");
                    return;
                }
                var wantX = seat.x + dx, wantY = seat.y + dy;
                var dest = seats.find(function (s) {
                    return Math.abs(s.x - wantX) < TOL && Math.abs(s.y - wantY) < TOL;
                });
                if (!dest) {
                    setMsg(msgEl, "Cannot move block: target position is outside the seating plan.", "error");
                    return;
                }
                if (dest.status !== "free" && !blockGuids[dest.guid]) {
                    setMsg(msgEl, "Cannot move block: seat at the target position is already taken.", "error");
                    return;
                }
                if (targetGuidsUsed[dest.guid]) {
                    setMsg(msgEl, "Cannot move block: target seats overlap.", "error");
                    return;
                }
                targetGuidsUsed[dest.guid] = true;
                moves.push({position: pos, targetGuid: dest.guid});
            }

            setMsg(msgEl, "Moving " + moves.length + " seat(s) - this is not a single atomic action, a failure partway through leaves it partially done…", null);

            // Clear every seat in the block first, then assign the new ones -
            // avoids "seat already taken" conflicts when the block shifts onto
            // its own previously-occupied seats, regardless of move order.
            var idx = 0;
            function clearNext() {
                if (idx >= moves.length) {
                    idx = 0;
                    assignNext();
                    return;
                }
                var m = moves[idx];
                idx += 1;
                api(eventPath("/orderpositions/" + m.position.id + "/"), {
                    method: "PATCH",
                    body: JSON.stringify({seat: null}),
                }).then(function (res) {
                    if (res.ok) applyPositionSeat(m.position.id, null);
                    clearNext();
                });
            }
            function assignNext() {
                if (idx >= moves.length) {
                    setMsg(msgEl, "Block moved.", "success");
                    renderPositionList(positionListEl);
                    render();
                    return;
                }
                var m = moves[idx];
                idx += 1;
                api(eventPath("/orderpositions/" + m.position.id + "/"), {
                    method: "PATCH",
                    body: JSON.stringify({seat: m.targetGuid}),
                }).then(function (res) {
                    if (res.ok) {
                        applyPositionSeat(m.position.id, res.data.seat);
                    } else {
                        setMsg(msgEl, "Some seats failed to move: " + describeError(res.data), "error");
                    }
                    assignNext();
                });
            }
            clearNext();
        }

        render();
        renderPlaceBtn();
    }

    // -------------------------------------------------------------------- boot

    function boot() {
        if (!state.token) {
            showScreen("pair");
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = true;
            headerInfo.textContent = "";
            return;
        }
        if (!state.event) {
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = false;
            headerInfo.textContent = state.deviceName || "";
            loadEvents();
            return;
        }
        loadMainScreen();
    }

    boot();
})();
