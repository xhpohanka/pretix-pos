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
    // Whether the folded "products with no seats in this plan" list is open.
    // Kept outside the render so it survives the rebuild every seat click does.
    var sellExtrasOpen = false;
    var cart = [];
    // null = the seat map places whatever each seat's own category maps to, which
    // is the only correct answer and therefore the default. Set to
    // {itemId, variationId} when staff deliberately override that to sell some
    // other product on a seat - the one case where the mapping can't decide,
    // either because the seat's category maps to nothing, because the mapped
    // product has variations, or because they simply want a different product
    // there. Always visible as a banner above the map while set.
    var seatOverride = null;
    var currentOrder = null;
    // Reusing the same promise is important when opening or refreshing the
    // Find tab races with another view update: rendering an order detail tears
    // down and rebuilds its seatmap, so two identical GETs look like a full
    // double reload to the cashier.
    var orderDetailLoad = null;
    var placementPool = {}; // seat_guid -> seat, pending bulk placement on the loaded order
    // seat_guid -> seat, this order's own seats staged for bulk removal. Removing
    // a seat used to happen on a bare click, which put a destructive action one
    // stray click away on a map staff pan around constantly - it now mirrors
    // placement exactly: select first, then press the action button.
    var removalPool = {};
    // Colour a seat staged for removal is ringed in. Deliberately neither
    // MINE_COLOR ("assigned, staying put") nor SELECTED_COLOR ("about to be
    // placed") - staging to place and staging to clear are opposite actions and
    // must not look alike. Matches pos-btn-danger, so the ring and the button
    // that acts on it read as one thing.
    var REMOVAL_COLOR = "#c62828";
    var orderSeats = [];
    var subeventPriceOverrides = {}; // subeventId -> {items: {itemId: price}, variations: {variationId: price}}
    var subeventSeatingPlans = {}; // subeventId -> true if that date has a seating plan at all
    var subeventDisabled = {}; // subeventId -> {items: {itemId: true}, variations: {variationId: true}}
    var subeventsList = []; // raw API results, ordered - used by the Quick reservation tab
    var subeventSeatedItems = {}; // subeventId -> {itemId: true} - items with a seat category mapping on that date
    var quotasBySubevent = {}; // subeventId (or "null" for an event without subevents) -> [{items, variations, available}]
    // Unlike sellSeats (which is deliberately just the currently selected
    // date's drawable map), availability is needed for every row in Quick
    // reservation. Keep those maps separated by date so one date can never be
    // counted using another date's seats.
    var seatmapsBySubevent = {}; // subeventId (or "null") -> drawable seats
    var seatmapUnavailable = {}; // keys whose latest seatmap request failed
    var seatmapAvailabilityBySubevent = {}; // keys -> aggregated availability
    var seatmapAvailabilityRevision = null;
    var seatmapAvailabilityUnavailable = false;

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
    // pretix-cz-banktransfer's provider identifier. Picking "QR transfer" books
    // a payment with this provider, so the variable symbol, the scannable code
    // and the later bank matching all come from the one plugin that owns them.
    var BANK_TRANSFER_PROVIDER = "czbanktransfer";
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

    // The compact order list is a POS plugin endpoint, not part of core's
    // /api/v1 namespace. It still uses the same Device token and response
    // shape as api(), so callers do not need a second authentication path.
    function posApi(path, opts) {
        opts = opts || {};
        var headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
        if (state.token) headers.Authorization = "Device " + state.token;
        return fetch(path, Object.assign({}, opts, {headers: headers, cache: "no-store"}))
            .then(function (r) {
                return r.text().then(function (t) {
                    var data = null;
                    if (t) {
                        try { data = JSON.parse(t); } catch (e) { /* non-JSON error */ }
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

    // "date time - name" everywhere a subevent gets labeled (the date <select>
    // options, which subeventLabel() itself just reads back, and the Quick
    // reservation table's own date column) - one shared format instead of each
    // call site building its own, and minutes only (toLocaleString() also
    // includes seconds, which nobody needs for a date/time that's only ever
    // set to whole minutes anyway).
    function formatSubeventLabel(se) {
        var d = new Date(se.date_from);
        return d.toLocaleDateString() + " " +
            d.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"}) +
            " - " + pickI18n(se.name);
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
    var testmodeBanner = document.getElementById("pos-testmode-banner");
    var btnChangeEvent = document.getElementById("pos-btn-change-event");
    var btnUnpair = document.getElementById("pos-btn-unpair");
    var btnRefresh = document.getElementById("pos-btn-refresh");
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
                        // Refreshed on every boot by loadEventInfo() - an
                        // organizer can flip test mode at any time, so what
                        // matters is its value at the moment of the sale, not
                        // at pairing time.
                        testmode: !!ev.testmode,
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
    var subeventSellSlot = document.getElementById("pos-subevent-slot-sell");
    var subeventFindSlot = document.getElementById("pos-subevent-slot-find");

    var tabs = Array.prototype.slice.call(document.querySelectorAll(".pos-tab"));
    var activeTab = "quick";
    // Consumed by refreshCurrentView() after a link/seat explicitly opens one
    // order. The tab click still refreshes availability and the order list,
    // but must not fetch the same detail a second time in parallel.
    var skipNextFindDetailRefresh = false;
    var panels = {
        quick: document.getElementById("pos-tab-quick"),
        sell: document.getElementById("pos-tab-sell"),
        find: document.getElementById("pos-tab-find"),
    };

    // A date is a property of the terminal, not of one tab: both selling and
    // editing an order use it to choose the seatmap. Move the one select to
    // the active view instead of keeping two controls that could disagree.
    function placeSubeventBar(tab) {
        var target = tab === "find" ? subeventFindSlot : subeventSellSlot;
        if (target && subeventBar.parentNode !== target) target.appendChild(subeventBar);
    }

    tabs.forEach(function (btn) {
        btn.addEventListener("click", function () {
            activeTab = btn.dataset.tab;
            placeSubeventBar(activeTab);
            tabs.forEach(function (b) { b.classList.toggle("active", b === btn); });
            Object.keys(panels).forEach(function (k) {
                panels[k].hidden = k !== btn.dataset.tab;
            });
            if (state.event && state.event.slug) refreshCurrentView();
        });
    });

    // Reuses the tab button's own click handler above (active-class toggle,
    // panel visibility, default-list load) instead of duplicating it - used
    // when double-clicking an occupied seat on the Sell/Reserve map jumps
    // over to Find order for that seat's order (see renderSeatpick()).
    function switchToFindOrderTab(code) {
        var btn = tabs.filter(function (b) { return b.dataset.tab === "find"; })[0];
        if (!btn) return;
        if (code) skipNextFindDetailRefresh = true;
        btn.click();
        if (code) loadOrderDetail(code);
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
        activeTab = "quick";
        placeSubeventBar(activeTab);
        tabs.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === activeTab); });
        Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== activeTab; });
        headerInfo.textContent = (state.deviceName ? state.deviceName + " · " : "") + state.event.name;
        btnChangeEvent.hidden = false;
        btnUnpair.hidden = false;
        btnRefresh.hidden = false;
        btnTill.hidden = false;

        // A cart can span several dates of the same event (see subeventSelect's
        // change handler below) but never several events - this is the one
        // place a genuinely fresh session starts, whether from initial page
        // load or from "Change event".
        cart = [];
        seatOverride = null;
        sellSeats = [];
        seatmapsBySubevent = {};
        seatmapUnavailable = {};
        seatmapAvailabilityBySubevent = {};
        seatmapAvailabilityRevision = null;
        seatmapAvailabilityUnavailable = false;
        renderCart();

        Promise.all([loadEventInfo(), loadItemsIndex(), loadQuotas(), loadSeatmapAvailability()]).then(function () {
            if (state.event.hasSubevents) {
                subeventBar.hidden = false;
                loadSubevents().then(function () {
                    return loadQuickReservationTab();
                });
            } else {
                subeventBar.hidden = true;
                return loadQuickReservationTab();
            }
        });
    }

    // Whether we currently know the event's test mode for sure. Terminals
    // paired before test mode was honoured have a cached state.event with no
    // testmode key at all, so "no cached value and the refresh failed" is a
    // real state - and one we must not silently resolve to "live", or a test
    // sale becomes an undeletable real order (core only ever allows deleting
    // test mode orders). submitOrder()/submitQuickOrder() refuse to sell
    // while this is false rather than guess.
    var testmodeKnown = false;

    function loadEventInfo() {
        return api(eventPath("/")).then(function (res) {
            if (!res.ok || !res.data) {
                // Keep whatever a previous boot stored - a transient failure
                // shouldn't change how orders are tagged.
                testmodeKnown = typeof state.event.testmode === "boolean";
                renderTestmodeBanner();
                return;
            }
            state.event.testmode = !!res.data.testmode;
            state.event.name = pickI18n(res.data.name);
            // Needed by orderLastEventDate() for events without subevents,
            // where no position carries a date of its own.
            state.event.dateFrom = res.data.date_from || null;
            saveState();
            testmodeKnown = true;
            headerInfo.textContent = (state.deviceName ? state.deviceName + " · " : "") + state.event.name;
            renderTestmodeBanner();
        });
    }

    // Staff have no other way to tell a test-mode terminal from a live one,
    // and the difference matters: in test mode nothing sold here is a real
    // ticket, and every order stays deletable.
    function renderTestmodeBanner() {
        testmodeBanner.hidden = !(testmodeKnown && state.event && state.event.testmode);
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

    // A date's item_price_overrides only ever say "hidden here"/"different
    // price here" - they say nothing about whether a quota actually exists
    // for that item/date at all, so on their own they let an item with no
    // matching quota show up as choosable (e.g. a variation only ever quota'd
    // for a *different* date). This is what isAvailableAt() below is for.
    function loadQuotas() {
        return apiAllPages(eventPath("/quotas/?with_availability=true")).then(function (res) {
            quotasBySubevent = {};
            ((res.ok && res.data && res.data.results) || []).forEach(function (q) {
                var key = q.subevent != null ? String(q.subevent) : "null";
                (quotasBySubevent[key] = quotasBySubevent[key] || []).push(q);
            });
        });
    }

    // An item/variation with zero quotas covering it for this date can never
    // actually be sold there. One with several is only as available as its
    // *most* exhausted quota - pretix requires room in every quota an
    // item/variation is linked to, not just one of them (selling one unit
    // consumes stock from all of them at once).
    function quotasFor(subeventId, itemId, variationId) {
        var key = subeventId != null ? String(subeventId) : "null";
        return (quotasBySubevent[key] || []).filter(function (q) {
            // A variation consumes both quotas that explicitly contain the
            // variation and quotas covering its whole product.
            return q.items.indexOf(itemId) !== -1 ||
                (variationId && q.variations.indexOf(variationId) !== -1);
        });
    }

    function isAvailableAt(subeventId, itemId, variationId) {
        var quotas = quotasFor(subeventId, itemId, variationId);
        if (!quotas.length) return false;
        return quotas.every(function (q) { return q.available; });
    }

    function getAvailableCount(subeventId, itemId, variationId) {
        // Quick reservation can show several subevents at once. Use the
        // seatmap belonging to this row below, never the currently selected
        // sell/reserve date (sellSeats), and keep the quota as an upper bound.
        var key = subeventId != null ? String(subeventId) : "null";
        var quotas = quotasFor(subeventId, itemId, variationId);
        if (!quotas.length) return 0;
        var quotaAvailable = Math.min.apply(null, quotas.map(function (q) {
            return q.available_number;
        }));
        var seats = seatmapsBySubevent[key];
        var availability = seatmapAvailabilityBySubevent[key];
        if (!seats && !availability && seatmapUnavailable[key] &&
                (subeventId != null ? !!subeventSeatingPlans[subeventId] : !!state.event.seatingPlan)) {
            // A seatplan without a readable seatmap is not safely sellable.
            // Never fall back to quota-only availability in that case.
            return 0;
        }
        if (!seats && availability) {
            var availabilityPool = subeventId != null
                ? (availability.by_product[String(itemId)] || {free: 0, taken: 0, held: 0})
                : availability.by_product[String(itemId)];
            var mapped = subeventId != null
                ? !!(subeventSeatedItems[subeventId] || {})[itemId]
                : !!availabilityPool;
            var free = mapped ? availabilityPool.free : availability.free;
            var occupied = mapped
                ? availabilityPool.taken + availabilityPool.held
                : availability.taken + availability.held;
            var unassigned = Math.max.apply(null, quotas.map(function (q) {
                return Math.max(0, (q.size - q.available_number) - occupied);
            }));
            return Math.min(Math.max(0, free - unassigned), quotaAvailable);
        }
        if (!seats && seatmapAvailabilityUnavailable &&
                (subeventId != null ? !!subeventSeatingPlans[subeventId] : !!state.event.seatingPlan)) {
            return 0;
        }
        if (seats) {
            // For dates with subevents the category mapping remains
            // authoritative even when every seat is blocked/occupied (or Seat
            // rows have not been generated yet). Without subevents, infer it
            // from the seatmap as before because there is no subevent mapping.
            var seatedItems = subeventId != null ? (subeventSeatedItems[subeventId] || {}) : null;
            var hasSeats = seatedItems ? !!seatedItems[itemId] : seats.some(function (s) {
                return s.product_id === itemId;
            });
            if (hasSeats) {
                var freeSeats = seats.filter(function (s) {
                    return s.product_id === itemId && s.status === "free";
                }).length;
                var occupiedSeats = seats.filter(function (s) {
                    return s.product_id === itemId && s.status !== "free" && s.status !== "blocked";
                }).length;
                // Quota availability also includes positions that have no seat
                // assigned yet. Those positions do not appear as occupied in
                // the seatmap, so subtract them from the physical free-seat
                // pool before applying the quota limit. Otherwise a seatplan
                // could sell past its usable capacity after a large seatless
                // reservation.
                var seatless = Math.max.apply(null, quotas.map(function (q) {
                    return Math.max(0, (q.size - q.available_number) - occupiedSeats);
                }));
                // The seat pool is shared by all variants, but a particular
                // variant can also have a tighter own or product-wide quota.
                // Neither constraint alone is the number that can be sold.
                return Math.min(Math.max(0, freeSeats - seatless), quotaAvailable);
            }
            // An unmapped product can be seated on any category, but it still
            // cannot be sold past the physical capacity of this plan. Quick
            // reservation leaves the exact seat unassigned for later; that
            // does not make another ticket-sized slot appear in the venue.
            var plan = subeventId != null ? !!subeventSeatingPlans[subeventId] : seats.length > 0;
            if (plan) {
                var allFreeSeats = seats.filter(function (s) { return s.status === "free"; }).length;
                var allOccupiedSeats = seats.filter(function (s) {
                    return s.status !== "free" && s.status !== "blocked";
                }).length;
                var unassigned = Math.max.apply(null, quotas.map(function (q) {
                    return Math.max(0, (q.size - q.available_number) - allOccupiedSeats);
                }));
                return Math.min(Math.max(0, allFreeSeats - unassigned), quotaAvailable);
            }
        }
        // For non-seated items, or if no seatmap could be loaded, use quota availability.
        return quotaAvailable;
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
                opt.textContent = formatSubeventLabel(se);
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
        });
    }

    subeventSelect.addEventListener("change", function () {
        // Switching the date must NOT drop whatever is already in the cart for
        // other dates - only the in-progress seat-picking UI (tied to this one
        // date's seatmap) needs resetting. Each cart entry carries its own
        // subeventId (see adjustQty/renderSeatpick), so buildPositions() below
        // still submits everything to the right date regardless of which date
        // is currently selected.
        seatOverride = null;

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
            removalPool = {};
        }

        // orderSortKey() now favors an order that still needs a seat on
        // *this* date specifically (see orderNeedsSeatOnCurrentDate()) - that
        // ranking is stale the moment the date changes, so re-run whatever's
        // currently shown (default browse list or an active search) to
        // re-sort against the new one.
        refreshCurrentView();
    });

    // All views read availability from the same two sources: quotas and (when
    // applicable) seatmaps. Keep one refresh chain so a quick succession of
    // tab switches, manual refreshes, or completed mutations cannot let an
    // older response repaint over newer data.
    var refreshChain = Promise.resolve();
    var availabilityRefreshTimer = null;

    function refreshAvailability() {
        refreshChain = refreshChain.catch(function () {}).then(function () {
            return loadQuotas().then(loadSeatmapAvailability).then(function () {
                // Do not rebuild an inactive quantity form: staff may have a
                // draft in it. Its data is refreshed before the tab is shown.
                if (activeTab === "quick") {
                    // Quick uses only the aggregate response. Drop a full map
                    // left over from Sell so it cannot shadow newer counts.
                    seatmapsBySubevent = {};
                    sellSeats = [];
                }
                return loadQuickReservationTab(activeTab === "quick");
            });
        });
        return refreshChain;
    }

    function scheduleAvailabilityRefresh() {
        if (availabilityRefreshTimer) clearTimeout(availabilityRefreshTimer);
        availabilityRefreshTimer = setTimeout(function () {
            availabilityRefreshTimer = null;
            refreshAvailability();
        }, 0);
    }

    function refreshCurrentView() {
        return refreshAvailability().then(function () {
            if (activeTab === "sell") {
                return loadSellItemsWithQuotas();
            }
            if (activeTab === "find") {
                var viewLoads = [];
                if (skipNextFindDetailRefresh) {
                    skipNextFindDetailRefresh = false;
                } else if (currentOrder && currentOrder.code) {
                    viewLoads.push(loadOrderDetail(currentOrder.code));
                }
                viewLoads.push(searchInput.value.trim() ? doSearch() : loadDefaultOrderList());
                return Promise.all(viewLoads);
            }
        });
    }

    btnRefresh.addEventListener("click", function () {
        if (!state.event || !state.event.slug || btnRefresh.disabled) return;
        btnRefresh.disabled = true;
        refreshCurrentView().then(function () {
            btnRefresh.disabled = false;
        }, function () {
            btnRefresh.disabled = false;
        });
    });

    // --------------------------------------------------------------- sell tab

    var sellItemsEl = document.getElementById("pos-items");
    var seatpickWrap = document.getElementById("pos-seatpick-wrap");
    var svgSell = document.getElementById("pos-svg-sell");
    var clearSellSeatsBtn = document.getElementById("pos-btn-clear-sell-seats");
    var seatOverrideEl = document.getElementById("pos-seat-override");
    var seatpickMsg = document.getElementById("pos-seatpick-msg");
    var cartEl = document.getElementById("pos-cart");
    var emailInput = document.getElementById("pos-email");
    var nameInput = document.getElementById("pos-name");
    var paymentMethodSelect = document.getElementById("pos-payment-method");
    var btnReserve = document.getElementById("pos-btn-reserve");
    var btnSell = document.getElementById("pos-btn-sell");
    var sellMsg = document.getElementById("pos-sell-msg");
    var sellOrderChoiceEl = document.getElementById("pos-sell-order-choice");
    var sellOrderCandidates = [];
    var sellOrderDecision = null;
    var sellOrderSearchTimer = null;
    var sellOrderSearchRequest = 0;
    var sellOrderSearchPending = false;
    var sellOrderSearchFailed = false;

    function seatmapCacheKey(subeventId) {
        return "pretix_pos_layout:" + ORGANIZER + ":" + state.event.slug + ":" + (subeventId != null ? subeventId : "null");
    }

    function readSeatmapLayout(subeventId) {
        try {
            return JSON.parse(sessionStorage.getItem(seatmapCacheKey(subeventId))) || null;
        } catch (e) {
            return null;
        }
    }

    function writeSeatmapLayout(subeventId, layout) {
        try {
            sessionStorage.setItem(seatmapCacheKey(subeventId), JSON.stringify(layout));
        } catch (e) {
            // Storage may be disabled or full; the in-memory path still works.
        }
    }

    function loadSeatmap(subeventId) {
        var key = subeventId != null ? String(subeventId) : "null";
        if (!window.PretixSeatingRenderer) {
            seatmapUnavailable[key] = true;
            delete seatmapsBySubevent[key];
            return Promise.resolve([]);
        }
        var cached = readSeatmapLayout(subeventId);
        var layoutPath = subeventId != null
            ? eventPath("/subevents/" + subeventId + "/seatmap/layout/")
            : eventPath("/seatmap/layout/");
        if (cached && cached.revision) layoutPath += "?revision=" + encodeURIComponent(cached.revision);
        var statePath = subeventId != null
            ? eventPath("/subevents/" + subeventId + "/seatmap/state/")
            : eventPath("/seatmap/state/");
        return api(layoutPath).then(function (layoutRes) {
            if (!layoutRes.ok || !layoutRes.data) {
                seatmapUnavailable[key] = true;
                delete seatmapsBySubevent[key];
                return [];
            }
            var layout = layoutRes.data.seats || (cached && cached.seats);
            if (!layout) {
                seatmapUnavailable[key] = true;
                delete seatmapsBySubevent[key];
                return [];
            }
            var revision = layoutRes.data.revision || (cached && cached.revision);
            if (layoutRes.data.seats) writeSeatmapLayout(subeventId, {revision: revision, seats: layoutRes.data.seats});
            return api(statePath).then(function (stateRes) {
                if (!stateRes.ok || !stateRes.data) {
                    seatmapUnavailable[key] = true;
                    delete seatmapsBySubevent[key];
                    return [];
                }
                var states = {};
                (stateRes.data.seats || []).forEach(function (s) { states[s.seat_guid] = s; });
                var seats = layout.map(function (s) {
                    return toDrawSeat(Object.assign({}, s, states[s.seat_guid] || {status: "free"}));
                });
                seatmapUnavailable[key] = false;
                seatmapsBySubevent[key] = seats;
                return seats;
            });
        });
    }

    function loadSeatmapAvailability() {
        return api(eventPath("/seatmap/availability/")).then(function (res) {
            if (!res.ok || !res.data) {
                seatmapAvailabilityUnavailable = true;
                return;
            }
            seatmapAvailabilityUnavailable = false;
            seatmapAvailabilityRevision = res.data.revision || null;
            seatmapAvailabilityBySubevent = {};
            (res.data.results || []).forEach(function (result) {
                var key = result.subevent != null ? String(result.subevent) : "null";
                seatmapAvailabilityBySubevent[key] = result;
            });
        });
    }

    function loadSellItemsWithQuotas() {
        var seId = currentSubeventId();
        return loadSeatmap(seId).then(function (seats) {
            sellSeats = seats;
            if (seId != null && subeventSeatingPlans[seId] && seatmapUnavailable[String(seId)]) {
                sellItems = [];
                seatpickWrap.hidden = true;
                sellItemsEl.textContent = gettext("Could not load the seating plan. Selling is temporarily unavailable.");
                return;
            }
            if (seId == null && state.event.seatingPlan && seatmapUnavailable["null"]) {
                sellItems = [];
                seatpickWrap.hidden = true;
                sellItemsEl.textContent = gettext("Could not load the seating plan. Selling is temporarily unavailable.");
                return;
            }
            var itemList = Object.keys(itemsById).map(function (id) { return itemsById[id]; })
                .filter(function (it) { return it.active; })
                .sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
            sellItems = itemList.map(function (it) {
                var needsSeat = sellSeats.some(function (s) { return s.product_id === it.id; });
                var variations = (it.variations || []).filter(function (v) { return v.active; });
                // A seated item's real availability is the seatmap's own free
                // seats, already reflected by needsSeat/the map itself - only
                // filter the plain qty-based case here, same as
                // loadQuickReservationTab()'s isAvailableAt() check, so
                // "Vstupenka plus" etc. stops showing up as choosable on a
                // date that has no quota for it at all.
                if (!needsSeat) {
                    variations = variations.filter(function (v) { return isAvailableAt(seId, it.id, v.id); });
                }
                return {
                    id: it.id,
                    name: pickI18n(it.name),
                    price: priceFor(it.id, null, seId),
                    hasVariations: it.has_variations,
                    variations: variations.map(function (v) {
                        return {id: v.id, value: pickI18n(v.value), price: priceFor(it.id, v.id, seId)};
                    }),
                    needsSeat: needsSeat,
                };
            });
            sellItems = sellItems.filter(function (item) {
                if (item.needsSeat) return true;
                return item.hasVariations ? item.variations.length > 0 : isAvailableAt(seId, item.id, null);
            });
            // Nothing to pre-select any more: the map is shown whenever this
            // date has seats at all, and which product a click books is decided
            // by the seat itself (see seatTargetFor()).
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
        var seated = sellItems.filter(function (it) { return it.needsSeat; });
        var others = sellItems.filter(function (it) { return !it.needsSeat; });

        // On a date the plan actually maps, the products it *doesn't* map are the
        // rare case - staff sell them a few times a season - and listing them
        // costs the vertical space the seat map wants. They fold away into one
        // line instead. A date with no mapped products at all is a different
        // story: those products are then the only thing to sell, so nothing is
        // folded.
        if (!seated.length) {
            sellItems.forEach(function (item) {
                sellItemsEl.appendChild(renderSellItemRow(item));
            });
            renderSeatpick();
            return;
        }

        seated.forEach(function (item) {
            sellItemsEl.appendChild(renderSellItemRow(item));
        });

        if (others.length) {
            var seId = currentSubeventId();
            var inUse = others.some(function (it) {
                if (seatOverride && seatOverride.itemId === it.id) return true;
                return cart.some(function (c) { return c.itemId === it.id && c.subeventId === seId; });
            });

            var det = document.createElement("details");
            det.className = "pos-extras";
            // Forced open while one of them is actually being used - the list is
            // rebuilt on every click, and snapping shut under staff mid-sale
            // would be worse than the space it saves.
            det.open = sellExtrasOpen || inUse;
            var sum = document.createElement("summary");
            sum.textContent = interpolate(
                ngettext(
                    "%(count)s product with no seats in this plan",
                    "%(count)s products with no seats in this plan",
                    others.length
                ),
                {count: others.length}, true
            );
            det.appendChild(sum);
            det.addEventListener("toggle", function () { sellExtrasOpen = det.open; });
            others.forEach(function (item) {
                det.appendChild(renderSellItemRow(item));
            });
            sellItemsEl.appendChild(det);
        }

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

    // How many seats are already in the cart for this exact product on this date.
    function seatCountFor(itemId, variationId) {
        var seId = currentSubeventId();
        return cart.filter(function (c) {
            return c.itemId === itemId && c.variationId === (variationId || null) &&
                c.seatGuid && c.subeventId === seId;
        }).length;
    }

    // Server-side quota availability does not include this terminal's own
    // unsubmitted cart. A quota can cover several products/variants, so count
    // every queued position consumed by each applicable quota, not just the
    // exact item the cashier just clicked.
    function cartUsesQuota(position, quota) {
        return quota.items.indexOf(position.itemId) !== -1 ||
            (position.variationId && quota.variations.indexOf(position.variationId) !== -1);
    }

    function canAddSeatTarget(subeventId, itemId, variationId) {
        var quotas = quotasFor(subeventId, itemId, variationId);
        if (!quotas.length) return false;
        if (!quotas.every(function (quota) {
            var inCart = cart.filter(function (position) {
                return position.subeventId === subeventId && cartUsesQuota(position, quota);
            }).length;
            return inCart < quota.available_number;
        })) return false;

        // getAvailableCount() adds the seatplan's physical capacity and
        // already-reserved seatless positions to the quota limit. Account for
        // positions of this exact target that are only in the local cart too.
        var sameTarget = cart.filter(function (position) {
            return position.subeventId === subeventId && position.itemId === itemId &&
                position.variationId === (variationId || null);
        }).length;
        return sameTarget < getAvailableCount(subeventId, itemId, variationId);
    }

    // The button that turns the mapping off and books this exact product on
    // whatever seat is clicked next. Offered on every sellable product, mapped
    // or not: "seat anything" is the whole point, and a single button per
    // product is a smaller thing to explain than one rule for mapped products
    // and another for the rest.
    function seatOverrideButton(item, variation) {
        var variationId = variation ? variation.id : null;
        var active = seatOverride && seatOverride.itemId === item.id &&
            (seatOverride.variationId || null) === variationId;
        var count = seatCountFor(item.id, variationId);

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = active ? "pos-btn-secondary" : "";
        btn.textContent = active
            ? gettext("Placing this — click seats")
            : (count
                ? interpolate(gettext("Seat this product (%(count)s)"), {count: count}, true)
                : gettext("Seat this product"));
        btn.addEventListener("click", function () {
            // Pressing the active one again goes back to following the mapping,
            // so the override is never a state staff can only leave via the
            // banner.
            seatOverride = active ? null : {itemId: item.id, variationId: variationId};
            setMsg(seatpickMsg, "", null);
            renderSellItems();
        });
        return btn;
    }

    function renderSellItemRow(item) {
        var row = document.createElement("div");
        row.className = "pos-item-row";
        var seId = currentSubeventId();

        // A product the mapping covers is sold by the seat, never by quantity -
        // core refuses a seatless position for it on a date where seats are
        // chosen, so a quantity stepper here would only build an order the API
        // would reject.
        if (item.needsSeat && !item.hasVariations) {
            var label = document.createElement("div");
            label.className = "pos-item-title";
            label.textContent = interpolate(gettext("%(name)s (%(price)s) — seated"), {name: item.name, price: fmtMoney(item.price)}, true);
            row.appendChild(label);

            var availSpan = document.createElement("span");
            availSpan.className = "pos-item-available";
            availSpan.textContent = getAvailableCount(seId, item.id, null);
            row.appendChild(availSpan);

            var seated = seatCountFor(item.id, null);
            var status = document.createElement("span");
            status.className = "pos-item-price";
            status.textContent = seated
                ? interpolate(ngettext("%(count)s selected", "%(count)s selected", seated), {count: seated}, true)
                : gettext("Click its seats on the map");
            row.appendChild(status);
            row.appendChild(seatOverrideButton(item, null));
            return row;
        }

        if (item.hasVariations) {
            var wrap = document.createElement("div");
            wrap.style.width = "100%";
            var title = document.createElement("div");
            title.className = "pos-item-title";
            title.textContent = item.needsSeat
                ? interpolate(gettext("%(name)s — seated, pick a variant"), {name: item.name}, true)
                : item.name;
            wrap.appendChild(title);
            item.variations.forEach(function (v) {
                var varRow;
                if (item.needsSeat) {
                    // Mapped *and* has variations: the mapping says which product
                    // but not which variant, so a seat click can't resolve it on
                    // its own - these are placed through the override only. (This
                    // is also what used to silently queue a position with no
                    // variation at all, which the order API rejects.)
                    varRow = document.createElement("div");
                    varRow.className = "pos-item-row";
                    var vlabel = document.createElement("span");
                    vlabel.textContent = v.value + " (" + fmtMoney(v.price) + ")";
                    varRow.appendChild(vlabel);
                    var vcount = seatCountFor(item.id, v.id);
                    if (vcount) {
                        var vstatus = document.createElement("span");
                        vstatus.className = "pos-item-price";
                        vstatus.textContent = interpolate(ngettext("%(count)s selected", "%(count)s selected", vcount), {count: vcount}, true);
                        varRow.appendChild(vstatus);
                    }
                } else {
                    varRow = qtyRow(v.value + " (" + fmtMoney(v.price) + ")", cartCountFor(item.id, v.id), function (delta) {
                        adjustQty(item.id, v.id, v.price, delta);
                    });
                    var availSpanV = document.createElement("span");
                    availSpanV.className = "pos-item-available";
                    availSpanV.textContent = getAvailableCount(seId, item.id, v.id);
                    varRow.appendChild(availSpanV);
                }
                if (sellSeats.length) varRow.appendChild(seatOverrideButton(item, v));
                wrap.appendChild(varRow);
            });
            row.appendChild(wrap);
            return row;
        }

        var title2 = document.createElement("div");
        title2.className = "pos-item-title";
        title2.textContent = item.name + " (" + fmtMoney(item.price) + ")";
        row.appendChild(title2);

        var availSpan2 = document.createElement("span");
        availSpan2.className = "pos-item-available";
        availSpan2.textContent = getAvailableCount(seId, item.id, null);
        row.appendChild(availSpan2);

        row.appendChild(qtyControls(cartCountFor(item.id, null), function (delta) {
            adjustQty(item.id, null, item.price, delta);
        }));
        // An unmapped product can still be given a seat - core only refuses that
        // at order-create time, and submitOrder() assigns those seats in a
        // follow-up /change/ instead (see splitCartForSubmit()).
        if (sellSeats.length) row.appendChild(seatOverrideButton(item, null));
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
            var already = cartCountFor(itemId, variationId);
            if (already >= getAvailableCount(seId, itemId, variationId)) return;
            cart.push({itemId: itemId, variationId: variationId, seatGuid: null, price: price, subeventId: seId});
        } else {
            var idx = cart.findIndex(function (c) {
                return c.itemId === itemId && c.variationId === (variationId || null) && !c.seatGuid && c.subeventId === seId;
            });
            if (idx >= 0) cart.splice(idx, 1);
        }
        loadQuotas().then(function () {
            renderSellItems();
            renderCart();
        });
    }

    // What a click on this seat should book, or null when nothing can be
    // resolved without staff saying so. The override wins when set; otherwise
    // the seat's own category decides, which is the only answer that can't be
    // wrong.
    function seatTargetFor(seat) {
        if (seatOverride) return seatOverride;
        if (seat.product_id == null) return null;
        var item = itemsById[seat.product_id];
        if (!item) return null;
        // Mapped to a product with variations: the category says which product,
        // not which variant, so this needs the override to be unambiguous.
        if (item.has_variations) return null;
        return {itemId: seat.product_id, variationId: null};
    }

    function seatRefusalMessage(seat) {
        if (seat.product_id == null) {
            return gettext("This seat's category has no product mapped to it - choose a product with \u201cSeat this product\u201d first.");
        }
        var item = itemsById[seat.product_id];
        if (item && item.has_variations) {
            return interpolate(
                gettext("%(name)s has variants, so a seat can't tell which one - pick the variant with \u201cSeat this product\u201d first."),
                {name: pickI18n(item.name)}, true
            );
        }
        return gettext("This seat can't be booked from here.");
    }

    function renderOverrideBanner() {
        seatOverrideEl.innerHTML = "";
        seatOverrideEl.hidden = !seatOverride;
        if (!seatOverride) return;
        var item = itemsById[seatOverride.itemId];
        var name = item ? pickI18n(item.name) : "#" + seatOverride.itemId;
        if (seatOverride.variationId && item) {
            var v = (item.variations || []).find(function (x) { return x.id === seatOverride.variationId; });
            if (v) name += " – " + pickI18n(v.value);
        }
        var text = document.createElement("span");
        text.textContent = interpolate(gettext("Placing: %(name)s - the seating plan's own mapping is ignored"), {name: name}, true);
        seatOverrideEl.appendChild(text);

        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = gettext("Back to the mapping");
        cancel.addEventListener("click", function () {
            seatOverride = null;
            setMsg(seatpickMsg, "", null);
            renderSellItems();
        });
        seatOverrideEl.appendChild(cancel);
    }

    function renderSeatpick() {
        if (!sellSeats.length || !window.PretixSeatingRenderer) {
            seatpickWrap.hidden = true;
            return;
        }
        seatpickWrap.hidden = false;
        svgSell.setAttribute("tabindex", "0");
        clearSellSeatsBtn.disabled = !cart.some(function (c) {
            return c.seatGuid && c.subeventId === currentSubeventId();
        });
        renderOverrideBanner();
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
                setMsg(seatpickMsg, "", null);
            } else {
                if (s.status !== "free") return;
                var target = seatTargetFor(s);
                if (!target) {
                    // Saying why beats a dead seat: without this the click just
                    // does nothing and there's no way to guess what's missing.
                    setMsg(seatpickMsg, seatRefusalMessage(s), "error");
                    return;
                }
                if (!canAddSeatTarget(seId, target.itemId, target.variationId || null)) {
                    setMsg(seatpickMsg, gettext("No free seats left for this item/date."), "error");
                    return;
                }
                setMsg(seatpickMsg, "", null);
                var label = [s.zone, s.row_label, s.seat_label].filter(Boolean).join(" / ") || s.guid;
                cart.push({
                    itemId: target.itemId, variationId: target.variationId || null, seatGuid: s.guid,
                    price: priceFor(target.itemId, target.variationId || null, seId),
                    seatLabel: label, subeventId: seId,
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
        switchToFindOrderTab(seat.order_code);
    });

    // Sell/Reserve uses the same rectangle gesture as the order editor, but
    // commits its selection straight into the local cart. drawSeats supplies
    // ordinary per-seat clicks; intercept the synthetic click after a drag so
    // it cannot also toggle the seat where the drag happened to start.
    var sellSeatDrag = null;
    var suppressSellSeatClick = false;
    var SELL_DRAG_THRESHOLD = 4;

    function sellSvgPoint(e) {
        var pt = svgSell.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        return pt.matrixTransform(svgSell.getScreenCTM().inverse());
    }

    function sellSeatAtEvent(e) {
        var el = e.target.closest && e.target.closest("[data-guid]");
        return el && sellSeats.find(function (s) { return s.guid === el.getAttribute("data-guid"); });
    }

    function addSeatToCart(seat, target, subeventId) {
        var label = [seat.zone, seat.row_label, seat.seat_label].filter(Boolean).join(" / ") || seat.guid;
        cart.push({
            itemId: target.itemId, variationId: target.variationId || null, seatGuid: seat.guid,
            price: priceFor(target.itemId, target.variationId || null, subeventId),
            seatLabel: label, subeventId: subeventId,
        });
    }

    function clearSellSeatsForCurrentDate() {
        var seId = currentSubeventId();
        var before = cart.length;
        cart = cart.filter(function (c) { return !c.seatGuid || c.subeventId !== seId; });
        var removed = before - cart.length;
        if (!removed) return;
        renderSeatpick();
        renderSellItems();
        renderCart();
        setMsg(seatpickMsg, interpolate(
            ngettext("Cleared %(count)s selected seat.", "Cleared %(count)s selected seats.", removed),
            {count: removed}, true
        ), "success");
    }

    clearSellSeatsBtn.addEventListener("click", clearSellSeatsForCurrentDate);
    svgSell.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        clearSellSeatsForCurrentDate();
    });

    svgSell.addEventListener("click", function (e) {
        if (!suppressSellSeatClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    svgSell.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        svgSell.focus();
        sellSeatDrag = {start: sellSvgPoint(e), moved: false, rect: null};
        e.preventDefault();
    });

    svgSell.addEventListener("mousemove", function (e) {
        if (!sellSeatDrag) return;
        var pt = sellSvgPoint(e);
        var dx = pt.x - sellSeatDrag.start.x, dy = pt.y - sellSeatDrag.start.y;
        if (!sellSeatDrag.moved && Math.sqrt(dx * dx + dy * dy) < SELL_DRAG_THRESHOLD) return;
        sellSeatDrag.moved = true;
        if (!sellSeatDrag.rect) {
            sellSeatDrag.rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            sellSeatDrag.rect.setAttribute("class", "pos-seat-select-rect");
            sellSeatDrag.rect.setAttribute("pointer-events", "none");
            svgSell.appendChild(sellSeatDrag.rect);
        }
        sellSeatDrag.rect.setAttribute("x", Math.min(sellSeatDrag.start.x, pt.x));
        sellSeatDrag.rect.setAttribute("y", Math.min(sellSeatDrag.start.y, pt.y));
        sellSeatDrag.rect.setAttribute("width", Math.abs(pt.x - sellSeatDrag.start.x));
        sellSeatDrag.rect.setAttribute("height", Math.abs(pt.y - sellSeatDrag.start.y));
    });

    window.addEventListener("mouseup", function (e) {
        if (!sellSeatDrag) return;
        var drag = sellSeatDrag;
        sellSeatDrag = null;
        if (!drag.moved) return;
        if (drag.rect) drag.rect.remove();
        suppressSellSeatClick = true;
        window.setTimeout(function () { suppressSellSeatClick = false; }, 0);

        var pt = sellSvgPoint(e);
        var x0 = Math.min(drag.start.x, pt.x), x1 = Math.max(drag.start.x, pt.x);
        var y0 = Math.min(drag.start.y, pt.y), y1 = Math.max(drag.start.y, pt.y);
        var seId = currentSubeventId();
        var added = 0, removed = 0, skipped = 0;
        var removing = e.altKey;
        sellSeats
            .filter(function (seat) {
                return seat.x != null && seat.y != null &&
                    seat.x >= x0 && seat.x <= x1 && seat.y >= y0 && seat.y <= y1;
            })
            .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); })
            .forEach(function (seat) {
                var alreadyInCart = cart.some(function (c) {
                    return c.seatGuid === seat.guid && c.subeventId === seId;
                });
                if (removing) {
                    if (!alreadyInCart) {
                        skipped += 1;
                        return;
                    }
                    cart = cart.filter(function (c) {
                        return c.seatGuid !== seat.guid || c.subeventId !== seId;
                    });
                    removed += 1;
                    return;
                }
                if (seat.status !== "free" || alreadyInCart) {
                    skipped += 1;
                    return;
                }
                var target = seatTargetFor(seat);
                if (!target || !canAddSeatTarget(seId, target.itemId, target.variationId || null)) {
                    skipped += 1;
                    return;
                }
                addSeatToCart(seat, target, seId);
                added += 1;
            });
        if (added || removed) {
            renderSeatpick();
            renderSellItems();
            renderCart();
        }
        if (added || removed || skipped) {
            var message = interpolate(
                removing
                    ? ngettext("Removed %(count)s seat.", "Removed %(count)s seats.", removed)
                    : ngettext("Added %(count)s seat.", "Added %(count)s seats.", added),
                {count: removing ? removed : added}, true
            );
            if (skipped) {
                message += " " + interpolate(
                    ngettext("Skipped %(count)s seat.", "Skipped %(count)s seats.", skipped),
                    {count: skipped}, true
                );
            }
            setMsg(seatpickMsg, message, skipped ? "error" : "success");
        }
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

    // Whether the order-create endpoint will accept a seat for this product on
    // this date at all. It doesn't check *which* category the seat belongs to,
    // only that the product has some mapping for the date (see
    // OrderCreateSerializer) - so an overridden seat is fine as long as the
    // product is mapped somewhere on the plan.
    function createAcceptsSeat(itemId, subeventId) {
        // A date's own seat_category_mapping (see loadSubevents) is the
        // authoritative answer where there is one. An event without subevents has
        // no subevent to carry it, so there the cached seatmap for that date is
        // the only statement of which products the plan covers.
        if (subeventId != null && subeventSeatedItems[subeventId]) {
            return !!subeventSeatedItems[subeventId][itemId];
        }
        var seats = seatmapsBySubevent[subeventId != null ? String(subeventId) : "null"];
        return !!(seats && seats.some(function (s) { return s.product_id === itemId; }));
    }

    // Splits what the cart asks for into what one POST /orders/ can do and what
    // has to follow in a /change/ call. A product the plan maps nowhere is
    // refused a seat at order-create time outright, but change_seat() checks no
    // mapping at all, so those positions are created seatless and seated
    // immediately afterwards - the same shape Quick reservation and
    // addPositionsToOrder() already uses to get past this check.
    function splitCartForSubmit(positions) {
        var deferred = [];
        positions.forEach(function (p, idx) {
            if (!p.seat) return;
            if (createAcceptsSeat(p.item, p.subevent == null ? null : p.subevent)) return;
            deferred.push({index: idx, seat: p.seat});
            delete p.seat;
        });
        return deferred;
    }

    // Assigns the seats that couldn't ride along on the order itself, in a
    // single batched commit. Positions come back in the order they were
    // submitted, which is what lets a deferred line find its own position.
    function seatDeferredPositions(order, deferred) {
        var created = order.positions || [];
        var patches = deferred
            .filter(function (d) { return created[d.index]; })
            .map(function (d) { return {position: created[d.index].id, body: {seat: d.seat}}; });
        if (patches.length !== deferred.length) {
            return Promise.resolve(gettext("Could not match every seat to its position - assign the missing ones in the Edit order tab."));
        }
        return api(eventPath("/orders/" + encodeURIComponent(order.code) + "/change/"), {
            method: "POST",
            body: JSON.stringify({send_email: false, patch_positions: patches}),
        }).then(function (res) {
            if (res.ok) return null;
            return interpolate(
                gettext("The order was created, but %(count)s seat(s) could not be assigned (%(error)s) - finish it in the Edit order tab."),
                {count: patches.length, error: describeError(res.data)},
                true
            );
        });
    }

    function sellOrderSearchQuery() {
        return emailInput.value.trim() || nameInput.value.trim();
    }

    function renderSellOrderChoice() {
        sellOrderChoiceEl.innerHTML = "";
        if (sellOrderSearchPending) {
            sellOrderChoiceEl.textContent = gettext("Searching existing reservations…");
            sellOrderChoiceEl.hidden = false;
            return;
        }
        if (sellOrderSearchFailed) {
            sellOrderChoiceEl.textContent = gettext("Couldn't check existing reservations. Try again before reserving.");
            sellOrderChoiceEl.hidden = false;
            return;
        }
        if (sellOrderDecision) {
            var selected = document.createElement("p");
            if (sellOrderDecision.type === "existing") {
                selected.appendChild(document.createTextNode(gettext("Will add the selected tickets to order ")));
                var code = document.createElement("span");
                code.className = "pos-order-code";
                code.textContent = sellOrderDecision.order.code;
                selected.appendChild(code);
                selected.appendChild(document.createTextNode(". " + gettext("The customer details on that order will not be changed.")));
            } else {
                selected.textContent = gettext("Will create a new order.");
            }
            sellOrderChoiceEl.appendChild(selected);
            var change = document.createElement("button");
            change.type = "button";
            change.textContent = gettext("Change");
            change.addEventListener("click", function () {
                sellOrderDecision = null;
                renderSellOrderChoice();
            });
            sellOrderChoiceEl.appendChild(change);
            sellOrderChoiceEl.hidden = false;
            return;
        }
        if (!sellOrderCandidates.length) {
            sellOrderChoiceEl.hidden = true;
            return;
        }
        var prompt = document.createElement("p");
        prompt.textContent = gettext("Matching orders found. Choose what to do:");
        sellOrderChoiceEl.appendChild(prompt);
        var newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.textContent = gettext("Create a new order");
        newBtn.addEventListener("click", function () {
            sellOrderDecision = {type: "new"};
            renderSellOrderChoice();
        });
        sellOrderChoiceEl.appendChild(newBtn);
        sellOrderCandidates.forEach(function (order) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pos-btn-primary";
            btn.textContent = interpolate(gettext("Add to %(code)s (%(customer)s, %(count)s tickets, %(status)s)"), {
                code: order.code,
                customer: orderCustomerLabel(order),
                count: quickOrderPositionCount(order),
                status: order.status === "p" ? gettext("paid") : gettext("pending"),
            }, true);
            btn.addEventListener("click", function () {
                sellOrderDecision = {type: "existing", order: order};
                renderSellOrderChoice();
            });
            sellOrderChoiceEl.appendChild(btn);
        });
        sellOrderChoiceEl.hidden = false;
    }

    function searchSellOrders() {
        var query = sellOrderSearchQuery();
        var request = ++sellOrderSearchRequest;
        sellOrderSearchPending = false;
        sellOrderSearchFailed = false;
        sellOrderCandidates = [];
        if (query.length < 3) {
            renderSellOrderChoice();
            return;
        }
        sellOrderSearchPending = true;
        renderSellOrderChoice();
        api(eventPath("/orders/?search=" + encodeURIComponent(query) + "&ordering=-datetime")).then(function (res) {
            if (request !== sellOrderSearchRequest) return;
            sellOrderSearchPending = false;
            if (!res.ok) {
                sellOrderSearchFailed = true;
                renderSellOrderChoice();
                return;
            }
            sellOrderCandidates = ((res.data && res.data.results) || []).filter(function (order) {
                return order.status === "n" || order.status === "p";
            });
            renderSellOrderChoice();
        });
    }

    function scheduleSellOrderSearch() {
        sellOrderDecision = null;
        sellOrderSearchFailed = false;
        if (sellOrderSearchTimer) window.clearTimeout(sellOrderSearchTimer);
        sellOrderSearchTimer = window.setTimeout(searchSellOrders, 250);
    }

    emailInput.addEventListener("input", scheduleSellOrderSearch);
    nameInput.addEventListener("input", scheduleSellOrderSearch);

    // This follows Sell now's existing semantics: even a QR-labelled till sale
    // is recorded as a completed box-office payment. The important difference
    // from payOrder() in Edit order is deliberate: that screen's QR workflow
    // waits for a bank transfer, while Sell now must finish the sale now.
    function sellExistingOrder(order, method) {
        if (!orderIsSeated(order)) {
            return Promise.resolve({error: gettext("This order still needs seats before it can be sold.")});
        }
        var amount = pendingSum(order);
        // Free VIP positions and other zero-price changes leave a paid order
        // with no difference to collect. It is already settled, so adding a
        // zero-amount payment would be misleading and may be rejected by a
        // payment provider.
        if (parseFloat(amount) <= 0) return Promise.resolve({order: order});
        var pendingPayments = (order.payments || []).filter(function (p) {
            return p.state === "created" || p.state === "pending";
        });
        return Promise.all(pendingPayments.map(function (p) {
            return api(eventPath("/orders/" + order.code + "/payments/" + p.local_id + "/cancel/"), {method: "POST"});
        })).then(function (cancellations) {
            var failed = cancellations.find(function (res) { return !res.ok; });
            if (failed) return {error: describeError(failed.data)};
            return api(eventPath("/orders/" + order.code + "/payments/"), {
                method: "POST",
                body: JSON.stringify({provider: "boxoffice", amount: amount, state: "created", info: {payment_type: method}}),
            }).then(function (res) {
                if (!res.ok) return {error: describeError(res.data)};
                return api(eventPath("/orders/" + order.code + "/payments/" + res.data.local_id + "/confirm/"), {method: "POST"});
            }).then(function (res) {
                if (!res || !res.ok) return {error: res ? describeError(res.data) : gettext("Unknown error.")};
                addToTill(method, amount);
                return api(eventPath("/orders/" + encodeURIComponent(order.code) + "/")).then(function (updated) {
                    return updated.ok ? {order: updated.data} : {error: describeError(updated.data)};
                });
            });
        });
    }

    function submitToExistingOrder(mode, selectedOrder, positions, method) {
        return api(eventPath("/orders/" + encodeURIComponent(selectedOrder.code) + "/")).then(function (res) {
            if (!res.ok) return {error: describeError(res.data)};
            if (!orderCapabilities(res.data).structural) {
                return {error: gettext("This order can no longer be changed here. Open it in Edit order to handle it.")};
            }
            if (mode === "reserve" && !canReserveIntoPaidOrder(res.data, positions)) {
                return {error: gettext("Create a new reservation for the additional tickets.")};
            }
            if (!confirmStructuralChange(res.data, positionsPrice(positions))) {
                return {error: gettext("Order change canceled.")};
            }
            return addQuickPositionsToOrder(res.data, positions).then(function (result) {
                if (result.error) return result;
                result.positionsAdded = true;
                if (mode === "reserve") return result;
                return sellExistingOrder(result.order, method).then(function (sale) {
                    sale.positionsAdded = true;
                    if (sale.error) return sale;
                    sale.releaseFailed = result.releaseFailed;
                    return sale;
                });
            });
        });
    }

    function setSellOrderSuccess(order, mode, problem) {
        sellMsg.innerHTML = "";
        sellMsg.className = "pos-msg " + (problem ? "pos-error" : "pos-success");
        sellMsg.appendChild(document.createTextNode(
            mode === "sell" ? gettext("Sold — order ") : gettext("Reserved — order ")
        ));
        var link = document.createElement("a");
        link.href = "#";
        link.textContent = order.code;
        link.addEventListener("click", function (e) {
            e.preventDefault();
            switchToFindOrderTab(order.code);
        });
        sellMsg.appendChild(link);
        sellMsg.appendChild(document.createTextNode(
            interpolate(gettext(", total %(total)s."), {total: order.total}, true) + (problem ? " " + problem : "")
        ));
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
        if (!testmodeKnown) {
            setMsg(sellMsg, gettext("Can't reach the server to check whether this event is in test mode - reload the page before selling."), "error");
            return;
        }
        if (sellOrderSearchPending) {
            setMsg(sellMsg, gettext("Wait for the existing-reservation search before reserving."), "error");
            return;
        }
        if (sellOrderSearchFailed) {
            setMsg(sellMsg, gettext("Couldn't check existing reservations. Correct the customer details or try again."), "error");
            return;
        }
        if (sellOrderCandidates.length && !sellOrderDecision) {
            setMsg(sellMsg, gettext("Choose whether to create a new reservation or add to an existing one."), "error");
            return;
        }
        var method = paymentMethodSelect.value;
        btnReserve.disabled = true;
        btnSell.disabled = true;
        setMsg(sellMsg, gettext("Submitting…"), null);
        var existing = sellOrderDecision && sellOrderDecision.type === "existing" ? sellOrderDecision.order : null;
        if (existing) {
            submitToExistingOrder(mode, existing, positions, method).then(function (result) {
                if (result.error) {
                    setMsg(sellMsg, result.error, "error");
                    // Adding positions succeeded before a later payment/seating
                    // step failed. Do not leave the same cart ready to be sent
                    // again, or a retry would duplicate those tickets.
                    if (result.positionsAdded) {
                        cart = [];
                        seatOverride = null;
                    }
                    renderSellItems();
                    renderCart();
                    return;
                }
                setSellOrderSuccess(result.order, mode, result.releaseFailed
                    ? gettext("Some temporary seats could not be released. Check the order in Edit order.")
                    : null);
                cart = [];
                seatOverride = null;
                emailInput.value = "";
                nameInput.value = "";
                sellOrderCandidates = [];
                sellOrderDecision = null;
                renderSellOrderChoice();
                renderSellItems();
                renderCart();
                refreshCurrentView();
            });
            return;
        }
        // Strips the seats the create endpoint would refuse and remembers them
        // for the follow-up call below.
        var deferredSeats = splitCartForSubmit(positions);
        var body = {status: mode === "sell" ? "p" : "n", positions: positions, testmode: !!state.event.testmode};
        if (SALES_CHANNEL) body.sales_channel = SALES_CHANNEL;
        if (email) body.email = email;
        if (mode === "reserve") body.send_email = !!email;
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
            var seatingDone = deferredSeats.length
                ? seatDeferredPositions(res.data, deferredSeats)
                : Promise.resolve(null);
            seatingDone.then(function (problem) {
                // The order exists either way - a seat that couldn't be placed
                // is a leftover to finish in Edit order, not a failed sale, and
                // saying so beats a bare success message that hides it.
                setSellOrderSuccess(res.data, mode, problem);
                refreshCurrentView();
            });
            if (mode === "sell") addToTill(method, res.data.total);
            cart = [];
            seatOverride = null;
            emailInput.value = "";
            nameInput.value = "";
            renderCart();
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
    var quickOrderChoiceEl = document.getElementById("pos-quick-order-choice");
    var quickOrderCandidates = [];
    var quickOrderDecision = null;
    var quickOrderSearchTimer = null;
    var quickOrderSearchRequest = 0;
    var quickOrderSearchPending = false;
    var quickOrderSearchFailed = false;

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

    function loadQuickReservationTab(render) {
        if (render !== false) renderQuickReservationTab();
        return Promise.resolve();
    }

    function renderQuickReservationTab() {
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
                dateTd.textContent = formatSubeventLabel(se);
                tr.appendChild(dateTd);
            }
            units.forEach(function (u) {
                var td = document.createElement("td");
                var disabledMap = subeventDisabled[seId] || {items: {}, variations: {}};
                var availableCount = getAvailableCount(seId, u.itemId, u.variationId);
                var disabled = (u.variationId ? disabledMap.variations[u.variationId] : disabledMap.items[u.itemId]) ||
                    !isAvailableAt(seId, u.itemId, u.variationId) || availableCount <= 0;
                if (disabled) {
                    td.className = "pos-quick-cell-disabled";
                    td.textContent = "—";
                } else {
                    var input = document.createElement("input");
                    input.type = "number";
                    input.min = "0";
                    input.value = "0";
                    input.className = "pos-quick-qty";
                    input.max = availableCount;
                    input.dataset.itemId = u.itemId;
                    if (u.variationId) input.dataset.variationId = u.variationId;
                    if (seId != null) input.dataset.subeventId = seId;
                    td.appendChild(buildQtyStepper(input));
                    var price = document.createElement("span");
                    price.className = "pos-quick-price";
                    price.textContent = fmtMoney(priceFor(u.itemId, u.variationId, seId));
                    td.appendChild(price);
                    var avail = document.createElement("span");
                    avail.className = "pos-quick-available";
                    var availCount = getAvailableCount(seId, u.itemId, u.variationId);
                    avail.textContent = "(" + availCount + ")";
                    td.appendChild(avail);
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        quickTableEl.appendChild(table);
    }

    // Same -/+ stepper the shop frontend puts around its quantity fields
    // (core's .input-item-count-group): the native number spinners are far
    // too small to hit reliably at a till, especially on a touchscreen.
    function buildQtyStepper(input) {
        var group = document.createElement("div");
        group.className = "pos-qty-group";
        group.appendChild(qtyStepButton(-1, "−", gettext("Decrease quantity")));
        group.appendChild(input);
        group.appendChild(qtyStepButton(1, "+", gettext("Increase quantity")));
        return group;
    }

    function qtyStepButton(step, label, ariaLabel) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pos-qty-btn " + (step < 0 ? "pos-qty-dec" : "pos-qty-inc");
        btn.dataset.step = step;
        btn.textContent = label;
        btn.setAttribute("aria-label", ariaLabel);
        return btn;
    }

    // Delegated so it survives renderQuickTable() rebuilding the whole table.
    quickTableEl.addEventListener("click", function (e) {
        var btn = e.target.closest(".pos-qty-btn");
        if (!btn) return;
        var input = btn.parentNode.querySelector(".pos-quick-qty");
        if (!input) return;
        var step = parseInt(btn.dataset.step, 10);
        var min = parseInt(input.min, 10) || 0;
        var next = (parseInt(input.value, 10) || 0) + step;
        input.value = Math.max(min, input.max ? Math.min(parseInt(input.max, 10), next) : next);
        input.dispatchEvent(new Event("change", {bubbles: true}));
    });

    quickTableEl.addEventListener("change", function (e) {
        if (!e.target.classList.contains("pos-quick-qty")) return;
        var max = parseInt(e.target.max, 10);
        if (!isNaN(max)) e.target.value = Math.max(0, Math.min(max, parseInt(e.target.value, 10) || 0));
    });

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
            return loadSeatmap(seId).then(function (seats) {
                var freeByItem = {};
                seats.forEach(function (s) {
                    if (s.status !== "free") return;
                    (freeByItem[s.product_id] = freeByItem[s.product_id] || []).push(s.guid);
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

    // The order-change endpoint accepts all new positions in one batch, just
    // like the Sell/Reserve tab. Keep Quick reservation's seat workaround in
    // this shared-shaped helper too: a customer-choice seatmap needs temporary
    // seats for the API validation, then returns the new positions to the
    // ordinary "needs seating" queue.
    function addQuickPositionsToOrder(order, positions) {
        var changePath = eventPath("/orders/" + encodeURIComponent(order.code) + "/change/");
        var beforeIds = (order.positions || []).map(function (p) { return p.id; });
        function submitCreate(createPositions) {
            return api(changePath, {
                method: "POST",
                body: JSON.stringify({create_positions: createPositions, send_email: !!order.email}),
            });
        }
        return submitCreate(positions).then(function (res) {
            if (res.ok) return {order: res.data};
            if (!(res.data && res.data.seat)) return {error: describeError(res.data)};
            return assignQuickSeats(positions).then(function (enough) {
                if (!enough) {
                    return {error: gettext("Not enough free seats left for one of these dates/items - try a smaller quantity.")};
                }
                return submitCreate(positions).then(function (res2) {
                    if (!res2.ok) return {error: describeError(res2.data)};
                    var added = (res2.data.positions || []).filter(function (p) {
                        return beforeIds.indexOf(p.id) === -1;
                    });
                    return releaseQuickSeats(added).then(function (allReleased) {
                        return {order: res2.data, releaseFailed: !allReleased};
                    });
                });
            });
        });
    }

    function quickOrderSearchQuery() {
        // E-mail is the more precise identifier. A name remains useful for
        // phone reservations without an e-mail address.
        return quickEmailInput.value.trim() || quickNameInput.value.trim();
    }

    function quickOrderPositionCount(order) {
        return (order.positions || []).filter(function (p) { return !p.canceled; }).length;
    }

    function renderQuickOrderChoice() {
        quickOrderChoiceEl.innerHTML = "";
        if (quickOrderSearchPending) {
            quickOrderChoiceEl.textContent = gettext("Searching existing reservations…");
            quickOrderChoiceEl.hidden = false;
            return;
        }
        if (quickOrderSearchFailed) {
            quickOrderChoiceEl.textContent = gettext("Couldn't check existing reservations. Try again before reserving.");
            quickOrderChoiceEl.hidden = false;
            return;
        }
        if (quickOrderDecision) {
            var selected = document.createElement("p");
            if (quickOrderDecision.type === "existing") {
                selected.appendChild(document.createTextNode(gettext("Will add the selected tickets to order ")));
                var code = document.createElement("span");
                code.className = "pos-order-code";
                code.textContent = quickOrderDecision.order.code;
                selected.appendChild(code);
                selected.appendChild(document.createTextNode(". " + gettext("The customer details on that order will not be changed.")));
            } else {
                selected.textContent = gettext("Will create a new reservation.");
            }
            quickOrderChoiceEl.appendChild(selected);
            var change = document.createElement("button");
            change.type = "button";
            change.textContent = gettext("Change");
            change.addEventListener("click", function () {
                quickOrderDecision = null;
                renderQuickOrderChoice();
            });
            quickOrderChoiceEl.appendChild(change);
            quickOrderChoiceEl.hidden = false;
            return;
        }
        if (!quickOrderCandidates.length) {
            quickOrderChoiceEl.hidden = true;
            return;
        }
        var prompt = document.createElement("p");
        prompt.textContent = gettext("Matching orders found. Choose what to do:");
        quickOrderChoiceEl.appendChild(prompt);
        var newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.textContent = gettext("Create a new reservation");
        newBtn.addEventListener("click", function () {
            quickOrderDecision = {type: "new"};
            renderQuickOrderChoice();
        });
        quickOrderChoiceEl.appendChild(newBtn);
        quickOrderCandidates.forEach(function (order) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pos-btn-primary";
            btn.textContent = interpolate(gettext("Add to %(code)s (%(customer)s, %(count)s tickets, %(status)s)"), {
                code: order.code,
                customer: orderCustomerLabel(order),
                count: quickOrderPositionCount(order),
                status: order.status === "p" ? gettext("paid") : gettext("pending"),
            }, true);
            btn.addEventListener("click", function () {
                quickOrderDecision = {type: "existing", order: order};
                renderQuickOrderChoice();
            });
            quickOrderChoiceEl.appendChild(btn);
        });
        quickOrderChoiceEl.hidden = false;
    }

    function searchQuickOrders() {
        var query = quickOrderSearchQuery();
        var request = ++quickOrderSearchRequest;
        quickOrderSearchPending = false;
        quickOrderSearchFailed = false;
        quickOrderCandidates = [];
        if (query.length < 3) {
            renderQuickOrderChoice();
            return;
        }
        quickOrderSearchPending = true;
        renderQuickOrderChoice();
        api(eventPath("/orders/?search=" + encodeURIComponent(query) + "&ordering=-datetime")).then(function (res) {
            if (request !== quickOrderSearchRequest) return;
            quickOrderSearchPending = false;
            if (!res.ok) {
                quickOrderSearchFailed = true;
                renderQuickOrderChoice();
                return;
            }
            // A paid order may be extended too: Quick reservation sends its
            // normal order-change e-mail, and any resulting difference stays
            // due. Expired and canceled orders still have to be handled in
            // Edit order first.
            quickOrderCandidates = ((res.data && res.data.results) || []).filter(function (order) {
                return order.status === "n" || order.status === "p";
            });
            renderQuickOrderChoice();
        });
    }

    function scheduleQuickOrderSearch() {
        quickOrderDecision = null;
        quickOrderSearchFailed = false;
        if (quickOrderSearchTimer) window.clearTimeout(quickOrderSearchTimer);
        quickOrderSearchTimer = window.setTimeout(searchQuickOrders, 250);
    }

    quickEmailInput.addEventListener("input", scheduleQuickOrderSearch);
    quickNameInput.addEventListener("input", scheduleQuickOrderSearch);

    function setQuickOrderSuccess(result) {
        quickMsg.innerHTML = "";
        quickMsg.className = "pos-msg " + (result.releaseFailed ? "pos-error" : "pos-success");
        quickMsg.appendChild(document.createTextNode(gettext("Reserved — order ")));
        var link = document.createElement("a");
        link.href = "#";
        link.textContent = result.order.code;
        link.addEventListener("click", function (e) {
            e.preventDefault();
            switchToFindOrderTab(result.order.code);
        });
        quickMsg.appendChild(link);
        quickMsg.appendChild(document.createTextNode(
            result.releaseFailed
                ? interpolate(gettext(", total %(total)s - but couldn't release every placeholder seat, check the Edit order tab."), {total: result.order.total}, true)
                : interpolate(gettext(", total %(total)s."), {total: result.order.total}, true)
        ));
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
        if (!testmodeKnown) {
            setMsg(quickMsg, gettext("Can't reach the server to check whether this event is in test mode - reload the page before selling."), "error");
            return;
        }
        if (quickOrderSearchPending) {
            setMsg(quickMsg, gettext("Wait for the existing-reservation search before reserving."), "error");
            return;
        }
        if (quickOrderSearchFailed) {
            setMsg(quickMsg, gettext("Couldn't check existing reservations. Correct the customer details or try again."), "error");
            return;
        }
        if (quickOrderCandidates.length && !quickOrderDecision) {
            setMsg(quickMsg, gettext("Choose whether to create a new reservation or add to an existing one."), "error");
            return;
        }
        if (name) positions.forEach(function (p) { p.attendee_name = name; });
        quickBtnReserve.disabled = true;
        setMsg(quickMsg, gettext("Submitting…"), null);
        var existing = quickOrderDecision && quickOrderDecision.type === "existing" ? quickOrderDecision.order : null;
        var request;
        if (existing) {
            // Search results can be stale by the time the cashier presses
            // Reserve. Refetching verifies that it is still mutable and gives
            // us current position IDs for safe placeholder cleanup.
            request = api(eventPath("/orders/" + encodeURIComponent(existing.code) + "/")).then(function (res) {
                if (!res.ok) return {error: describeError(res.data)};
                if (res.data.status !== "n" && res.data.status !== "p") {
                    return {error: gettext("This order can no longer be changed here. Open it in Edit order to handle it.")};
                }
                if (!canReserveIntoPaidOrder(res.data, positions)) {
                    return {error: gettext("Create a new reservation for the additional tickets.")};
                }
                if (!confirmStructuralChange(res.data, positionsPrice(positions))) {
                    return {error: gettext("Order change canceled.")};
                }
                return addQuickPositionsToOrder(res.data, positions);
            });
        } else {
            var body = {status: "n", positions: positions, testmode: !!state.event.testmode};
            if (SALES_CHANNEL) body.sales_channel = SALES_CHANNEL;
            if (email) body.email = email;
            body.send_email = !!email;
            request = createQuickOrder(body, positions);
        }
        request.then(function (result) {
            quickBtnReserve.disabled = false;
            if (result.error) {
                setMsg(quickMsg, result.error, "error");
                return;
            }
            setQuickOrderSuccess(result);
            quickEmailInput.value = "";
            quickNameInput.value = "";
            quickOrderCandidates = [];
            quickOrderDecision = null;
            renderQuickOrderChoice();
            refreshCurrentView();
        });
    }

    quickBtnReserve.addEventListener("click", submitQuickReservation);

    // --------------------------------------------------------------- find tab

    var searchInput = document.getElementById("pos-search");
    var searchBtn = document.getElementById("pos-search-btn");
    var searchResultsEl = document.getElementById("pos-search-results");
    var orderDetailEl = document.getElementById("pos-order-detail");
    var orderPositionsWrapEl = document.getElementById("pos-order-positions");
    var orderSeatmapWrapEl = document.getElementById("pos-order-seatmap-wrap");
    var filterCurrentDateCheckbox = document.getElementById("pos-filter-current-date");
    var filterStatusSelect = document.getElementById("pos-filter-status");
    var filterPaymentSelect = document.getElementById("pos-filter-payment");
    var filterSeatingSelect = document.getElementById("pos-filter-seating");
    var filterExpirySelect = document.getElementById("pos-filter-expiry");
    var filterSourceSelect = document.getElementById("pos-filter-source");
    var orderOrderingSelect = document.getElementById("pos-ordering");
    var clearOrderFiltersBtn = document.getElementById("pos-clear-order-filters");
    var orderSummaryGeneration = 0;
    var orderSummaryLoading = false;
    var orderSummaryNext = null;
    var orderSummaryRefreshTimer = null;

    // Set by renderOrderDetail() (only while the loaded order is still "n"/pending),
    // kept at module level so seat placement/move/removal - all in initOrderSeatMap(),
    // a separate function - can re-enable "Take payment" without a full
    // loadOrderDetail() reload. null whenever no such button is currently on screen.
    var payBtn = null;
    var payMethodSelect = null;
    var seatHintEl = null;

    // Persistent containers inside orderDetailEl, created once per full
    // renderOrderDetail() (initial order load / date switch) and reused by
    // refreshOrderSummary() afterwards - refreshOrderSummary() only ever
    // clears/refills *their* contents, never orderDetailEl itself, so the
    // position list's own DOM node stays the exact one initOrderSeatMap()
    // already attached its "change" listener to (see positionListEl there).
    // Replacing it on every add/cancel/refund would silently stop checkbox
    // clicks from reaching the seatmap's "Place selected" button until the
    // next full reload.
    var orderHeaderEl = null;
    var orderTotalEl = null;
    var orderExpiryEl = null;
    var orderPaymentsEl = null;
    var orderCreditEl = null;
    var orderListEl = null;
    var orderPayBlockEl = null;
    var orderCancelBlockEl = null;

    // Set by initOrderSeatMap() to its own internal redraw function - lets
    // refreshOrderSummary() put the seatmap's colors back in sync with a
    // freshly-refetched currentOrder (a freed/consumed seat) without
    // re-fetching the whole seatmap from the API and rebuilding the SVG from
    // scratch, which is the slow, flashy part of a full reload and was
    // getting triggered on every single add/cancel click.
    var orderSeatmapRedraw = null;

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
        return loadOrderSummaries(q);
    }

    // Seat changes keep the open order local so that a large seating session
    // does not tear down and redraw its map after every click. The browse list
    // is a separate, aggregated representation, though, and must be reloaded
    // to pick up the changed needs_seating flag and therefore its color. Batch
    // placement calls applyPositionSeat once per position, hence the debounce.
    function scheduleOrderSummaryRefresh() {
        if (activeTab !== "find" || !state.event || !state.event.slug) return;
        if (orderSummaryRefreshTimer) clearTimeout(orderSummaryRefreshTimer);
        orderSummaryRefreshTimer = setTimeout(function () {
            orderSummaryRefreshTimer = null;
            loadOrderSummaries(searchInput.value.trim());
        }, 0);
    }

    function orderSummaryPath(query, page) {
        var path = "/" + encodeURIComponent(ORGANIZER) + "/pos/api/events/" +
            encodeURIComponent(state.event.slug) + "/orders/?ordering=" +
            encodeURIComponent(orderOrderingSelect.value) + "&page_size=50";
        if (query) path += "&q=" + encodeURIComponent(query);
        if (filterStatusSelect.value) path += "&status=" + encodeURIComponent(filterStatusSelect.value);
        if (filterPaymentSelect.value) path += "&payment=" + encodeURIComponent(filterPaymentSelect.value);
        if (filterSeatingSelect.value) path += "&seating=" + encodeURIComponent(filterSeatingSelect.value);
        if (filterExpirySelect.value) path += "&expiry=" + encodeURIComponent(filterExpirySelect.value);
        if (filterSourceSelect.value) path += "&source=" + encodeURIComponent(filterSourceSelect.value);
        if (page > 1) path += "&page=" + page;
        if (filterCurrentDateCheckbox.checked && currentSubeventId() != null) {
            path += "&subevent=" + encodeURIComponent(currentSubeventId());
        }
        return path;
    }

    function loadOrderSummaries(query, page, append) {
        page = page || 1;
        if (append && orderSummaryLoading) return;
        if (!append) {
            orderSummaryGeneration += 1;
            orderSummaryNext = null;
        }
        var generation = orderSummaryGeneration;
        orderSummaryLoading = true;
        // Keep the expanded order visible while its surrounding browse list
        // reloads. It owns the position-list and seatmap listeners, so
        // replacing it with a loading message would make editing flash and
        // would detach those listeners unnecessarily.
        if (!append && orderDetailEl.hidden) searchResultsEl.textContent = gettext("Loading…");
        return posApi(orderSummaryPath(query, page)).then(function (res) {
            if (generation !== orderSummaryGeneration) return;
            if (!res.ok) {
                searchResultsEl.textContent = describeError(res.data);
                return;
            }
            var data = res.data || {};
            var previousSentinel = searchResultsEl.querySelector(".pos-orders-sentinel");
            if (previousSentinel) previousSentinel.remove();
            renderSearchResults(data.results || [], !!append);
            if (data.next) {
                orderSummaryNext = {query: query, page: page + 1, generation: generation};
            }
        }).finally(function () {
            if (generation === orderSummaryGeneration) {
                orderSummaryLoading = false;
                maybeLoadMoreOrderSummaries();
            }
        });
    }

    function maybeLoadMoreOrderSummaries() {
        var next = orderSummaryNext;
        if (!next || next.generation !== orderSummaryGeneration || orderSummaryLoading) return;
        if (searchResultsEl.scrollTop + searchResultsEl.clientHeight < searchResultsEl.scrollHeight - 300) return;
        orderSummaryNext = null;
        loadOrderSummaries(next.query, next.page, true);
    }

    searchBtn.addEventListener("click", doSearch);
    searchInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    });
    filterCurrentDateCheckbox.addEventListener("change", doSearch);
    filterStatusSelect.addEventListener("change", doSearch);
    filterPaymentSelect.addEventListener("change", doSearch);
    filterSeatingSelect.addEventListener("change", doSearch);
    filterExpirySelect.addEventListener("change", doSearch);
    filterSourceSelect.addEventListener("change", doSearch);
    orderOrderingSelect.addEventListener("change", doSearch);
    clearOrderFiltersBtn.addEventListener("click", function () {
        searchInput.value = "";
        filterCurrentDateCheckbox.checked = false;
        filterStatusSelect.value = "";
        filterPaymentSelect.value = "";
        filterSeatingSelect.value = "";
        filterExpirySelect.value = "";
        filterSourceSelect.value = "";
        orderOrderingSelect.value = "-datetime";
        doSearch();
    });
    searchResultsEl.addEventListener("scroll", maybeLoadMoreOrderSummaries);

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

    // Whether o has an unseated position specifically on the date currently
    // selected in the bar at the top (the one whose seatmap is actually on
    // screen right now) - staff working that date's plan can seat this order
    // immediately, unlike one that needs a seat on some *other* date, so it's
    // worth its own top sort tier rather than lumping it in with "needs a
    // seat somewhere". Always false for an event without subevents (no
    // "current date" to be more specific than) or once nothing's selected.
    function orderNeedsSeatOnCurrentDate(o) {
        var seId = currentSubeventId();
        if (seId == null) return false;
        return (o.positions || []).some(function (p) {
            return !p.canceled && subeventsMatch(p.subevent, seId) && dateHasSeatingPlan(p.subevent) && !p.seat;
        });
    }

    function orderSortKey(o) {
        // A canceled order's positions are canceled right along with it, so
        // orderIsSeated()'s "every position has a seat" is vacuously true
        // over an empty list - without this check that made a canceled order
        // sort as if it were just another seated/pending order instead of
        // dropping to the very end, where nothing about it needs attention
        // anymore (a refund, if one's owed, is called out via pendingSum()
        // in renderSearchResults() instead).
        if (o.status === "c") return 5;
        if (orderNeedsSeatOnCurrentDate(o)) return 0;
        var needsSeat = !orderIsSeated(o);
        var unpaid = o.status !== "p";
        return 1 + (needsSeat ? 0 : 2) + (unpaid ? 0 : 1);
    }

    // Shown by default on the "Find order" tab (before any search) so staff
    // can browse rather than always having to know a code/name/e-mail
    // upfront - sorted with whatever most likely still needs attention first.
    function loadDefaultOrderList() {
        return loadOrderSummaries("");
    }

    // Customers without an e-mail are still identified by whatever name
    // submitOrder() attached to their positions (see the "reserve needs an
    // e-mail or a name" requirement) - shown here so staff can recognize a
    // no-email reservation by name at a glance, not just via search.
    function orderCustomerLabel(o) {
        if (o.email) return o.email;
        if (o.customer_name) return o.customer_name;
        var named = (o.positions || []).find(function (p) { return p.attendee_name; });
        return named ? named.attendee_name : gettext("no e-mail");
    }

    function renderSearchResults(orders, append) {
        var detailVisible = !orderDetailEl.hidden;
        if (!append) {
            // The detail is the expanded first tile of this same list. Detach
            // and put back the *same* DOM node, rather than rebuild it: its
            // seat-map handlers and staged selection then survive a list
            // refresh (including infinite scrolling and seat changes).
            if (detailVisible) orderDetailEl.remove();
            searchResultsEl.innerHTML = "";
        }
        var filtered = orders;
        if (!filtered.length && !append) {
            if (detailVisible) searchResultsEl.appendChild(orderDetailEl);
            searchResultsEl.appendChild(document.createTextNode(gettext("No matching orders.")));
            return;
        }
        if (!append && detailVisible) searchResultsEl.appendChild(orderDetailEl);
        filtered.forEach(function (o) {
            var div = document.createElement("div");
            // Canceled (grey, sorted last by orderSortKey()) takes priority
            // over the seated/paid coloring below - a canceled order's own
            // positions are canceled too, so "is it seated" no longer means
            // anything for it either way.
            var canceled = o.status === "c";
            var expired = o.status === "e";
            // Summary rows carry the same seat-category-mapping based answer
            // as POS needs here; no detailed position list is needed merely to
            // color an order.
            var seated = !o.needs_seating;
            div.className = "pos-search-result" +
                (canceled ? " pos-order-canceled" : expired ? " pos-order-expired" :
                    seated ? (o.status === "p" ? " pos-order-seated-paid" : " pos-order-seated-unpaid") : "") +
                (currentOrder && currentOrder.code === o.code ? " pos-search-result-selected" : "");
            div.dataset.orderCode = o.code;
            div.innerHTML = "<span class=\"pos-order-code\"></span>";
            div.querySelector(".pos-order-code").textContent = o.code;
            var pending = parseFloat(pendingSum(o));
            var line = " — " + orderCustomerLabel(o) + " — " + o.status + " — " +
                interpolate(gettext("total %(total)s"), {total: o.total}, true);
            if (o.sales_channel_identifier) {
                line += " — " + (o.sales_channel_identifier === SALES_CHANNEL
                    ? gettext("POS")
                    : gettext("other channel"));
            }
            if (pending > 0) {
                line += ", " + interpolate(gettext("pending %(amount)s"), {amount: pending.toFixed(2)}, true);
            } else if (pending < 0) {
                // Most often a canceled order that was already paid - core
                // never auto-refunds a manual/cash payment, so this is the
                // one place staff would otherwise have no way to notice a
                // refund is still owed without opening the order.
                line += ", " + interpolate(gettext("credit %(amount)s"), {amount: (-pending).toFixed(2)}, true);
            }
            div.appendChild(document.createTextNode(line));
            div.addEventListener("click", function () { loadOrderDetail(o.code); });
            searchResultsEl.appendChild(div);
        });
    }

    function markSelectedOrder() {
        Array.prototype.slice.call(searchResultsEl.querySelectorAll(".pos-search-result")).forEach(function (row) {
            row.classList.toggle("pos-search-result-selected", !!currentOrder && row.dataset.orderCode === currentOrder.code);
        });
    }

    function showOrderDetailInList() {
        if (!searchResultsEl.contains(orderDetailEl)) searchResultsEl.prepend(orderDetailEl);
        orderDetailEl.hidden = false;
    }

    function loadOrderDetail(code) {
        code = String(code);
        if (orderDetailLoad && orderDetailLoad.code === code) return orderDetailLoad.promise;

        var promise = api(eventPath("/orders/" + encodeURIComponent(code) + "/")).then(function (res) {
            if (!res.ok) {
                showOrderDetailInList();
                orderDetailEl.textContent = describeError(res.data);
                orderPositionsWrapEl.textContent = "";
                return;
            }
            currentOrder = res.data;
            placementPool = {};
            removalPool = {};
            showOrderDetailInList();
            markSelectedOrder();
            renderOrderDetail();
        });
        orderDetailLoad = {code: code, promise: promise};
        promise.then(function () {
            if (orderDetailLoad && orderDetailLoad.promise === promise) orderDetailLoad = null;
        }, function () {
            if (orderDetailLoad && orderDetailLoad.promise === promise) orderDetailLoad = null;
        });
        return promise;
    }

    // The public API's OrderSerializer has no pending_sum field (unlike the
    // internal Order model, which computes it server-side) - derive it the
    // same way Order.pending_sum does: total, minus what's actually been
    // paid (confirmed or since-refunded payments), plus whatever's already
    // been refunded back out. That last term is what makes this go negative
    // after a position is canceled on an already-paid order (a real credit
    // owed to the customer) instead of clamping at zero, and also what pulls
    // it back towards zero again once recordRefund() records the payout.
    function pendingSum(order) {
        if (order.pending_sum != null) return String(order.pending_sum);
        // A canceled order's own total (the model field, as returned by the
        // API) still shows whatever it was before cancellation - core's
        // Order.pending_sum property special-cases this to 0 for exactly
        // this calculation, since a canceled order owes nothing *itself*
        // anymore; skipping this made a canceled-but-paid order look like
        // pendingSum() was 0 (total == paid) instead of strongly negative
        // (the whole payment now owed back).
        var total = order.status === "c" ? 0 : parseFloat(order.total);
        var paid = (order.payments || [])
            .filter(function (p) { return p.state === "confirmed" || p.state === "refunded"; })
            .reduce(function (sum, p) { return sum + parseFloat(p.amount); }, 0);
        var refunded = (order.refunds || [])
            .filter(function (r) { return r.state === "done" || r.state === "transit" || r.state === "created"; })
            .reduce(function (sum, r) { return sum + parseFloat(r.amount); }, 0);
        return (total - paid + refunded).toFixed(2);
    }

    // Keep POS's editing rules in one place. `expires` deliberately is not
    // considered here: a pending order still holds capacity until core changes
    // its status to expired, so a passed payment deadline is not a reason to
    // make it read-only in the terminal.
    function orderCapabilities(order) {
        var live = order.status === "n" || order.status === "p";
        return {
            seats: live,
            structural: live,
            payment: order.status === "n",
            refund: live,
            cancel: live,
            extend: order.status === "n" || order.status === "e",
            restore: order.status === "e" || order.status === "c",
            online: order.sales_channel !== SALES_CHANNEL,
        };
    }

    function confirmStructuralChange(order, priceDelta) {
        var capabilities = orderCapabilities(order);
        if (!capabilities.structural) return false;
        // Seating is deliberately not routed through this function: moving a
        // customer to another chair changes neither their tickets nor money,
        // and is often done repeatedly while finding a suitable place.
        if (!capabilities.online && order.status !== "p") return true;

        var notices = [];
        if (capabilities.online) {
            notices.push(gettext("This order was created online. Check the price, payment status, and any invoice before continuing."));
        }
        if (order.status === "p") {
            notices.push(gettext("This order is already paid. Changing its tickets can create an amount due or a credit to refund."));
        }
        var message = notices.join("\n\n");
        if (priceDelta != null && !isNaN(priceDelta)) {
            message += "\n\n" + interpolate(
                priceDelta > 0
                    ? gettext("Tickets being changed now increase the total by %(amount)s.")
                    : priceDelta < 0
                    ? gettext("Tickets being changed now decrease the total by %(amount)s.")
                    : gettext("Tickets being changed now do not change the total."),
                {amount: fmtMoney(Math.abs(priceDelta))},
                true
            );
        }
        return window.confirm(message + "\n\n" + gettext("Continue with this order change?"));
    }

    function positionsPrice(positions) {
        return positions.reduce(function (sum, p) {
            return sum + parseFloat(priceFor(p.item, p.variation || null, p.subevent == null ? null : p.subevent));
        }, 0);
    }

    // Reserving a non-free addition would move the entire order back to
    // pending, including money which was already collected. A later expiry
    // would then expire that payment along with the new ticket, so require a
    // separate reservation instead. priceFor is also the price used by POS's
    // final cart total; POS deliberately has no vouchers, memberships, or
    // bundles that could make a zero-price addition differ server-side.
    function canReserveIntoPaidOrder(order, positions) {
        if (order.status !== "p" || Math.abs(positionsPrice(positions)) < 0.00001) return true;
        window.alert(gettext("A paid order cannot be extended with a new unpaid amount. Choose ‘create a new reservation’ for these tickets instead."));
        return false;
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

    // One <select> + "+" button, appending one new (unseated-for-now)
    // position for subeventId (null for an event without subevents) via
    // addPositionsToOrder() - reused for every group header below and for the
    // no-subevents case. Only lists items not disabled for that date (same
    // source as the Quick reservation table); renders nothing if there's
    // nothing addable there.
    function renderPositionAdder(subeventId) {
        var wrap = document.createElement("span");
        wrap.className = "pos-add-position";
        if (!currentOrder || !orderCapabilities(currentOrder).structural) return wrap;
        var disabledMap = subeventDisabled[subeventId] || {items: {}, variations: {}};
        var available = quickOrderableUnits().filter(function (u) {
            var disabled = u.variationId ? disabledMap.variations[u.variationId] : disabledMap.items[u.itemId];
            return !disabled && isAvailableAt(subeventId, u.itemId, u.variationId) &&
                getAvailableCount(subeventId, u.itemId, u.variationId) > 0;
        });
        if (!available.length) return wrap;

        var addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "pos-btn-add-position";
        addBtn.textContent = "+";
        addBtn.title = gettext("Add a ticket");
        var addMsg = document.createElement("div");
        addMsg.className = "pos-msg";

        var popup = null;
        function closePopup() {
            if (!popup) return;
            popup.remove();
            popup = null;
            document.removeEventListener("click", onOutsideClick, true);
        }
        function onOutsideClick(ev) {
            if (popup && !popup.contains(ev.target) && ev.target !== addBtn) closePopup();
        }
        function doAdd(u, count) {
            addPositionsToOrder(subeventId, u.itemId, u.variationId, count || 1, addBtn, addMsg);
        }

        // Only one real choice for this date - add it straight away, nothing
        // to disambiguate. With several, a popup (not a persistent <select>
        // sitting in the header at all times) keeps the item choice out of
        // the way until it's actually needed.
        addBtn.addEventListener("click", function () {
            if (popup) { closePopup(); return; }
            popup = document.createElement("div");
            popup.className = "pos-add-popup";
            var select = document.createElement("select");
            available.forEach(function (u) {
                var opt = document.createElement("option");
                opt.value = available.indexOf(u);
                opt.textContent = u.label;
                select.appendChild(opt);
            });
            var quantity = document.createElement("input");
            quantity.type = "number";
            quantity.min = "1";
            quantity.value = "1";
            quantity.className = "pos-add-quantity";
            function refreshQuantityLimit() {
                var selected = available[parseInt(select.value, 10) || 0];
                var max = getAvailableCount(subeventId, selected.itemId, selected.variationId);
                quantity.max = Math.max(1, max);
                if (parseInt(quantity.value, 10) > max) quantity.value = String(Math.max(1, max));
            }
            select.addEventListener("change", refreshQuantityLimit);
            refreshQuantityLimit();
            var confirm = document.createElement("button");
            confirm.type = "button";
            confirm.className = "pos-btn-primary";
            confirm.textContent = gettext("Add");
            confirm.addEventListener("click", function () {
                var count = Math.max(1, parseInt(quantity.value, 10) || 1);
                closePopup();
                doAdd(available[parseInt(select.value, 10) || 0], count);
            });
            popup.appendChild(select);
            popup.appendChild(quantity);
            popup.appendChild(confirm);
            popup.style.top = (addBtn.getBoundingClientRect().bottom + 4) + "px";
            popup.style.left = addBtn.getBoundingClientRect().left + "px";
            document.body.appendChild(popup);
            document.addEventListener("click", onOutsideClick, true);
        });
        wrap.appendChild(addBtn);
        wrap.appendChild(addMsg);
        return wrap;
    }

    // One position row: label, seat badge, cancel button. otherDate mirrors
    // the old flat list's meaning - a position for a date other than the one
    // currently on screen (no seatmap for it right now) shows as context but
    // can't be checked/placed from here.
    function renderPositionRow(pos, otherDate) {
        var row = document.createElement("div");
        row.className = "pos-position-row" + (otherDate ? " pos-position-row-other-date" : "");

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.positionId = pos.id;
        cb.disabled = otherDate || !orderCapabilities(currentOrder).seats;
        cb.checked = !otherDate && !pos.seat;
        row.appendChild(cb);

        var label = document.createElement("span");
        label.textContent = positionLabel(pos);
        row.appendChild(label);

        var badge = document.createElement("span");
        if (pos.seat) {
            badge.className = "pos-seat-badge";
            badge.textContent = pos.seat.name || pos.seat.seat_guid;
        } else {
            badge.className = "pos-seat-badge pos-seat-missing";
            badge.textContent = gettext("no seat");
        }
        row.appendChild(badge);

        if (orderCapabilities(currentOrder).structural) {
            var delMsg = document.createElement("div");
            delMsg.className = "pos-msg";
            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "pos-btn-icon pos-btn-icon-danger";
            delBtn.textContent = "×";
            delBtn.title = gettext("Cancel this position");
            delBtn.addEventListener("click", function () { deletePositionFromOrder(pos, delBtn, delMsg); });
            row.appendChild(delBtn);
            row.appendChild(delMsg);
        }

        return row;
    }

    // (Re)builds the position list into container from currentOrder.positions -
    // factored out so a seat placement/move can refresh just this list in
    // place (see applyPositionSeat()) instead of the whole order detail
    // having to be refetched and rebuilt from scratch.
    //
    // Grouped by date (one header per active subevent, each with its own "+"
    // adder) rather than a flat list - a date the order doesn't have any
    // positions on yet still gets a header, so staff can add the *first*
    // position for a date through the same control as any other, instead of
    // needing Quick reservation/Sell just because nothing's there yet. For
    // an event without subevents there's no grouping, just one adder.
    function renderPositionList(container) {
        container.innerHTML = "";
        var seId = currentSubeventId();
        var positions = (currentOrder.positions || []).filter(function (pos) { return !pos.canceled; });

        if (!state.event.hasSubevents) {
            positions.forEach(function (pos) {
                container.appendChild(renderPositionRow(pos, false));
            });
            container.appendChild(renderPositionAdder(null));
            return;
        }

        var bySubevent = {};
        positions.forEach(function (pos) {
            var key = String(pos.subevent);
            (bySubevent[key] = bySubevent[key] || []).push(pos);
        });

        subeventsList.forEach(function (se) {
            var key = String(se.id);
            var group = bySubevent[key] || [];
            delete bySubevent[key];

            var header = document.createElement("div");
            header.className = "pos-position-group-header";

            var dateLabel = document.createElement("span");
            dateLabel.className = "pos-seat-badge pos-date-badge";
            dateLabel.textContent = subeventLabel(se.id);
            dateLabel.title = gettext("Click to switch to this date's seating plan.");
            dateLabel.addEventListener("click", function () {
                subeventSelect.value = se.id;
                subeventSelect.dispatchEvent(new Event("change"));
            });
            header.appendChild(dateLabel);
            header.appendChild(renderPositionAdder(se.id));
            container.appendChild(header);

            group.forEach(function (pos) {
                container.appendChild(renderPositionRow(pos, !subeventsMatch(pos.subevent, seId)));
            });
        });

        // A position whose date isn't in subeventsList (an inactive/deleted
        // date) still needs to show up somewhere, just without a header/adder.
        Object.keys(bySubevent).forEach(function (key) {
            bySubevent[key].forEach(function (pos) {
                container.appendChild(renderPositionRow(pos, !subeventsMatch(pos.subevent, seId)));
            });
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
            // removalPool is keyed by seat guid, so this position moving (or
            // being cleared) leaves any staging on its old seat pointing at a
            // seat the order no longer holds: it would still paint with the red
            // "selected to clear" ring and still be counted in the button, but
            // resolve to no position when the button was pressed - promising to
            // clear more seats than it then cleared. Dropping it here covers
            // every path that can change a position's seat at once, single move
            // and Ctrl+drag block move alike.
            delete removalPool[oldGuid];
        }
        if (patchedSeat) {
            var newSeat = orderSeats.find(function (s) { return s.guid === patchedSeat.seat_guid; });
            if (newSeat) newSeat.status = "taken";
        }
        scheduleAvailabilityRefresh();
        scheduleOrderSummaryRefresh();
    }

    // Refills the persistent summary containers (see their declarations
    // above) from currentOrder - called both by renderOrderDetail() itself
    // (first paint for a newly loaded order / date switch) and by
    // refreshCurrentView() (after add/cancel/refund), without ever
    // touching orderDetailEl's own innerHTML or the seatmap. That's what
    // lets those actions restage the summary without redoing the expensive
    // part (refetch+redraw the whole seatmap) on every single click.
    function refreshOrderSummary() {
        var order = currentOrder;

        orderHeaderEl.textContent = order.code + " — " + orderCustomerLabel(order) + " — " + order.status;

        var pending = parseFloat(pendingSum(order));
        orderTotalEl.textContent = interpolate(gettext("Total: %(total)s"), {total: order.total}, true) + (
            pending > 0 ? interpolate(gettext(" — pending: %(amount)s"), {amount: pending.toFixed(2)}, true) :
            pending < 0 ? interpolate(gettext(" — credit owed to customer: %(amount)s"), {amount: (-pending).toFixed(2)}, true) :
            gettext(" — fully paid")
        );

        // When an unpaid reservation runs out. It belongs in the summary rather
        // than only next to the button that changes it: it decides whether the
        // customer on the phone still has their seats, so staff need to see it
        // while reading the order, not only when they're already fixing it.
        // Meaningless once an order is paid or canceled - core keeps the date on
        // the row either way, but nothing acts on it anymore.
        orderExpiryEl.innerHTML = "";
        if (orderCapabilities(order).online) {
            var sourceWarning = document.createElement("p");
            sourceWarning.className = "pos-msg pos-error";
            sourceWarning.textContent = gettext("Online order — changes affect the customer's existing order.");
            orderExpiryEl.appendChild(sourceWarning);
        }
        if (order.expires && (order.status === "n" || order.status === "e")) {
            var expiry = new Date(order.expires);
            var expired = order.status === "e";
            var overdue = order.status === "n" && expiry < new Date();
            var line = document.createElement("p");
            line.className = "pos-expiry" + (expired || overdue ? " pos-expiry-past" : "");
            line.textContent = expired
                ? interpolate(gettext("Expired %(date)s - the seats are no longer held"), {date: expiry.toLocaleString()}, true)
                : overdue
                ? interpolate(gettext("Payment deadline passed %(date)s - waiting to expire"), {date: expiry.toLocaleString()}, true)
                : interpolate(gettext("Valid until %(date)s"), {date: expiry.toLocaleString()}, true);
            orderExpiryEl.appendChild(line);
        }

        // How the money actually came in. Staff regularly need this after the
        // fact - to answer "did they pay me in cash?" at a shift handover, or
        // to know what to hand back before recording a refund - and until now
        // the terminal showed only whether an order was paid, never how.
        orderPaymentsEl.innerHTML = "";
        (order.payments || [])
            .filter(function (p) { return p.state === "confirmed"; })
            .forEach(function (p) {
                var line = document.createElement("p");
                line.className = "pos-paid-with";
                line.textContent = interpolate(
                    gettext("Paid %(amount)s by %(method)s on %(date)s"),
                    {
                        amount: fmtMoney(p.amount),
                        method: paymentMethodLabel(p),
                        date: p.payment_date ? new Date(p.payment_date).toLocaleString() : "?",
                    },
                    true
                );
                orderPaymentsEl.appendChild(line);
            });

        // A canceled position (or a lower price after an edit) on an
        // already-paid order doesn't trigger any refund on its own - core
        // only auto-reacts to a *higher* total on a paid order (flips it back
        // to pending, handled by the "Take payment" block below). A credit
        // is left sitting on the order until someone here explicitly decides
        // what to do with it - recordRefund() only ever runs on that explicit
        // click, never automatically.
        orderCreditEl.innerHTML = "";
        if (pending < 0 && orderCapabilities(order).refund) {
            var creditWrap = document.createElement("div");
            creditWrap.className = "pos-credit-banner";

            var creditBtn = document.createElement("button");
            creditBtn.type = "button";
            creditBtn.className = "pos-btn-secondary";
            creditBtn.textContent = gettext("Record a refund");
            creditBtn.title = gettext("Only records that the money was returned to the customer - this does not move any money itself.");
            var creditMsg = document.createElement("div");
            creditMsg.className = "pos-msg";
            creditBtn.addEventListener("click", function () {
                recordRefund(order, -pending, creditBtn, creditMsg);
            });
            creditWrap.appendChild(creditBtn);
            creditWrap.appendChild(creditMsg);
            orderCreditEl.appendChild(creditWrap);
        }

        renderPositionList(orderListEl);

        orderPayBlockEl.innerHTML = "";
        // innerHTML = "" above already detached whatever these pointed to from a
        // previous render - drop the references too so refreshPayButtonState()
        // doesn't touch detached nodes for an order that's no longer "n"/pending.
        payBtn = null;
        payMethodSelect = null;
        seatHintEl = null;

        if (orderCapabilities(order).payment) {
            // Method and button belong together on one line - the select is a
            // full-width block by default, which pushed the button onto a line
            // of its own for no reason.
            var payRow = document.createElement("div");
            payRow.className = "pos-pay-row";
            orderPayBlockEl.appendChild(payRow);

            payMethodSelect = document.createElement("select");
            PAYMENT_METHODS.forEach(function (m) {
                var opt = document.createElement("option");
                opt.value = m.value;
                opt.textContent = m.label;
                payMethodSelect.appendChild(opt);
            });
            payRow.appendChild(payMethodSelect);

            payBtn = document.createElement("button");
            payBtn.type = "button";
            payBtn.className = "pos-btn-primary";
            payBtn.textContent = gettext("Take payment");
            payBtn.addEventListener("click", function () { payOrder(order, payMethodSelect.value); });
            payRow.appendChild(payBtn);

            seatHintEl = document.createElement("p");
            seatHintEl.className = "pos-hint";
            seatHintEl.textContent = gettext("Assign a seat to every position (for every date) before taking payment.");
            orderPayBlockEl.appendChild(seatHintEl);

            // A transfer already waiting on this order - either booked here a
            // moment ago, or by the customer online before they walked in. Both
            // want the same two things: show the customer the code again, and
            // settle it once the money is visible in the bank.
            var bankPayment = (order.payments || []).find(function (p) {
                return p.provider === BANK_TRANSFER_PROVIDER && (p.state === "created" || p.state === "pending");
            });
            if (bankPayment) {
                var bankRow = document.createElement("div");
                bankRow.className = "pos-pay-row";
                var bankMsg = document.createElement("div");
                bankMsg.className = "pos-msg";

                var qrBtn = document.createElement("button");
                qrBtn.type = "button";
                qrBtn.className = "pos-btn-secondary";
                qrBtn.textContent = gettext("Show QR code");
                qrBtn.addEventListener("click", function () { showBankQr(bankPayment); });
                bankRow.appendChild(qrBtn);

                // Deliberately not gated on orderIsSeated() the way "Take
                // payment" is. That gate stops staff collecting money for a
                // seat that might not exist; here the money has already been
                // transferred, and refusing to record it would help nobody -
                // the order would simply read as unpaid until the bank matching
                // confirmed the same thing anyway. A paid-but-unseated order is
                // a state this terminal already handles (it sorts and colors
                // them apart in the list, and pretix_seatmap withholds the
                // ticket until every position has a seat).
                var arrivedBtn = document.createElement("button");
                arrivedBtn.type = "button";
                arrivedBtn.className = "pos-btn-primary";
                arrivedBtn.textContent = gettext("Payment received");
                arrivedBtn.addEventListener("click", function () {
                    confirmBankPayment(order, bankPayment, arrivedBtn, bankMsg);
                });
                bankRow.appendChild(arrivedBtn);

                orderPayBlockEl.appendChild(bankRow);
                orderPayBlockEl.appendChild(bankMsg);
            }

            // Taking cash before every seatable position actually has a seat risks
            // collecting money for a seat that turns out not to exist -
            // orderIsSeated() is already used to sort/color the Edit order list,
            // reused here to gate the button itself rather than just hinting at it.
            // Also re-run after every seat placement/move/removal - see
            // refreshPayButtonState().
            refreshPayButtonState();
        }

        // Keep exceptional/destructive actions out of the payment flow. Payment
        // is the common next step, while extending, reviving and canceling are
        // deliberate choices hidden under one compact control.
        orderCancelBlockEl.innerHTML = "";
        var capabilities = orderCapabilities(order);
        var moreActions = null;
        if (capabilities.structural || capabilities.extend || order.status === "c" || capabilities.cancel) {
            moreActions = document.createElement("details");
            moreActions.className = "pos-order-more-actions";
            var moreSummary = document.createElement("summary");
            moreSummary.textContent = gettext("More actions");
            moreActions.appendChild(moreSummary);
            orderCancelBlockEl.appendChild(moreActions);
        }

        if (capabilities.structural) {
            var customerBtn = document.createElement("button");
            customerBtn.type = "button";
            customerBtn.className = "pos-btn-secondary";
            customerBtn.textContent = gettext("Customer and billing details");
            customerBtn.addEventListener("click", function () { openCustomerDetails(order); });
            moreActions.appendChild(customerBtn);
        }

        // An unpaid reservation expires on its own and releases the seats. For a
        // "they'll pay at the door" booking taken over the phone that's exactly
        // what staff don't want, and the alternative was editing the date by
        // hand in the backend. Offered for an already-expired order too, not
        // just one still running: extend_order() re-checks the quota and puts it
        // back to pending, which is the only way to revive one from here.
        // pretix has no "never expires" - Order.expires can't be null - so the
        // performance the order is for is as long as it can live.
        if (capabilities.extend) {
            var expiryRow = document.createElement("div");
            expiryRow.className = "pos-pay-row";
            var expiryMsg = document.createElement("div");
            expiryMsg.className = "pos-msg";

            var extendBtn = document.createElement("button");
            extendBtn.type = "button";
            extendBtn.className = "pos-btn-secondary";
            extendBtn.textContent = order.status === "e"
                ? gettext("Revive until the event date")
                : gettext("Extend to the event date");
            extendBtn.addEventListener("click", function () { extendOrder(order, extendBtn, expiryMsg); });
            expiryRow.appendChild(extendBtn);

            moreActions.appendChild(expiryRow);
            moreActions.appendChild(expiryMsg);
        }

        if (order.status === "c") {
            var reactivateRow = document.createElement("div");
            reactivateRow.className = "pos-pay-row";
            var reactivateMsg = document.createElement("div");
            reactivateMsg.className = "pos-msg";
            var reactivateBtn = document.createElement("button");
            reactivateBtn.type = "button";
            reactivateBtn.className = "pos-btn-secondary";
            reactivateBtn.textContent = gettext("Reactivate order");
            reactivateBtn.addEventListener("click", function () {
                reactivateOrder(order, reactivateBtn, reactivateMsg);
            });
            reactivateRow.appendChild(reactivateBtn);
            moreActions.appendChild(reactivateRow);
            moreActions.appendChild(reactivateMsg);
        }

        if (capabilities.cancel) {
            var cancelMsg = document.createElement("div");
            cancelMsg.className = "pos-msg";

            var cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "pos-btn-danger";
            cancelBtn.textContent = gettext("Cancel entire order");
            cancelBtn.addEventListener("click", function () { cancelOrder(order, cancelBtn, cancelMsg); });
            moreActions.appendChild(cancelBtn);
            moreActions.appendChild(cancelMsg);
        }
    }

    function renderOrderDetail() {
        orderDetailEl.hidden = false;
        orderDetailEl.innerHTML = "";
        orderSeatmapWrapEl.innerHTML = "";
        orderSeatmapRedraw = null;

        orderHeaderEl = document.createElement("h3");
        orderDetailEl.appendChild(orderHeaderEl);
        orderTotalEl = document.createElement("p");
        orderDetailEl.appendChild(orderTotalEl);
        orderExpiryEl = document.createElement("div");
        orderDetailEl.appendChild(orderExpiryEl);
        orderPaymentsEl = document.createElement("div");
        orderDetailEl.appendChild(orderPaymentsEl);
        orderCreditEl = document.createElement("div");
        orderDetailEl.appendChild(orderCreditEl);
        orderPayBlockEl = document.createElement("div");
        orderDetailEl.appendChild(orderPayBlockEl);
        orderCancelBlockEl = document.createElement("div");
        orderDetailEl.appendChild(orderCancelBlockEl);

        // Positions get their own column (see #pos-order-positions in
        // pos.html/pos.css) instead of living inside orderDetailEl - a long
        // position list would otherwise push the pay/cancel buttons below
        // the fold along with everything else stacked in that column.
        orderPositionsWrapEl.innerHTML = "";
        orderListEl = document.createElement("div");
        orderPositionsWrapEl.appendChild(orderListEl);

        refreshOrderSummary();

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
            seatMapPromise = loadSeatmap(seId).then(function (seats) {
                return {noDate: false, results: seats};
            });
        }

        var placeMsg = document.createElement("div");
        placeMsg.id = "pos-place-msg";
        placeMsg.className = "pos-msg";

        function setSeatmapHelp() {
            var title = document.getElementById("pos-order-seatmap-title");
            if (!title) return;
            title.title = gettext("This order's own seats (for the date selected above) are shown in a muted highlight color. What clicking does depends on the checkboxes in the position list: with positions checked you are placing seats, so clicks and rectangle drags pick free seats; with nothing checked you are clearing seats, so they pick this order's own seats instead. Either way the selection is only staged - shown with a ring - until you press the button next to the legend. Hold Alt to remove seats from a staged selection; use × or Escape to clear it. Drag one of this order's own seats onto a free seat to move it (shown as a translucent preview while dragging). If it is in the staged selection, only that selection moves; otherwise hold Ctrl to move the whole block of this order's seats. Hover any occupied seat to see which order holds it, or double-click it to jump straight to that order. Positions for other dates are listed above, greyed out - switch the date to work with them.");
        }

        function legendItem(swatchStyle, text) {
            var li = document.createElement("li");
            var sw = document.createElement("span");
            sw.className = "pos-legend-swatch";
            Object.keys(swatchStyle).forEach(function (k) { sw.style[k] = swatchStyle[k]; });
            li.appendChild(sw);
            li.appendChild(document.createTextNode(" " + text));
            return li;
        }

        function buildSeatmapLegend() {
            var R = window.PretixSeatingRenderer;
            var ul = document.createElement("ul");
            ul.className = "pos-legend";
            // "Free" has no single colour to show - a free seat is painted in its
            // own seating category's colour, which is per-plan - so that row says
            // so in words rather than showing a swatch that would be wrong for
            // every plan but one.
            var free = document.createElement("li");
            free.textContent = gettext("free — shown in its own seating category's color");
            ul.appendChild(free);
            ul.appendChild(legendItem({background: "#777777"}, gettext("unavailable")));
            ul.appendChild(legendItem({background: R.MINE_COLOR}, gettext("this order's seats")));
            ul.appendChild(legendItem(
                {background: "transparent", boxShadow: "inset 0 0 0 2px " + R.SELECTED_COLOR},
                gettext("selected to place")
            ));
            ul.appendChild(legendItem(
                {background: "transparent", boxShadow: "inset 0 0 0 2px " + REMOVAL_COLOR},
                gettext("selected to clear")
            ));
            return ul;
        }

        seatMapPromise.then(function (info) {
            orderSeats = info.results;
            orderSeatmapWrapEl.innerHTML = "";
            if (!orderCapabilities(currentOrder).seats) {
                orderSeatmapWrapEl.textContent = gettext("Seats cannot be changed until this order is restored.");
                return;
            }
            if (info.noDate) {
                orderSeatmapWrapEl.textContent = gettext("Choose a date above to place seats for that date.");
                return;
            }
            if (!orderSeats.length) {
                orderSeatmapWrapEl.textContent = gettext("This date has no seated positions.");
                return;
            }

            // The full how-it-works text used to sit above the map as a
            // paragraph, which on a busy order pushed the map itself well down
            // the screen for something staff read once. It's the heading's
            // tooltip now.
            setSeatmapHelp();

            // Everything that needs to be seen while working goes above the
            // map: the action button, and the result of the last action
            // ("Block moved.", "Cleared 3 seats.", any error). Both used to sit
            // under a 16-row plan, i.e. off-screen exactly when they mattered -
            // an error especially, which staff could miss entirely.
            var bar = document.createElement("div");
            bar.className = "pos-seatmap-bar";
            bar.appendChild(placeMsg);

            var placeBtn = document.createElement("button");
            placeBtn.type = "button";
            placeBtn.className = "pos-btn-primary";
            bar.appendChild(placeBtn);
            var clearSelectionBtn = document.createElement("button");
            clearSelectionBtn.type = "button";
            clearSelectionBtn.className = "pos-btn-icon";
            clearSelectionBtn.textContent = "×";
            clearSelectionBtn.title = gettext("Clear staged seat selection");
            clearSelectionBtn.setAttribute("aria-label", gettext("Clear staged seat selection"));
            bar.appendChild(clearSelectionBtn);
            orderSeatmapWrapEl.appendChild(bar);

            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = "pos-svg-order";
            svg.setAttribute("class", "pos-seatmap");
            orderSeatmapWrapEl.appendChild(svg);

            // Below the map, deliberately: a POS terminal is worked by someone
            // who already knows what the colours mean, so the legend is there
            // to look up on the rare occasion it's needed, not to occupy the
            // space above the map every day.
            orderSeatmapWrapEl.appendChild(buildSeatmapLegend());

            orderSeatmapRedraw = initOrderSeatMap(svg, placeBtn, clearSelectionBtn, placeMsg, orderListEl, seId);
        });
    }

    // What to call a payment after the fact. Cash/card/QR taken here are all
    // core "boxoffice" payments told apart by the payment_type this terminal
    // writes into them, so the provider alone doesn't say much - fall back to
    // it only for payments made somewhere other than a till.
    function paymentMethodLabel(payment) {
        if (payment.provider === BANK_TRANSFER_PROVIDER) return gettext("Bank transfer");
        var type = (payment.details || {}).payment_type;
        var known = PAYMENT_METHODS.find(function (m) { return m.value === type; });
        return known ? known.label : payment.provider;
    }

    // The last date this order is actually for - an unpaid reservation should
    // survive until the performance it's for, not expire days before it while
    // the customer is still planning to pay at the door. Uses the latest date
    // the order covers, so a multi-date order doesn't lose its later positions
    // when its earliest one has been and gone.
    function orderLastEventDate(order) {
        var dates = (order.positions || [])
            .filter(function (p) { return !p.canceled && p.subevent; })
            .map(function (p) {
                var se = subeventsList.find(function (s) { return String(s.id) === String(p.subevent); });
                return se && se.date_from;
            })
            .filter(Boolean);
        if (!dates.length && state.event && state.event.dateFrom) dates = [state.event.dateFrom];
        if (!dates.length) return null;
        return dates.sort()[dates.length - 1];
    }

    function extendOrder(order, btn, msg) {
        if (!orderCapabilities(order).extend) return;
        if (order.status === "e" && !window.confirm(gettext(
            "Revive this expired order? Available capacity and seats will be checked again."
        ))) return;
        var date = orderLastEventDate(order);
        if (!date) {
            setMsg(msg, gettext("Can't tell which date this order is for."), "error");
            return;
        }
        btn.disabled = true;
        setMsg(msg, gettext("Extending…"), null);
        // The endpoint takes a plain date and expires the order at the end of
        // that day in the event's timezone, so an order stays valid throughout
        // the day of the performance.
        api(eventPath("/orders/" + order.code + "/extend/"), {
            method: "POST",
            body: JSON.stringify({expires: date.slice(0, 10)}),
        }).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            refreshCurrentView();
        });
    }

    function payOrder(order, method) {
        // Guards the case where this got called despite the button being
        // disabled (stale UI state, a race, or a future call site) - the
        // primary gate is the disabled button in renderOrderDetail().
        if (!orderCapabilities(order).payment || !orderIsSeated(order)) return;

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
            // A QR transfer is a real bank transfer, so it gets the bank
            // transfer provider's own payment rather than a box-office one
            // tagged "qr": that's what allocates a variable symbol, produces
            // the SPAYD code the customer scans, and lets the bank matching
            // recognise the money when it lands. It therefore stays *pending* -
            // nothing has been received yet at the moment staff press the
            // button - and is confirmed later, either by that matching or by
            // staff pressing "Payment received" once they see it in the bank.
            if (method === "qr") {
                return api(eventPath("/orders/" + order.code + "/payments/"), {
                    method: "POST",
                    body: JSON.stringify({provider: BANK_TRANSFER_PROVIDER, amount: amount, state: "pending"}),
                }).then(function (res) {
                    if (!res.ok) {
                        setMsg(msg, describeError(res.data), "error");
                        return;
                    }
                    showBankQr(res.data);
                    setMsg(msg, gettext("Waiting for the transfer - the order stays unpaid until the money arrives."), null);
                    refreshCurrentView();
                });
            }
            return api(eventPath("/orders/" + order.code + "/payments/"), {
                method: "POST",
                body: JSON.stringify({provider: "boxoffice", amount: amount, state: "created", info: {payment_type: method}}),
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
            refreshCurrentView();
            });
        });
    }

    // Everything shown here comes from the payment's own `details`, which the
    // bank transfer provider fills in server-side (api_payment_details) - the
    // variable symbol it allocated, the account, and a ready-made QR image.
    // Nothing about SPAYD is reimplemented in this terminal.
    function showBankQr(payment) {
        var d = (payment && payment.details) || {};
        if (!d.qr_code) {
            window.alert(gettext("This payment has no QR code - check that the bank transfer provider is configured for this event."));
            return;
        }
        var overlay = document.createElement("div");
        overlay.className = "pos-overlay";

        var box = document.createElement("div");
        box.className = "pos-overlay-box";
        overlay.appendChild(box);

        var h = document.createElement("h2");
        h.textContent = gettext("Scan to pay");
        box.appendChild(h);

        var img = document.createElement("img");
        img.className = "pos-qr";
        img.src = d.qr_code;
        img.alt = gettext("QR payment code");
        box.appendChild(img);

        [
            [gettext("Amount"), fmtMoney(payment.amount)],
            [gettext("Account"), d.domestic_account],
            [gettext("Variable symbol"), d.variable_symbol],
            [gettext("Recipient"), d.recipient_name],
        ].forEach(function (row) {
            if (!row[1]) return;
            var p = document.createElement("p");
            p.className = "pos-qr-line";
            var label = document.createElement("span");
            label.textContent = row[0] + ": ";
            var value = document.createElement("strong");
            value.textContent = row[1];
            p.appendChild(label);
            p.appendChild(value);
            box.appendChild(p);
        });

        var close = document.createElement("button");
        close.type = "button";
        close.textContent = gettext("Close");
        close.addEventListener("click", function () { overlay.remove(); });
        box.appendChild(close);

        // Clicking the backdrop closes too, but a click *inside* the box must
        // not - staff read the account number off it and will click it.
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    // Customer identity and invoice identity are deliberately separate: an
    // order e-mail identifies who receives messages, while attendee names on
    // positions stay untouched and billing data belongs only to the invoice.
    function openCustomerDetails(order) {
        var overlay = document.createElement("div");
        overlay.className = "pos-overlay";
        var box = document.createElement("form");
        box.className = "pos-overlay-box pos-customer-form";
        overlay.appendChild(box);

        var title = document.createElement("h2");
        title.textContent = gettext("Customer and billing details");
        box.appendChild(title);
        if (orderCapabilities(order).online) {
            var onlineWarning = document.createElement("p");
            onlineWarning.className = "pos-msg pos-error";
            onlineWarning.textContent = gettext("This is an online order. Check the customer's request carefully before saving.");
            box.appendChild(onlineWarning);
        }

        function addInput(label, value, type) {
            var wrap = document.createElement("label");
            wrap.className = "pos-customer-field";
            wrap.appendChild(document.createTextNode(label));
            var input = document.createElement("input");
            input.type = type || "text";
            input.value = value || "";
            wrap.appendChild(input);
            box.appendChild(wrap);
            return input;
        }

        var emailInput = addInput(gettext("E-mail"), order.email, "email");
        var phoneInput = addInput(gettext("Phone"), order.phone, "tel");
        var invoice = order.invoice_address || null;
        var billingToggle = document.createElement("label");
        billingToggle.className = "pos-customer-billing-toggle";
        var billingCheckbox = document.createElement("input");
        billingCheckbox.type = "checkbox";
        billingCheckbox.checked = !!invoice;
        billingToggle.appendChild(billingCheckbox);
        billingToggle.appendChild(document.createTextNode(" " + gettext("Edit billing details")));
        box.appendChild(billingToggle);

        var billingFields = document.createElement("div");
        billingFields.className = "pos-customer-billing-fields";
        box.appendChild(billingFields);
        function addBillingInput(label, field, type) {
            var wrap = document.createElement("label");
            wrap.className = "pos-customer-field";
            wrap.appendChild(document.createTextNode(label));
            var input = document.createElement("input");
            input.type = type || "text";
            input.value = invoice && invoice[field] || "";
            wrap.appendChild(input);
            billingFields.appendChild(wrap);
            return input;
        }
        var businessInput = document.createElement("input");
        businessInput.type = "checkbox";
        businessInput.checked = !!(invoice && invoice.is_business);
        var businessLabel = document.createElement("label");
        businessLabel.className = "pos-customer-business";
        businessLabel.appendChild(businessInput);
        businessLabel.appendChild(document.createTextNode(" " + gettext("Company")));
        billingFields.appendChild(businessLabel);
        var companyInput = addBillingInput(gettext("Company name"), "company");
        var nameInput = addBillingInput(gettext("Billing name"), "name");
        var streetInput = addBillingInput(gettext("Street"), "street");
        var zipInput = addBillingInput(gettext("ZIP code"), "zipcode");
        var cityInput = addBillingInput(gettext("City"), "city");
        var countryInput = addBillingInput(gettext("Country code"), "country");
        countryInput.maxLength = 2;
        var vatInput = addBillingInput(gettext("VAT ID"), "vat_id");
        function updateBillingVisibility() { billingFields.hidden = !billingCheckbox.checked; }
        billingCheckbox.addEventListener("change", updateBillingVisibility);
        updateBillingVisibility();

        var msg = document.createElement("div");
        msg.className = "pos-msg";
        box.appendChild(msg);
        var actions = document.createElement("div");
        actions.className = "pos-actions";
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = gettext("Cancel");
        cancel.addEventListener("click", function () { overlay.remove(); });
        actions.appendChild(cancel);
        var save = document.createElement("button");
        save.type = "submit";
        save.className = "pos-btn-primary";
        save.textContent = gettext("Save details");
        actions.appendChild(save);
        box.appendChild(actions);

        function billingData() {
            return {
                is_business: businessInput.checked,
                company: companyInput.value.trim(),
                name: nameInput.value.trim(),
                street: streetInput.value.trim(),
                zipcode: zipInput.value.trim(),
                city: cityInput.value.trim(),
                country: countryInput.value.trim().toUpperCase(),
                vat_id: vatInput.value.trim(),
            };
        }
        function billingChanged(data) {
            // The checkbox is an editor toggle, not a destructive “remove
            // invoice address” switch. Removing billing data would need a
            // separate explicit action, especially once an invoice exists.
            if (!billingCheckbox.checked) return false;
            if (!invoice) return Object.keys(data).some(function (key) {
                return key === "is_business" ? data[key] : !!data[key];
            });
            return Object.keys(data).some(function (key) {
                return String(data[key]) !== String(invoice[key] == null ? "" : invoice[key]);
            });
        }
        function hasActiveInvoice() {
            return api(eventPath("/invoices/?order=" + encodeURIComponent(order.code) + "&is_cancellation=false&page_size=1"))
                .then(function (res) {
                    return res.ok && ((res.data && res.data.results) || []).length > 0;
                });
        }
        function saveChanges(payload) {
            save.disabled = true;
            setMsg(msg, gettext("Saving…"), null);
            return api(eventPath("/orders/" + encodeURIComponent(order.code) + "/"), {
                method: "PATCH", body: JSON.stringify(payload),
            }).then(function (res) {
                if (!res.ok) {
                    save.disabled = false;
                    setMsg(msg, describeError(res.data), "error");
                    return;
                }
                currentOrder = res.data;
                refreshOrderSummary();
                scheduleOrderSummaryRefresh();
                overlay.remove();
            });
        }
        box.addEventListener("submit", function (e) {
            e.preventDefault();
            var data = billingData();
            var invoiceChanged = billingChanged(data);
            var payload = {email: emailInput.value.trim(), phone: phoneInput.value.trim()};
            if (invoiceChanged) payload.invoice_address = billingCheckbox.checked ? data : null;
            if (!invoiceChanged) return saveChanges(payload);
            hasActiveInvoice().then(function (exists) {
                if (!exists) return saveChanges(payload);
                setMsg(msg, gettext("This order already has an invoice. Change its billing details in the administration so the invoice can be reissued correctly."), "error");
                var link = document.createElement("a");
                link.href = "/control/event/" + encodeURIComponent(ORGANIZER) + "/" +
                    encodeURIComponent(state.event.slug) + "/orders/" + encodeURIComponent(order.code) + "/";
                link.textContent = gettext("Open order in administration");
                msg.appendChild(document.createElement("br"));
                msg.appendChild(link);
            });
        });
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    // Staff watching their banking app can settle the order the moment they see
    // the transfer, instead of waiting for the periodic bank matching - which is
    // the whole reason a customer standing at the counter can pay this way at
    // all. The till only counts the money here, not when the QR was shown.
    function confirmBankPayment(order, payment, btn, msg) {
        if (!orderCapabilities(order).payment) return;
        btn.disabled = true;
        setMsg(msg, gettext("Confirming…"), null);
        api(eventPath("/orders/" + order.code + "/payments/" + payment.local_id + "/confirm/"), {method: "POST"})
            .then(function (res) {
                if (!res.ok) {
                    btn.disabled = false;
                    setMsg(msg, describeError(res.data), "error");
                    return;
                }
                addToTill("qr", payment.amount);
                refreshCurrentView();
            });
    }

    function cancelOrder(order, btn, msg) {
        if (!orderCapabilities(order).cancel) return;
        if (!window.confirm(gettext("Cancel this entire order? This cannot be undone."))) return;
        btn.disabled = true;
        setMsg(msg, gettext("Canceling…"), null);
        api(eventPath("/orders/" + order.code + "/mark_canceled/"), {method: "POST"}).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            refreshCurrentView();
        });
    }

    function reactivateOrder(order, btn, msg) {
        if (!orderCapabilities(order).restore || order.status !== "c") return;
        if (!window.confirm(gettext("Reactivate this canceled order?"))) return;
        btn.disabled = true;
        setMsg(msg, gettext("Reactivating…"), null);
        api(eventPath("/orders/" + encodeURIComponent(order.code) + "/reactivate/"), {method: "POST"}).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            refreshCurrentView();
        });
    }

    function deletePositionFromOrder(pos, btn, msg) {
        var order = currentOrder;
        if (!orderCapabilities(order).structural) return;
        if (!confirmStructuralChange(order, -parseFloat(pos.price || 0))) return;
        if (!window.confirm(gettext("Cancel this position? This cannot be undone."))) return;
        btn.disabled = true;
        setMsg(msg, gettext("Canceling…"), null);
        api(eventPath("/orders/" + encodeURIComponent(order.code) + "/change/"), {
            method: "POST",
            body: JSON.stringify({
                send_email: !!order.email,
                cancel_positions: [{position: pos.id}],
            }),
        }).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            refreshCurrentView();
        });
    }

    // Adds several new positions to an existing order in one change operation.
    // Tries a plain, seatless
    // POST first - that's all most dates need (either unseated, or a
    // manually-assigned date where a seat gets picked afterwards through the
    // seatmap below, same as any other not-yet-seated position). Only a date
    // where customers pick their own seat (seating_choice on) rejects that
    // outright, with a structured {"seat": [...]} error (see the
    // SeatRequiredError patch in orders.py/orderchange.py - without it this
    // couldn't be told apart from any other validation failure without
    // matching on message text, which is locale-dependent). For that case
    // only, reuse Quick reservation's own grab-a-free-seat-then-release-it
    // dance (assignQuickSeats()/releaseQuickSeats()) - it lands the new
    // position in the same "needs seating" state as any other manually
    // placed one, instead of holding a seat nobody actually chose. If the
    // release itself fails, the position just keeps that seat and shows up
    // seated in the list above - staff can unassign it from the seatmap
    // below like any other misplaced seat, no separate recovery path needed.
    function addPositionsToOrder(subeventId, itemId, variationId, count, btn, msg) {
        var order = currentOrder;
        if (!orderCapabilities(order).structural) return;
        var createPositions = [];
        for (var i = 0; i < count; i++) {
            var p = {item: itemId};
            if (variationId) p.variation = variationId;
            if (subeventId != null) p.subevent = subeventId;
            createPositions.push(p);
        }
        if (!confirmStructuralChange(order, positionsPrice(createPositions))) return;

        btn.disabled = true;
        setMsg(msg, gettext("Adding…"), null);

        var changePath = eventPath("/orders/" + encodeURIComponent(order.code) + "/change/");
        var beforeIds = (order.positions || []).map(function (p) { return p.id; });
        function submitCreate(positions) {
            return api(changePath, {
            method: "POST",
                body: JSON.stringify({create_positions: positions, send_email: !!order.email}),
            });
        }
        submitCreate(createPositions).then(function (res) {
            if (!res.ok) {
                // Seat-required dates return a structured `seat` validation
                // error. Reserve temporary free seats for the whole batch,
                // retry once, then release those placeholders together.
                if (res.data && res.data.seat) {
                    return assignQuickSeats(createPositions).then(function (enough) {
                        if (!enough) {
                            btn.disabled = false;
                            setMsg(msg, gettext("No free seats left for this item/date."), "error");
                            return;
                        }
                        return submitCreate(createPositions).then(function (res2) {
                            if (!res2.ok) {
                                btn.disabled = false;
                                setMsg(msg, describeError(res2.data), "error");
                                return;
                            }
                            var added = (res2.data.positions || []).filter(function (p) {
                                return beforeIds.indexOf(p.id) === -1;
                            });
                            return releaseQuickSeats(added).then(function (released) {
                                btn.disabled = false;
                                setMsg(msg, released ? gettext("Positions added.") : gettext("Positions added, but some temporary seats could not be released."), released ? "success" : "error");
                                refreshCurrentView();
                            });
                        });
                    });
                }
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            btn.disabled = false;
            refreshCurrentView();
        });
    }

    // Only ever runs on an explicit click (see the "credit owed" banner in
    // renderOrderDetail()) - a lower total on an already-paid order never
    // refunds anything on its own. "boxoffice" matches the provider identifier
    // payOrder() already uses for cash/QR/card payments taken here; state
    // "done" records it as already completed - this terminal doesn't have
    // its own payment gateway to actually push money back through, so this
    // is bookkeeping ("we gave the customer X back at the counter"), not an
    // action that moves money itself.
    function recordRefund(order, amount, btn, msg) {
        if (!orderCapabilities(order).refund) return;
        btn.disabled = true;
        setMsg(msg, gettext("Recording…"), null);
        api(eventPath("/orders/" + order.code + "/refunds/"), {
            method: "POST",
            body: JSON.stringify({provider: "boxoffice", amount: amount.toFixed(2), state: "done", source: "admin"}),
        }).then(function (res) {
            if (!res.ok) {
                btn.disabled = false;
                setMsg(msg, describeError(res.data), "error");
                return;
            }
            refreshCurrentView();
        });
    }

    // ---- rubber-band multi-select + drag-to-move on the order's seat map ----

    var seatMapMouseUpHandler = null;

    function initOrderSeatMap(svg, placeBtn, clearSelectionBtn, msgEl, positionListEl, subeventId) {
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

        function selectedOwnPositions() {
            return Object.keys(removalPool)
                .map(function (guid) { return ownPositionOfSeat(removalPool[guid]); })
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
            // Both staged states drop the fill: an outline reads as "not settled
            // yet", which is true of a seat about to be placed and equally true
            // of one about to be cleared.
            if (placementPool[s.guid] || removalPool[s.guid]) return "transparent";
            if (isOwnSeat(s)) return window.PretixSeatingRenderer.MINE_COLOR;
            return window.PretixSeatingRenderer.seatColor(s);
        }

        function strokeFn(s) {
            if (placementPool[s.guid]) return {color: window.PretixSeatingRenderer.SELECTED_COLOR, width: 3};
            if (removalPool[s.guid]) return {color: REMOVAL_COLOR, width: 3};
            if (isOwnSeat(s)) return {color: window.PretixSeatingRenderer.MINE_COLOR, width: 3};
            return null;
        }

        function labelColorFn(s) {
            // Only the transparent-fill staged states need a label color override
            // (white-on-transparent is invisible) - MINE_COLOR's fill is solid, so
            // the default white seat-number label already reads fine on it.
            if (placementPool[s.guid]) return window.PretixSeatingRenderer.SELECTED_COLOR;
            if (removalPool[s.guid]) return REMOVAL_COLOR;
            return null;
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

        // Which of the two jobs the map is doing right now. The checkboxes in the
        // position list already say which one staff mean: something checked is
        // "these positions need seats", nothing checked is "I'm not placing
        // anything". Deriving the mode from them rather than from a separate
        // toggle means there's no third piece of state to get out of sync, and
        // no guessing when a rectangle happens to cover both kinds of seat.
        function isPlacingMode() {
            return checkedCount() > 0;
        }

        function renderPlaceBtn() {
            clearSelectionBtn.disabled = !Object.keys(placementPool).length && !Object.keys(removalPool).length;
            if (isPlacingMode()) {
                var n = Object.keys(placementPool).length;
                var checked = checkedCount();
                var seatsPart = interpolate(ngettext("%(n)s selected seat", "%(n)s selected seats", n), {n: n}, true);
                var positionsPart = interpolate(ngettext("%(n)s checked position", "%(n)s checked positions", checked), {n: checked}, true);
                placeBtn.textContent = interpolate(gettext("Place %(seats)s on %(positions)s"), {seats: seatsPart, positions: positionsPart}, true);
                placeBtn.className = "pos-btn-primary";
                placeBtn.disabled = n === 0;
            } else {
                var r = Object.keys(removalPool).length;
                placeBtn.textContent = r
                    ? interpolate(ngettext("Clear %(n)s selected seat", "Clear %(n)s selected seats", r), {n: r}, true)
                    : gettext("Select seats to clear");
                placeBtn.className = "pos-btn-danger";
                placeBtn.disabled = r === 0;
            }
        }

        function clearStagedSelection() {
            if (!Object.keys(placementPool).length && !Object.keys(removalPool).length) return;
            placementPool = {};
            removalPool = {};
            render();
            renderPlaceBtn();
            setMsg(msgEl, gettext("Staged seat selection cleared."), null);
        }

        clearSelectionBtn.addEventListener("click", clearStagedSelection);
        svg.setAttribute("tabindex", "0");
        svg.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            e.preventDefault();
            clearStagedSelection();
        });

        // Checking or unchecking a position can flip the mode, which would leave
        // a selection staged for an action the button no longer offers - and an
        // invisible one, since only the active mode's seats are picked from here
        // on. Drop it rather than let it sit there waiting to surprise someone.
        positionListEl.addEventListener("change", function () {
            if (isPlacingMode()) {
                removalPool = {};
            } else {
                placementPool = {};
            }
            render();
            renderPlaceBtn();
        });

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
        // seat normally, the staged subset when it contains that seat, or the
        // whole block (see ownSeats()) while Ctrl is held.
        // Cleaned up at mouseup by removing drag.ghostEls directly (drag is
        // already nulled out to `d` by then, see seatMapMouseUpHandler).
        function updateGhosts(pt, ctrlHeld) {
            var dx = pt.x - drag.startPt.x, dy = pt.y - drag.startPt.y;
            var sourceSeats = drag.selectedSeats.length ? drag.selectedSeats :
                (ctrlHeld ? ownSeats() : [drag.clickSeat]);
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
            svg.focus();
            var seat = seatAtEvent(e);
            var selectedPositions = seat && removalPool[seat.guid] ? selectedOwnPositions() : [];
            drag = {
                startPt: svgPoint(e),
                moved: false,
                clickSeat: seat,
                movePosition: seat ? ownPositionOfSeat(seat) : null,
                selectedPositions: selectedPositions,
                selectedSeats: selectedPositions.map(function (p) {
                    return seats.find(function (s) { return s.guid === p.seat.seat_guid; });
                }).filter(Boolean),
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
        // staged-selection branch applies to another order's seat).
        // Deliberately excludes this order's own seats: double-clicking one
        // would just reload the order that's already open, and its two single
        // clicks have already staged and unstaged it, so nothing is lost.
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
                // A plain click (no drag) on one of this order's own seats
                // stages it for removal - dragging it instead moves it (see the
                // d.movePosition branch below). Only in clearing mode: while
                // positions are checked the map is placing seats, and a stray
                // click on an already-seated one must not quietly queue it up
                // for the opposite action.
                if (d.movePosition) {
                    if (!isPlacingMode()) {
                        if (removalPool[d.clickSeat.guid]) {
                            delete removalPool[d.clickSeat.guid];
                        } else if (!e.altKey) {
                            removalPool[d.clickSeat.guid] = d.clickSeat;
                        }
                        render();
                        renderPlaceBtn();
                    }
                    return;
                }
                if (d.clickSeat && d.clickSeat.status === "free" && isPlacingMode()) {
                    if (placementPool[d.clickSeat.guid]) {
                        delete placementPool[d.clickSeat.guid];
                    } else if (!e.altKey && Object.keys(placementPool).length < checkedCount()) {
                        placementPool[d.clickSeat.guid] = d.clickSeat;
                    }
                    render();
                    renderPlaceBtn();
                    return;
                }
                // Empty-map clicks deliberately do nothing. They are common
                // while panning/looking around and must not discard a careful
                // multi-selection; use the visible × or Escape instead.
                return;
            }

            if (d.rectEl) d.rectEl.remove();
            d.ghostEls.forEach(function (el) { el.remove(); });

            if (d.movePosition) {
                var target = seatAtEvent(e);
                if (target) {
                    if (d.selectedPositions.length || e.ctrlKey) {
                        // Unlike the single-seat move below, don't require
                        // target.status === "free" here - moveBlock() itself
                        // already accepts a target that's merely occupied by
                        // another seat of the *same* block (a shift or swap
                        // within the dragged block), which is a valid move.
                        // Requiring "free" at this outer gate would silently
                        // reject exactly that valid case before moveBlock()
                        // ever runs.
                        moveBlock(d.clickSeat, target, d.selectedPositions);
                    } else if (target.status === "free") {
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
            // Same split as a single click: the rectangle only ever gathers the
            // kind of seat the current mode acts on, so dragging across a row
            // holding both free seats and this order's own can't produce a
            // selection the button can't act on.
            var placing = isPlacingMode();
            var cap = checkedCount();
            seats.forEach(function (s) {
                if (s.x == null || s.y == null) return;
                if (!(s.x >= rect.x0 && s.x <= rect.x1 && s.y >= rect.y0 && s.y <= rect.y1)) return;
                if (placing) {
                    if (s.status !== "free") return;
                    if (e.altKey) {
                        delete placementPool[s.guid];
                        return;
                    }
                    if (placementPool[s.guid] || Object.keys(placementPool).length >= cap) return;
                    placementPool[s.guid] = s;
                } else {
                    // No cap when clearing: unlike placement, which can't outrun
                    // the number of positions waiting for a seat, there's nothing
                    // stopping staff clearing every seat the order holds.
                    if (!isOwnSeat(s)) return;
                    if (e.altKey) {
                        delete removalPool[s.guid];
                    } else {
                        removalPool[s.guid] = s;
                    }
                }
            });
            render();
            renderPlaceBtn();
        };
        window.addEventListener("mouseup", seatMapMouseUpHandler);

        // Places all selected seats in a single /change/ call (one shared
        // OrderChangeManager, one commit) instead of one PATCH per seat - for
        // a 100-seat order that turns 100 sequential round-trips into 1.
        // The tradeoff is atomicity: if any seat in the batch got taken in
        // the meantime, the whole commit is rejected and none are placed
        // (core's _check_seats() only names the first conflicting seat it
        // finds). That's rare for a batch a single till is actively placing,
        // so on that failure we fall back to placeSeatsOneByOne(), which is
        // slower but reports each seat's own success/failure like before.
        function placeSeatsOneByOne(poolSeats, positionIds, n) {
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
        }

        // Mirrors placeSeatsOneByOne(): the fallback for when the single batched
        // commit is rejected, so staff still get a per-seat pass/fail report.
        function clearSeatsOneByOne(positions) {
            setMsg(msgEl, gettext("Clearing seats one by one - this is not a single atomic action, a failure partway through leaves earlier removals in place…"), null);
            var i = 0, ok = 0, failed = [];
            var n = positions.length;
            function next() {
                if (i >= n) {
                    var resultMsg = interpolate(
                        ngettext("Cleared %(ok)s/%(n)s seat.", "Cleared %(ok)s/%(n)s seats.", n),
                        {ok: ok, n: n}, true
                    );
                    if (failed.length) {
                        resultMsg += " " + interpolate(gettext("Failed: %(errors)s"), {errors: failed.join("; ")}, true);
                    }
                    setMsg(msgEl, resultMsg, failed.length ? "error" : "success");
                    removalPool = {};
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    refreshPayButtonState();
                    return;
                }
                var pos = positions[i];
                i += 1;
                api(eventPath("/orderpositions/" + pos.id + "/"), {
                    method: "PATCH",
                    body: JSON.stringify({seat: null}),
                }).then(function (res) {
                    if (res.ok) {
                        ok += 1;
                        applyPositionSeat(pos.id, null);
                    } else {
                        failed.push("#" + pos.id + ": " + describeError(res.data));
                    }
                    next();
                });
            }
            next();
        }

        function clearSelectedSeats() {
            var positions = Object.keys(removalPool)
                .map(function (g) { return ownPositionOfSeat(removalPool[g]); })
                .filter(Boolean);
            var n = positions.length;
            if (!n) return;
            placeBtn.disabled = true;
            setMsg(msgEl, interpolate(ngettext("Clearing %(n)s seat…", "Clearing %(n)s seats…", n), {n: n}, true), null);

            api(eventPath("/orders/" + encodeURIComponent(currentOrder.code) + "/change/"), {
                method: "POST",
                body: JSON.stringify({
                    send_email: false,
                    patch_positions: positions.map(function (p) {
                        return {position: p.id, body: {seat: null}};
                    }),
                }),
            }).then(function (res) {
                if (res.ok) {
                    positions.forEach(function (p) { applyPositionSeat(p.id, null); });
                    setMsg(msgEl, interpolate(ngettext("Cleared %(n)s seat.", "Cleared %(n)s seats.", n), {n: n}, true), "success");
                    removalPool = {};
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    refreshPayButtonState();
                } else {
                    setMsg(msgEl, interpolate(gettext("Batch clearing failed (%(error)s) - retrying one by one…"), {error: describeError(res.data)}, true), "error");
                    clearSeatsOneByOne(positions);
                }
            });
        }

        placeBtn.addEventListener("click", function () {
            if (!isPlacingMode()) {
                clearSelectedSeats();
                return;
            }
            var poolSeats = Object.keys(placementPool).map(function (g) { return placementPool[g]; });
            var positionIds = Array.prototype.slice.call(positionListEl.querySelectorAll("input[type=checkbox]:checked"))
                .map(function (cb) { return parseInt(cb.dataset.positionId, 10); });
            var n = Math.min(poolSeats.length, positionIds.length);
            if (!n) return;
            poolSeats.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
            placeBtn.disabled = true;
            setMsg(msgEl, interpolate(ngettext("Placing %(n)s seat…", "Placing %(n)s seats…", n), {n: n}, true), null);

            api(eventPath("/orders/" + encodeURIComponent(currentOrder.code) + "/change/"), {
                method: "POST",
                body: JSON.stringify({
                    send_email: false,
                    patch_positions: positionIds.slice(0, n).map(function (posId, idx) {
                        return {position: posId, body: {seat: poolSeats[idx].guid}};
                    }),
                }),
            }).then(function (res) {
                if (res.ok) {
                    var byId = {};
                    (res.data.positions || []).forEach(function (p) { byId[p.id] = p; });
                    for (var idx = 0; idx < n; idx++) {
                        var posId = positionIds[idx];
                        if (byId[posId]) applyPositionSeat(posId, byId[posId].seat);
                    }
                    setMsg(msgEl, interpolate(ngettext("Placed %(n)s seat.", "Placed %(n)s seats.", n), {n: n}, true), "success");
                    placementPool = {};
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    refreshPayButtonState();
                } else {
                    setMsg(msgEl, interpolate(gettext("Batch placement failed (%(error)s) - retrying one by one…"), {error: describeError(res.data)}, true), "error");
                    placeSeatsOneByOne(poolSeats, positionIds, n);
                }
            });
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
                // The moved seat's guid changed, so applyPositionSeat() may have
                // dropped it from removalPool - the button's count has to follow.
                renderPlaceBtn();
                refreshPayButtonState();
            });
        }

        // A drag on a staged subset moves just that subset; Ctrl+drag without
        // such a subset moves this order's whole block of assigned seats.
        // by the same x/y offset as the one seat that was actually dragged.
        // Every other seat in the block must resolve to a seat at the offset
        // position that's either free or itself part of the block (about to be
        // vacated by this same move) - otherwise the whole move is refused
        // rather than silently moving only some of the seats.
        function moveBlock(draggedSeat, targetSeat, selectedPositions) {
            var dx = targetSeat.x - draggedSeat.x, dy = targetSeat.y - draggedSeat.y;
            if (!dx && !dy) return;

            var blockPositions = selectedPositions.length ? selectedPositions : (currentOrder.positions || []).filter(function (p) {
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

            // Clears every seat in the block first, then assigns the new ones,
            // one PATCH at a time - avoids "seat already taken" conflicts when
            // the block shifts onto its own previously-occupied seats,
            // regardless of move order. Used as a fallback (see moveBlock's
            // main body below) since a single /change/ commit tracks the net
            // seat diff across the whole block anyway, so it doesn't need
            // this two-phase dance in the common case.
            function moveBlockOneByOne(moves) {
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
                        renderPlaceBtn();
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

            setMsg(msgEl, interpolate(
                ngettext("Moving %(n)s seat…", "Moving %(n)s seats…", moves.length),
                {n: moves.length},
                true
            ), null);

            api(eventPath("/orders/" + encodeURIComponent(currentOrder.code) + "/change/"), {
                method: "POST",
                body: JSON.stringify({
                    send_email: false,
                    patch_positions: moves.map(function (m) {
                        return {position: m.position.id, body: {seat: m.targetGuid}};
                    }),
                }),
            }).then(function (res) {
                if (res.ok) {
                    var byId = {};
                    (res.data.positions || []).forEach(function (p) { byId[p.id] = p; });
                    moves.forEach(function (m) {
                        if (byId[m.position.id]) applyPositionSeat(m.position.id, byId[m.position.id].seat);
                    });
                    setMsg(msgEl, gettext("Block moved."), "success");
                    renderPositionList(positionListEl);
                    render();
                    renderPlaceBtn();
                    refreshPayButtonState();
                } else {
                    setMsg(msgEl, interpolate(gettext("Batch move failed (%(error)s) - retrying one by one…"), {error: describeError(res.data)}, true), "error");
                    moveBlockOneByOne(moves);
                }
            });
        }

        render();
        renderPlaceBtn();

        // Handed back to renderOrderDetail() as orderSeatmapRedraw - lets a
        // later refreshCurrentView() put this same map's colors and
        // "Place N seats on M positions" button text back in sync with a
        // freshly-refetched currentOrder without tearing any of this down.
        return function () {
            render();
            renderPlaceBtn();
        };
    }

    // -------------------------------------------------------------------- boot

    function boot() {
        tillPanel.hidden = true;
        // Re-shown by loadEventInfo() once this event's test mode is known -
        // otherwise switching events would leave the old event's banner up.
        testmodeKnown = false;
        testmodeBanner.hidden = true;
        if (!state.token) {
            showScreen("pair");
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = true;
            btnRefresh.hidden = true;
            btnTill.hidden = true;
            headerInfo.textContent = "";
            return;
        }
        if (!state.event) {
            btnChangeEvent.hidden = true;
            btnUnpair.hidden = false;
            btnRefresh.hidden = true;
            btnTill.hidden = false;
            headerInfo.textContent = state.deviceName || "";
            loadEvents();
            return;
        }
        loadMainScreen();
    }

    boot();
})();
