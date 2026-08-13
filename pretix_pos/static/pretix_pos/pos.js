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
    var subeventDisabled = {}; // subeventId -> {items: {itemId: true}, variations: {variationId: true}}
    var subeventsList = []; // raw API results, ordered - used by the Quick reservation tab
    var subeventSeatedItems = {}; // subeventId -> {itemId: true} - items with a seat category mapping on that date

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

    // Running per-terminal totals of what's been sold/settled, broken down by
    // how it was paid - "how much cash/QR/card should I be holding right now".
    // Deliberately its own storage key, separate from the device pairing
    // state above: it's a property of this physical terminal's cash box, not
    // of which Device record happens to be paired to it, and survives a
    // reload without survivng a deliberate "Reset to zero" at shift start.
    // Amounts are tracked as integer cents to avoid floating-point drift
    // across many additions - the API only ever gives us decimal strings.
    var TILL_KEY = "pretix_pos_till:" + ORGANIZER;
    var PAYMENT_METHODS = [
        {value: "cash", label: gettext("Cash")},
        {value: "qr", label: gettext("QR transfer")},
        {value: "card", label: gettext("Card")},
    ];
    var till = loadTill();

    function loadTill() {
        try {
            var t = JSON.parse(localStorage.getItem(TILL_KEY));
            if (t && typeof t === "object") return t;
        } catch (e) {
            // fall through to a fresh till below
        }
        return {cash: 0, qr: 0, card: 0};
    }

    function saveTill() {
        localStorage.setItem(TILL_KEY, JSON.stringify(till));
    }

    function centsOf(str) {
        var n = Math.round(parseFloat(str) * 100);
        return isNaN(n) ? 0 : n;
    }

    function formatCents(c) {
        return (c / 100).toFixed(2);
    }

    function addToTill(method, amountStr) {
        if (!(method in till)) method = "cash";
        till[method] = (till[method] || 0) + centsOf(amountStr);
        saveTill();
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

    // Same request/response shape as api(), but authenticates with an
    // explicitly-given token instead of state.token - used only by the
    // recovery-code restore flow (pairForm's own submit handler) to validate
    // a candidate token *before* committing it to state, without disturbing
    // whatever (if anything) is currently saved there.
    function apiAs(path, token, opts) {
        opts = opts || {};
        var headers = Object.assign({"Content-Type": "application/json", Authorization: "Device " + token}, opts.headers || {});
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
        return flattenError(data) || gettext("Unknown error.");
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
        recovery: document.getElementById("pos-screen-recovery"),
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
    var btnTill = document.getElementById("pos-btn-till");
    var tillPanel = document.getElementById("pos-till-panel");
    var tillTotalsEl = document.getElementById("pos-till-totals");
    var tillResetBtn = document.getElementById("pos-till-reset");
    var tillCloseBtn = document.getElementById("pos-till-close");

    btnUnpair.addEventListener("click", function () {
        if (!window.confirm(gettext("Unpair this terminal? You will need a new initialization token to reconnect."))) return;
        clearState();
        boot();
    });

    btnChangeEvent.addEventListener("click", function () {
        delete state.event;
        saveState();
        boot();
    });

    function renderTillPanel() {
        tillTotalsEl.innerHTML = "";
        var total = 0;
        PAYMENT_METHODS.forEach(function (m) {
            var cents = till[m.value] || 0;
            total += cents;
            var row = document.createElement("p");
            row.textContent = m.label + ": " + formatCents(cents);
            tillTotalsEl.appendChild(row);
        });
        var totalRow = document.createElement("p");
        var strong = document.createElement("strong");
        strong.textContent = interpolate(gettext("Total: %(amount)s"), {amount: formatCents(total)}, true);
        totalRow.appendChild(strong);
        tillTotalsEl.appendChild(totalRow);
    }

    btnTill.addEventListener("click", function () {
        renderTillPanel();
        tillPanel.hidden = !tillPanel.hidden;
    });

    tillResetBtn.addEventListener("click", function () {
        till = {cash: 0, qr: 0, card: 0};
        saveTill();
        renderTillPanel();
    });

    tillCloseBtn.addEventListener("click", function () {
        tillPanel.hidden = true;
    });

    // ---------------------------------------------------------------- pairing

    var pairForm = document.getElementById("pos-pair-form");
    var pairTokenInput = document.getElementById("pos-pair-token");
    var pairMsg = document.getElementById("pos-pair-msg");
    var restoreForm = document.getElementById("pos-restore-form");
    var restoreCodeInput = document.getElementById("pos-restore-code");
    var restoreMsg = document.getElementById("pos-restore-msg");
    var recoveryCodeEl = document.getElementById("pos-recovery-code");
    var recoveryCopyBtn = document.getElementById("pos-recovery-copy");
    var recoveryContinueBtn = document.getElementById("pos-recovery-continue");

    // The device's api_token is a permanent bearer credential, but pretix
    // core never shows it again anywhere once pairing succeeds (confirmed by
    // reading the control panel's device views/templates) - if this
    // browser's localStorage is ever cleared, there is otherwise no way for
    // *staff* to get back in without an administrator resetting the device
    // server-side. So the token itself doubles as a self-service recovery
    // code: shown once right after pairing, with an explicit "write this
    // down somewhere safe" step staff must click through before the app
    // proceeds, and restorable later via the plain form below with no admin
    // involved - see restoreForm's handler.
    function showRecoveryCode(token) {
        recoveryCodeEl.textContent = token;
        showScreen("recovery");
    }

    recoveryContinueBtn.addEventListener("click", function () {
        boot();
    });

    recoveryCopyBtn.addEventListener("click", function () {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(recoveryCodeEl.textContent).catch(function () {});
        }
    });

    pairForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var token = pairTokenInput.value.trim();
        if (!token) return;
        setMsg(pairMsg, gettext("Connecting…"), null);
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
            pairTokenInput.value = "";
            setMsg(pairMsg, "", null);
            showRecoveryCode(res.data.api_token);
        }).catch(function () {
            setMsg(pairMsg, gettext("Network error."), "error");
        });
    });

    // Self-service recovery for a browser that forgot its pairing - staff
    // paste back the code shown at pairing time, no admin involved. Uses
    // /device/info (rather than /device/initialize, which requires a
    // never-used *initialization* token, not the permanent api_token this
    // form takes) both to validate the code and to refetch the device's own
    // name/serial, so state ends up identical to a fresh pairing.
    restoreForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var code = restoreCodeInput.value.trim();
        if (!code) return;
        setMsg(restoreMsg, gettext("Checking…"), null);
        apiAs("/device/info", code).then(function (res) {
            if (!res.ok || !res.data || !res.data.device) {
                setMsg(restoreMsg, gettext("That code doesn't look valid, or this device was revoked - ask an administrator to re-pair it."), "error");
                return;
            }
            var d = res.data.device;
            state = {
                token: code,
                deviceId: d.device_id,
                uniqueSerial: d.unique_serial,
                deviceName: d.name,
            };
            saveState();
            restoreCodeInput.value = "";
            setMsg(restoreMsg, "", null);
            boot();
        }).catch(function () {
            setMsg(restoreMsg, gettext("Network error."), "error");
        });
    });

    // ---------------------------------------------------------------- events

    var eventsList = document.getElementById("pos-events-list");

    function loadEvents() {
        showScreen("events");
        eventsList.textContent = gettext("Loading…");
        api("/organizers/" + ORGANIZER + "/events/?ordering=-date_from").then(function (res) {
            if (!res.ok) {
                eventsList.textContent = interpolate(gettext("Could not load events (%(error)s)."), {error: describeError(res.data)}, true);
                return;
            }
            var events = (res.data && res.data.results) || [];
            if (!events.length) {
                eventsList.textContent = gettext("This device has no events assigned to it. Ask an administrator to grant it access on the Devices page.");
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
        quick: document.getElementById("pos-tab-quick"),
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

    // Reuses the tab button's own click handler above (active-class toggle,
    // panel visibility, default-list load) instead of duplicating it - used
    // when double-clicking an occupied seat on the Sell/Reserve map jumps
    // over to Find order for that seat's order (see renderSeatpick()).
    function switchToFindOrderTab() {
        var btn = tabs.filter(function (b) { return b.dataset.tab === "find"; })[0];
        if (btn) btn.click();
    }

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
        btnTill.hidden = false;

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
                loadSubevents().then(loadQuickReservationTab);
            } else {
                subeventBar.hidden = true;
                loadForCurrentContext();
                loadQuickReservationTab();
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
        return api(eventPath("/subevents/?active=true&ordering=date_from")).then(function (res) {
            var subs = (res.ok && res.data && res.data.results) || [];
            subeventsList = subs;
            subeventPriceOverrides = {};
            subeventSeatingPlans = {};
            subeventDisabled = {};
            subeventSeatedItems = {};
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
                var disabledItems = {}, disabledVariations = {};
                (se.item_price_overrides || []).forEach(function (o) {
                    if (o.price != null) items[o.item] = o.price;
                    if (o.disabled) disabledItems[o.item] = true;
                });
                (se.variation_price_overrides || []).forEach(function (o) {
                    if (o.price != null) variations[o.variation] = o.price;
                    if (o.disabled) disabledVariations[o.variation] = true;
                });
                subeventPriceOverrides[se.id] = {items: items, variations: variations};
                subeventDisabled[se.id] = {items: disabledItems, variations: disabledVariations};

                // Which items actually require a seat on this date, straight from
                // the subevent's own category mapping - not inferred from whether
                // the seatmap happens to return a free seat for that item, which
                // also comes back empty when a date's seating was only half set
                // up (a plan + mapping assigned, but its Seat rows never
                // generated) and would otherwise be indistinguishable from a
                // plain unseated date. See assignQuickSeats().
                var seatedItems = {};
                Object.keys(se.seat_category_mapping || {}).forEach(function (cat) {
                    seatedItems[se.seat_category_mapping[cat]] = true;
                });
                subeventSeatedItems[se.id] = seatedItems;
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
    var nameInput = document.getElementById("pos-name");
    var paymentMethodSelect = document.getElementById("pos-payment-method");
    var btnReserve = document.getElementById("pos-btn-reserve");
    var btnSell = document.getElementById("pos-btn-sell");
    var sellMsg = document.getElementById("pos-sell-msg");

    function loadSellItems() {
        sellItemsEl.textContent = gettext("Loading…");
        if (state.event.hasSubevents && !subeventSelect.value) {
            sellItemsEl.textContent = gettext("Choose a date above.");
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

    // pretix_seatmap's seatmap.js (drawSeats) expects short field names (guid, zone,
    // product_id) from its own internal endpoints; the public REST API - including
    // pretix_seatmap's own /seatmap/ addition to it - uses the API's normal naming
    // (seat_guid, zone_name, product). Adapt at the boundary rather than either
    // renaming the public API's fields (inconsistent with every other endpoint) or
    // reaching into seatmap.js's internals (a separate plugin's static asset).
    function toDrawSeat(s) {
        return {
            guid: s.seat_guid, x: s.x, y: s.y, zone: s.zone_name,
            row_label: s.row_label, seat_label: s.seat_label,
            status: s.status, product_id: s.product,
            category_color: s.category_color, radius: s.radius,
            order_code: s.order_code, order_email: s.order_email,
            order_attendee_name: s.order_attendee_name,
        };
    }

    // Shared tooltip for every seatmap this plugin draws (Sell/Reserve and
    // Find order alike) - deliberately just the order code/e-mail/attendee
    // name (whichever aren't blank), nothing else. Zone/row/seat/status is
    // already obvious from the seat's own position and color on the map, so
    // repeating it in the tooltip is just noise here - unlike, say, the
    // control assign GUI, which has no seat labels drawn on the map itself
    // and still needs the default zone/row/seat/status tooltip (see
    // drawSeats() in seatmap.js, which only uses this instead of its own
    // default when a titleFn is actually given). No order on this seat at
    // all (free, blocked, held in someone's cart) means an empty tooltip,
    // not the default text.
    function seatTitle(s) {
        if (!s.order_code) return "";
        var parts = [s.order_code];
        if (s.order_email) parts.push(s.order_email);
        if (s.order_attendee_name) parts.push(s.order_attendee_name);
        return parts.join(" — ");
    }

    function renderSellItems() {
        sellItemsEl.innerHTML = "";
        if (!sellItems.length) {
            sellItemsEl.textContent = gettext("No items available.");
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
            label.textContent = interpolate(gettext("%(name)s (%(price)s) — seated"), {name: item.name, price: fmtMoney(item.price)}, true);
            row.appendChild(label);

            var seId = currentSubeventId();
            var seatCount = cart.filter(function (c) { return c.itemId === item.id && c.seatGuid && c.subeventId === seId; }).length;
            if (activeSeatItem === item.id) {
                // The map below is already showing this item's seats - nothing
                // to click here, just a status readout.
                var status = document.createElement("span");
                status.className = "pos-item-price";
                status.textContent = seatCount
                    ? interpolate(ngettext("%(count)s selected", "%(count)s selected", seatCount), {count: seatCount}, true)
                    : gettext("Pick seats below");
                row.appendChild(status);
            } else {
                // Only reachable when more than one seated item exists - the map
                // auto-opens for the first one, this just lets staff switch which
                // item a click on the (shared) seatmap adds to.
                var btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = seatCount
                    ? interpolate(gettext("Switch to this item (%(count)s)"), {count: seatCount}, true)
                    : gettext("Switch to this item");
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
        seatpickTitle.textContent = interpolate(gettext("Seats for: %(name)s"), {name: pickI18n(itemsById[activeSeatItem].name)}, true);
        var seId = currentSubeventId();
        // Same ring-only, no-fill treatment as pretix_seatmap's eshop picker for
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
        }, seatTitle);
    }

    // Double-clicking an occupied seat here jumps to that order in Find
    // order, same shortcut as the one on Find order's own map (see
    // initOrderSeatMap()) - staff shouldn't have to go remember/retype an
    // order code just because they first noticed the seat while selling.
    // Only one listener is ever needed (svgSell itself is never recreated,
    // unlike the per-order svg in Find order), so this lives outside
    // renderSeatpick() instead of being re-attached on every redraw.
    svgSell.addEventListener("dblclick", function (e) {
        var el = e.target.closest && e.target.closest("[data-guid]");
        var seat = el && sellSeats.find(function (s) { return s.guid === el.getAttribute("data-guid"); });
        if (!seat || seat.status === "free" || !seat.order_code) return;
        switchToFindOrderTab();
        loadOrderDetail(seat.order_code);
    });

    function renderCart() {
        cartEl.innerHTML = "";
        if (!cart.length) {
            cartEl.textContent = gettext("Empty.");
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
            rm.textContent = gettext("Remove");
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
        totalDiv.textContent = interpolate(gettext("Total: %(amount)s"), {amount: total.toFixed(2)}, true);
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
        var email = emailInput.value.trim();
        var name = nameInput.value.trim();
        // A cash sale is done and paid for on the spot - nobody needs to find
        // it again. A reservation stays unpaid until the customer comes back,
        // so *something* has to identify whose it is - otherwise an older
        // customer without (or unwilling to give) an e-mail would get a
        // reservation nobody could ever match back to them.
        if (mode === "reserve" && !email && !name) {
            setMsg(sellMsg, gettext("Enter an e-mail or a name before reserving - otherwise there's no way to find this order again later."), "error");
            return;
        }
        if (name) {
            // Applied to every position, not per-attendee - for a walk-up POS
            // sale this is "whose reservation is this", not per-ticket
            // naming. attendee_name_cached (not invoice_address, which would
            // need a full billing address) is exactly what Find order's
            // search already matches against (core's OrderFilter.search_qs).
            positions.forEach(function (p) { p.attendee_name = name; });
        }
        var method = paymentMethodSelect.value;
        btnReserve.disabled = true;
        btnSell.disabled = true;
        setMsg(sellMsg, gettext("Submitting…"), null);
        var body = {status: mode === "sell" ? "p" : "n", positions: positions};
        if (SALES_CHANNEL) body.sales_channel = SALES_CHANNEL;
        if (email) body.email = email;
        if (mode === "sell") {
            body.payment_provider = "boxoffice";
            // Tagged onto the same immediate boxoffice payment core already
            // uses for a cash sale - BoxOfficeProvider.api_payment_details()
            // already reads back an info.payment_type field (core's admin
            // template even special-cases "cash"), so this needs no new
            // payment provider at all, just this one extra key.
            body.payment_info = {payment_type: method};
        }
        api(eventPath("/orders/"), {method: "POST", body: JSON.stringify(body)}).then(function (res) {
            if (!res.ok) {
                setMsg(sellMsg, describeError(res.data), "error");
                renderCart();
                return;
            }
            // Include the total: the cart (and its own visible "Total: ..."
            // line) is about to be cleared below, and for a cash sale staff
            // still need to know how much to actually collect from the
            // customer standing right there - losing that number the moment
            // the sale completes was the whole problem being fixed here.
            var doneMsg = mode === "sell"
                ? interpolate(gettext("Sold — order %(code)s, total %(total)s."), {code: res.data.code, total: res.data.total}, true)
                : interpolate(gettext("Reserved — order %(code)s, total %(total)s."), {code: res.data.code, total: res.data.total}, true);
            setMsg(sellMsg, doneMsg, "success");
            if (mode === "sell") addToTill(method, res.data.total);
            cart = [];
            activeSeatItem = null;
            emailInput.value = "";
            nameInput.value = "";
            renderCart();
            loadSellItems();
        });
    }

    btnReserve.addEventListener("click", function () { submitOrder("reserve"); });
    btnSell.addEventListener("click", function () { submitOrder("sell"); });

    // ----------------------------------------------------- quick reservation tab

    // For phone/in-person orders where nobody is picking exact seats or paying
    // right now - one row per date, one quantity input per item (or per
    // variation, for items that have any) - same shape as the eshop's own
    // quantity selector for a date that doesn't have customer seat-choice
    // enabled. Seats (if any) get assigned later from the Edit order tab, same
    // as any other manually-seated reservation.
    var quickTableEl = document.getElementById("pos-quick-table");
    var quickEmailInput = document.getElementById("pos-quick-email");
    var quickNameInput = document.getElementById("pos-quick-name");
    var quickBtnReserve = document.getElementById("pos-quick-btn-reserve");
    var quickMsg = document.getElementById("pos-quick-msg");

    function quickOrderableUnits() {
        // Same active-item filter as loadSellItems() - one unit per variation
        // for items that have any, one unit for the item itself otherwise.
        var units = [];
        Object.keys(itemsById).map(function (id) { return itemsById[id]; })
            .filter(function (it) { return it.active; })
            .sort(function (a, b) { return (a.position || 0) - (b.position || 0); })
            .forEach(function (it) {
                var variations = (it.variations || []).filter(function (v) { return v.active; });
                if (variations.length) {
                    variations.forEach(function (v) {
                        units.push({itemId: it.id, variationId: v.id, label: pickI18n(it.name) + " – " + pickI18n(v.value)});
                    });
                } else {
                    units.push({itemId: it.id, variationId: null, label: pickI18n(it.name)});
                }
            });
        return units;
    }

    function loadQuickReservationTab() {
        quickTableEl.innerHTML = "";
        var units = quickOrderableUnits();
        if (!units.length) {
            quickTableEl.textContent = gettext("No items available.");
            return;
        }
        // Events without subevents get a single implicit row (subeventId null) -
        // priceFor()/isDisabledFor() already treat that the same as "no override".
        var rows = state.event.hasSubevents ? subeventsList : [null];
        if (!rows.length) {
            quickTableEl.textContent = gettext("No dates available.");
            return;
        }

        var table = document.createElement("table");
        table.className = "pos-quick-table";
        var thead = document.createElement("thead");
        var headRow = document.createElement("tr");
        if (state.event.hasSubevents) {
            var dateTh = document.createElement("th");
            dateTh.textContent = gettext("Date");
            headRow.appendChild(dateTh);
        }
        units.forEach(function (u) {
            var th = document.createElement("th");
            th.textContent = u.label;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement("tbody");
        rows.forEach(function (se) {
            var seId = se ? se.id : null;
            var tr = document.createElement("tr");
            if (state.event.hasSubevents) {
                var dateTd = document.createElement("td");
                dateTd.textContent = pickI18n(se.name) + " — " + new Date(se.date_from).toLocaleString();
                tr.appendChild(dateTd);
            }
            units.forEach(function (u) {
                var td = document.createElement("td");
                var disabledMap = subeventDisabled[seId] || {items: {}, variations: {}};
                var disabled = u.variationId
                    ? disabledMap.variations[u.variationId]
                    : disabledMap.items[u.itemId];
                if (disabled) {
                    td.className = "pos-quick-cell-disabled";
                    td.textContent = "—";
                } else {
                    var input = document.createElement("input");
                    input.type = "number";
                    input.min = "0";
                    input.value = "0";
                    input.className = "pos-quick-qty";
                    input.dataset.itemId = u.itemId;
                    if (u.variationId) input.dataset.variationId = u.variationId;
                    if (seId != null) input.dataset.subeventId = seId;
                    td.appendChild(input);
                    var price = document.createElement("span");
                    price.className = "pos-quick-price";
                    price.textContent = fmtMoney(priceFor(u.itemId, u.variationId, seId));
                    td.appendChild(price);
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        quickTableEl.appendChild(table);
    }

    function buildQuickPositions() {
        var positions = [];
        Array.prototype.slice.call(quickTableEl.querySelectorAll(".pos-quick-qty")).forEach(function (input) {
            var n = parseInt(input.value, 10) || 0;
            for (var i = 0; i < n; i++) {
                var p = {item: parseInt(input.dataset.itemId, 10)};
                if (input.dataset.variationId) p.variation = parseInt(input.dataset.variationId, 10);
                if (input.dataset.subeventId) p.subevent = parseInt(input.dataset.subeventId, 10);
                positions.push(p);
            }
        });
        return positions;
    }

    // Only still needed for a date where customers pick their own seat
    // (seating_choice on) - core's order-create API only requires a seat
    // there, matching cart validation and order placement (see
    // submitQuickReservation() below for the normal, sans-hack path). To
    // create the reservation on one of those dates at all, every such
    // position here first grabs whichever free seat comes first for its
    // item/date, then gets that seat unassigned again right after creation
    // (same PATCH {seat: null} as unassignSeat() below) - landing the order
    // in the exact same "needs seating" queue as any other manually-assigned
    // reservation, per the Edit order tab, instead of holding a seat staff
    // never chose.
    function assignQuickSeats(positions) {
        if (!window.PretixSeatingRenderer) return Promise.resolve(true);
        var bySubevent = {};
        positions.forEach(function (p) {
            var key = p.subevent || "_";
            (bySubevent[key] = bySubevent[key] || []).push(p);
        });
        return Promise.all(Object.keys(bySubevent).map(function (key) {
            var seId = key === "_" ? null : parseInt(key, 10);
            var group = bySubevent[key];
            return apiAllPages(seId ? eventPath("/subevents/" + seId + "/seatmap/") : eventPath("/seatmap/")).then(function (res) {
                var seats = (res.ok && res.data && res.data.results) || [];
                var freeByItem = {};
                seats.forEach(function (s) {
                    if (s.status !== "free") return;
                    (freeByItem[s.product] = freeByItem[s.product] || []).push(s.seat_guid);
                });
                // Whether an item needs a seat at all comes from the date's own
                // category mapping (subeventSeatedItems), not from whether the
                // seatmap happened to return a free seat for it - a date can have
                // a plan and mapping assigned but no Seat rows actually generated
                // (a half-finished setup), which looks identical to "not seated"
                // if judged only by an empty free-seat pool, and would otherwise
                // let the create call through to fail with a raw API error later.
                var seatedItems = seId != null ? (subeventSeatedItems[seId] || {}) : null;
                var ok = true;
                group.forEach(function (p) {
                    var pool = freeByItem[p.item];
                    var needsSeat = seatedItems ? !!seatedItems[p.item] : !!pool;
                    if (!needsSeat) return;
                    if (!pool || !pool.length) { ok = false; return; }
                    p.seat = pool.shift();
                });
                return ok;
            });
        })).then(function (results) { return results.every(Boolean); });
    }

    // Sequential, not Promise.all - concurrent PATCHes against positions of the
    // *same* order race on OrderChangeManager's optimistic lock (see commit()
    // in orders.py, which compares Order.last_modified under select_for_update)
    // and the loser fails with a race-condition error, silently leaving that
    // seat assigned if nothing checks res.ok before moving on.
    function releaseQuickSeats(orderPositions) {
        var seated = orderPositions.filter(function (p) { return p.seat; });
        var releaseNext = function (i) {
            if (i >= seated.length) return Promise.resolve(true);
            return api(eventPath("/orderpositions/" + seated[i].id + "/"), {
                method: "PATCH", body: JSON.stringify({seat: null}),
            }).then(function (res) {
                if (!res.ok) return false;
                return releaseNext(i + 1);
            });
        };
        return releaseNext(0);
    }

    // core's order-create API rejects a seatless position for a seated product
    // outright *only* on a date where customers pick their own seat
    // (seating_choice on) - see OrderCreateSerializer, which mirrors cart
    // validation and order placement's own relaxation for manual/staff
    // assignment dates. So try the plain, hack-free request first; a
    // seating_choice-on date is the one case that still needs the
    // grab-a-seat-then-release-it dance (assignQuickSeats()/
    // releaseQuickSeats()) to get past that check at all.
    function createQuickOrder(body, positions) {
        return api(eventPath("/orders/"), {method: "POST", body: JSON.stringify(body)}).then(function (res) {
            if (res.ok) return {order: res.data};
            var seatRequired = (res.data && res.data.positions || []).some(function (p) { return p && p.seat; });
            if (!seatRequired) return {error: describeError(res.data)};
            return assignQuickSeats(positions).then(function (enough) {
                if (!enough) {
                    return {error: gettext("Not enough free seats left for one of these dates/items - try a smaller quantity.")};
                }
                return api(eventPath("/orders/"), {
                    method: "POST", body: JSON.stringify(Object.assign({}, body, {positions: positions})),
                }).then(function (res2) {
                    if (!res2.ok) return {error: describeError(res2.data)};
                    return releaseQuickSeats(res2.data.positions).then(function (allReleased) {
                        return {order: res2.data, releaseFailed: !allReleased};
                    });
                });
            });
        });
    }

    function submitQuickReservation() {
        var positions = buildQuickPositions();
        if (!positions.length) {
            setMsg(quickMsg, gettext("Enter a quantity greater than zero for at least one item/date."), "error");
            return;
        }
        var email = quickEmailInput.value.trim();
        var name = quickNameInput.value.trim();
        // Same reasoning as the Sell/Reserve tab's own reservations - this
        // always stays unpaid until the customer/staff comes back to finish it,
        // so something has to identify whose it is.
        if (!email && !name) {
            setMsg(quickMsg, gettext("Enter an e-mail or a name before reserving - otherwise there's no way to find this order again later."), "error");
            return;
        }
        if (name) positions.forEach(function (p) { p.attendee_name = name; });
        quickBtnReserve.disabled = true;
        setMsg(quickMsg, gettext("Submitting…"), null);
        var body = {status: "n", positions: positions};
        if (SALES_CHANNEL) body.sales_channel = SALES_CHANNEL;
        if (email) body.email = email;
        createQuickOrder(body, positions).then(function (result) {
            quickBtnReserve.disabled = false;
            if (result.error) {
                setMsg(quickMsg, result.error, "error");
                return;
            }
            var msg = result.releaseFailed
                ? interpolate(gettext("Reserved — order %(code)s, total %(total)s - but couldn't release every placeholder seat, check the Edit order tab."), {code: result.order.code, total: result.order.total}, true)
                : interpolate(gettext("Reserved — order %(code)s, total %(total)s."), {code: result.order.code, total: result.order.total}, true);
            setMsg(quickMsg, msg, result.releaseFailed ? "error" : "success");
            quickEmailInput.value = "";
            quickNameInput.value = "";
            loadQuickReservationTab();
        });
    }

    quickBtnReserve.addEventListener("click", submitQuickReservation);

    // --------------------------------------------------------------- find tab

    var searchInput = document.getElementById("pos-search");
    var searchBtn = document.getElementById("pos-search-btn");
    var searchResultsEl = document.getElementById("pos-search-results");
    var orderDetailEl = document.getElementById("pos-order-detail");
    var orderSeatmapWrapEl = document.getElementById("pos-order-seatmap-wrap");

    // Set by renderOrderDetail() (only while the loaded order is still "n"/pending),
    // kept at module level so seat placement/move/removal - all in initOrderSeatMap(),
    // a separate function - can re-enable "Take payment" without a full
    // loadOrderDetail() reload. null whenever no such button is currently on screen.
    var payBtn = null;
    var payMethodSelect = null;
    var seatHintEl = null;

    // Placing/moving/removing a seat changes whether the order is fully seated, but
    // deliberately doesn't reload the whole order detail panel (see the comment on
    // applyPositionSeat()) - so the "Take payment" button's disabled state, set once
    // when the panel was first rendered, would otherwise go stale until a manual
    // refresh. Call this after every seat mutation instead.
    function refreshPayButtonState() {
        if (!payBtn || !currentOrder) return;
        var seated = orderIsSeated(currentOrder);
        if (payMethodSelect) payMethodSelect.disabled = !seated;
        payBtn.disabled = !seated;
        if (seatHintEl) seatHintEl.hidden = seated;
    }

    function doSearch() {
        var q = searchInput.value.trim();
        if (!q) {
            loadDefaultOrderList();
            return;
        }
        searchResultsEl.textContent = gettext("Searching…");
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
        searchResultsEl.textContent = gettext("Loading…");
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

    // Customers without an e-mail are still identified by whatever name
    // submitOrder() attached to their positions (see the "reserve needs an
    // e-mail or a name" requirement) - shown here so staff can recognize a
    // no-email reservation by name at a glance, not just via search.
    function orderCustomerLabel(o) {
        if (o.email) return o.email;
        var named = (o.positions || []).find(function (p) { return p.attendee_name; });
        return named ? named.attendee_name : gettext("no e-mail");
    }

    function renderSearchResults(orders) {
        searchResultsEl.innerHTML = "";
        if (!orders.length) {
            searchResultsEl.textContent = gettext("No matching orders.");
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
            var line = " — " + orderCustomerLabel(o) + " — " + o.status + " — " +
                interpolate(gettext("total %(total)s"), {total: o.total}, true);
            if (parseFloat(pending) > 0) {
                line += ", " + interpolate(gettext("pending %(amount)s"), {amount: pending}, true);
            }
            div.appendChild(document.createTextNode(line));
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
        var name = it ? pickI18n(it.name) : interpolate(gettext("Item #%(id)s"), {id: p.item}, true);
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

            // Shown for every position, not just other-date ones (an order with a
            // single date still benefits from seeing which one it is) - clicking it
            // switches the date bar at the top, which re-renders this whole panel
            // (see subeventSelect's change handler) so its seatmap comes on screen.
            if (state.event.hasSubevents) {
                var dateBadge = document.createElement("span");
                dateBadge.className = "pos-seat-badge pos-date-badge";
                dateBadge.textContent = subeventLabel(pos.subevent);
                dateBadge.title = gettext("Click to switch to this date's seating plan.");
                dateBadge.addEventListener("click", function () {
                    subeventSelect.value = pos.subevent;
                    subeventSelect.dispatchEvent(new Event("change"));
                });
                row.appendChild(dateBadge);
            }

            var badge = document.createElement("span");
            if (pos.seat) {
                badge.className = "pos-seat-badge";
                badge.textContent = pos.seat.name || pos.seat.seat_guid;
            } else {
                badge.className = "pos-seat-badge pos-seat-missing";
                badge.textContent = gettext("no seat");
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
        // innerHTML = "" above already detached whatever these pointed to from a
        // previous render - drop the references too so refreshPayButtonState()
        // doesn't touch detached nodes for an order that's no longer "n"/pending.
        payBtn = null;
        payMethodSelect = null;
        seatHintEl = null;

        var h = document.createElement("h3");
        h.textContent = order.code + " — " + orderCustomerLabel(order) + " — " + order.status;
        orderDetailEl.appendChild(h);

        var pending = pendingSum(order);
        var p = document.createElement("p");
        p.textContent = interpolate(gettext("Total: %(total)s"), {total: order.total}, true) +
            (parseFloat(pending) > 0
                ? interpolate(gettext(" — pending: %(amount)s"), {amount: pending}, true)
                : gettext(" — fully paid"));
        orderDetailEl.appendChild(p);

        var list = document.createElement("div");
        renderPositionList(list);
        orderDetailEl.appendChild(list);

        if (order.status === "n") {
            payMethodSelect = document.createElement("select");
            PAYMENT_METHODS.forEach(function (m) {
                var opt = document.createElement("option");
                opt.value = m.value;
                opt.textContent = m.label;
                payMethodSelect.appendChild(opt);
            });
            orderDetailEl.appendChild(payMethodSelect);

            payBtn = document.createElement("button");
            payBtn.type = "button";
            payBtn.className = "pos-btn-primary";
            payBtn.textContent = gettext("Take payment");
            payBtn.addEventListener("click", function () { payOrder(order, payMethodSelect.value); });
            orderDetailEl.appendChild(payBtn);

            seatHintEl = document.createElement("p");
            seatHintEl.className = "pos-hint";
            seatHintEl.textContent = gettext("Assign a seat to every position (for every date) before taking payment.");
            orderDetailEl.appendChild(seatHintEl);

            // Taking cash before every seatable position actually has a seat risks
            // collecting money for a seat that turns out not to exist -
            // orderIsSeated() is already used to sort/color the Edit order list,
            // reused here to gate the button itself rather than just hinting at it.
            // Also re-run after every seat placement/move/removal - see
            // refreshPayButtonState().
            refreshPayButtonState();
        }

        if (order.status !== "c") {
            var cancelMsg = document.createElement("div");
            cancelMsg.className = "pos-msg";

            var cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "pos-btn-danger";
            cancelBtn.style.marginTop = "10px";
            cancelBtn.textContent = gettext("Cancel entire order");
            cancelBtn.addEventListener("click", function () { cancelOrder(order, cancelBtn, cancelMsg); });
            orderDetailEl.appendChild(cancelBtn);
            orderDetailEl.appendChild(cancelMsg);
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
                orderSeatmapWrapEl.textContent = gettext("Choose a date above to place seats for that date.");
                return;
            }
            if (!orderSeats.length) {
                orderSeatmapWrapEl.textContent = gettext("This date has no seated positions.");
                return;
            }

            var hint = document.createElement("p");
            hint.className = "pos-hint";
            hint.textContent = gettext("This order's own seats (for the date selected above) are shown in a muted highlight color. Click a free seat (or drag a rectangle over several) to select up to as many as there are checked positions - shown with a ring only until you click \"Place selected\"; click empty space to clear that selection. Click one of this order's own seats to remove it. Drag one of this order's own seats onto a free seat to move it (shown as a translucent preview while dragging); hold Ctrl while dragging to move its whole block of seats together. Hover any occupied seat to see which order holds it, or double-click it to jump straight to that order. Positions for other dates are listed above, greyed out - switch the date to work with them.");
            orderSeatmapWrapEl.appendChild(hint);

            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = "pos-svg-order";
            svg.setAttribute("class", "pos-seatmap");
            orderSeatmapWrapEl.appendChild(svg);

            var placeBtn = document.createElement("button");
            placeBtn.type = "button";
            placeBtn.textContent = gettext("Place selected seats on checked positions");
            placeBtn.style.marginTop = "10px";
            orderSeatmapWrapEl.appendChild(placeBtn);
            orderSeatmapWrapEl.appendChild(placeMsg);

            initOrderSeatMap(svg, placeBtn, placeMsg, list, seId);
        });
    }

    function payOrder(order, method) {
        // Guards the case where this got called despite the button being
        // disabled (stale UI state, a race, or a future call site) - the
        // primary gate is the disabled button in renderOrderDetail().
        if (!orderIsSeated(order)) return;

        var msg = document.createElement("div");
        msg.className = "pos-msg";
        orderDetailEl.appendChild(msg);
        setMsg(msg, gettext("Charging…"), null);
        // Captured before the request, not re-read afterwards - by the time
        // this resolves the order's own pending sum will be zero (it's just
        // been paid), so this is the one place that actually knows how much
        // is being added to the till for this payment.
        var amount = pendingSum(order);

        // A reservation placed online with a manual payment method (bank
        // transfer, ...) still carries that payment in "created"/"pending"
        // state when staff take cash for it at the counter instead - without
        // canceling it first, the order ends up with two payments (the
        // never-completed transfer plus the new cash one), which reads as
        // double-counted in the backend even though only the cash was ever
        // actually received. pendingSum() already only counts *confirmed*
        // payments as paid, so this doesn't change the amount being charged
        // here - only which payment(s) end up on the order afterwards.
        var stalePayments = (order.payments || []).filter(function (p) {
            return p.state === "created" || p.state === "pending";
        });

        function cancelStalePayments() {
            if (!stalePayments.length) return Promise.resolve([]);
            return Promise.all(stalePayments.map(function (p) {
                return api(eventPath("/orders/" + order.code + "/payments/" + p.local_id + "/cancel/"), {method: "POST"})
                    .then(function (res) { return {payment: p, res: res}; });
            }));
        }

        cancelStalePayments().then(function (results) {
            var failed = results.filter(function (r) { return !r.res.ok; });
            if (failed.length) {
                setMsg(msg, interpolate(
                    ngettext(
                        "Could not cancel %(count)s pending payment, continuing anyway: %(errors)s",
                        "Could not cancel %(count)s pending payments, continuing anyway: %(errors)s",
                        failed.length
                    ),
                    {
                        count: failed.length,
                        errors: failed.map(function (r) { return describeError(r.res.data); }).join("; "),
                    },
                    true
                ), "error");
            }
            return api(eventPath("/orders/" + order.code + "/payments/"), {
                method: "POST",
                body: JSON.stringify({provider: "boxoffice", amount: amount, state: "created", info: {payment_type: method}}),
            });
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
            addToTill(method, amount);
            loadOrderDetail(order.code);
            // loadOrderDetail() only refreshes the right-hand order detail
            // panel - the search-results list on the left still shows this
            // order with its old (pre-payment) status/color/sort position
            // otherwise, since it was rendered from a snapshot fetched
            // before this payment. Re-runs whatever's currently shown
            // (default browse list or an active search), same as any other
            // trigger for that list.
            doSearch();
        });
    }

    function cancelOrder(order, btn, msg) {
        if (!window.confirm(gettext("Cancel this entire order? This cannot be undone."))) return;
        btn.disabled = true;
        setMsg(msg, gettext("Canceling…"), null);
        api(eventPath("/orders/" + order.code + "/mark_canceled/"), {method: "POST"}).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            loadOrderDetail(order.code);
            // Same reasoning as payOrder()'s doSearch() call - the left-hand list
            // still shows this order's pre-cancellation status/color otherwise.
            doSearch();
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
        // it gets pretix_seatmap's MINE_COLOR (solid, muted fill+ring) instead -
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

        function render() {
            window.PretixSeatingRenderer.drawSeats(svg, seats, colorFn, null, null, "pointer", strokeFn, labelColorFn, seatTitle);
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
            var seatsPart = interpolate(ngettext("%(n)s selected seat", "%(n)s selected seats", n), {n: n}, true);
            var positionsPart = interpolate(ngettext("%(n)s checked position", "%(n)s checked positions", checked.length), {n: checked.length}, true);
            placeBtn.textContent = interpolate(gettext("Place %(seats)s on %(positions)s"), {seats: seatsPart, positions: positionsPart}, true);
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
            setMsg(msgEl, gettext("Placing seats one by one - this is not a single atomic action, a failure partway through leaves earlier placements in place…"), null);

            var i = 0, ok = 0, failed = [];
            function next() {
                if (i >= n) {
                    var resultMsg = interpolate(
                        ngettext("Placed %(ok)s/%(n)s seat.", "Placed %(ok)s/%(n)s seats.", n),
                        {ok: ok, n: n},
                        true
                    );
                    if (failed.length) {
                        resultMsg += " " + interpolate(gettext("Failed: %(errors)s"), {errors: failed.join("; ")}, true);
                    }
                    setMsg(msgEl, resultMsg, failed.length ? "error" : "success");
                    placementPool = {};
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    refreshPayButtonState();
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
            setMsg(msgEl, gettext("Moving seat…"), null);
            api(eventPath("/orderpositions/" + position.id + "/"), {
                method: "PATCH",
                body: JSON.stringify({seat: seatGuid}),
            }).then(function (res) {
                if (!res.ok) {
                    setMsg(msgEl, describeError(res.data), "error");
                    return;
                }
                setMsg(msgEl, gettext("Seat moved."), "success");
                applyPositionSeat(position.id, res.data.seat);
                renderPositionList(positionListEl);
                render();
                refreshPayButtonState();
            });
        }

        // A plain click on one of this order's own seats removes it - the
        // OrderPositionChangeSerializer's `seat` field accepts null explicitly
        // to unassign (confirmed in orderchange.py: it goes through
        // OrderChangeManager.change_seat(position, None), same as a real move).
        function unassignSeat(position) {
            setMsg(msgEl, gettext("Removing seat…"), null);
            api(eventPath("/orderpositions/" + position.id + "/"), {
                method: "PATCH",
                body: JSON.stringify({seat: null}),
            }).then(function (res) {
                if (!res.ok) {
                    setMsg(msgEl, describeError(res.data), "error");
                    return;
                }
                setMsg(msgEl, gettext("Seat removed."), "success");
                applyPositionSeat(position.id, null);
                renderPositionList(positionListEl);
                render();
                renderPlaceBtn();
                refreshPayButtonState();
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
                    setMsg(msgEl, gettext("Cannot move block: a seat's location is unknown."), "error");
                    return;
                }
                var wantX = seat.x + dx, wantY = seat.y + dy;
                var dest = seats.find(function (s) {
                    return Math.abs(s.x - wantX) < TOL && Math.abs(s.y - wantY) < TOL;
                });
                if (!dest) {
                    setMsg(msgEl, gettext("Cannot move block: target position is outside the seating plan."), "error");
                    return;
                }
                if (dest.status !== "free" && !blockGuids[dest.guid]) {
                    setMsg(msgEl, gettext("Cannot move block: seat at the target position is already taken."), "error");
                    return;
                }
                if (targetGuidsUsed[dest.guid]) {
                    setMsg(msgEl, gettext("Cannot move block: target seats overlap."), "error");
                    return;
                }
                targetGuidsUsed[dest.guid] = true;
                moves.push({position: pos, targetGuid: dest.guid});
            }

            setMsg(msgEl, interpolate(
                ngettext(
                    "Moving %(n)s seat - this is not a single atomic action, a failure partway through leaves it partially done…",
                    "Moving %(n)s seats - this is not a single atomic action, a failure partway through leaves it partially done…",
                    moves.length
                ),
                {n: moves.length},
                true
            ), null);

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
                    setMsg(msgEl, gettext("Block moved."), "success");
                    renderPositionList(positionListEl);
                    render();
                    refreshPayButtonState();
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
                        setMsg(msgEl, interpolate(gettext("Some seats failed to move: %(error)s"), {error: describeError(res.data)}, true), "error");
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
        tillPanel.hidden = true;
        if (!state.token) {
            showScreen("pair");
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = true;
            btnTill.hidden = true;
            headerInfo.textContent = "";
            return;
        }
        if (!state.event) {
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = false;
            btnTill.hidden = false;
            headerInfo.textContent = state.deviceName || "";
            loadEvents();
            return;
        }
        loadMainScreen();
    }

    boot();
})();
