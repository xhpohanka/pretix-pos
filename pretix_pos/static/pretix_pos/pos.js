(function () {
    "use strict";

    var root = document.getElementById("pos-app");
    if (!root) return;

    var API_BASE = root.dataset.apiBase;
    var ORGANIZER = root.dataset.organizer;
    var STORAGE_KEY = "pretix_pos_state:" + ORGANIZER;
    var POOL_COLOR = "#9b59b6";
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

    function pickI18n(v) {
        if (v == null) return "";
        if (typeof v === "string") return v;
        var lang = document.documentElement.lang;
        if (v[lang]) return v[lang];
        if (v.en) return v.en;
        var keys = Object.keys(v);
        return keys.length ? v[keys[0]] : "";
    }

    function describeError(data) {
        if (!data) return "Unknown error.";
        if (typeof data === "string") return data;
        if (data.detail) return String(data.detail);
        var parts = [];
        Object.keys(data).forEach(function (key) {
            var v = data[key];
            var flat = Array.isArray(v) ? v.join(" ") : (typeof v === "object" ? describeError(v) : String(v));
            parts.push(key === "non_field_errors" ? flat : (key + ": " + flat));
        });
        return parts.join(" | ") || "Unknown error.";
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
                    state.event = {slug: ev.slug, hasSubevents: ev.has_subevents, name: pickI18n(ev.name)};
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
        });
    });

    function currentSubeventId() {
        return state.event.hasSubevents ? (subeventSelect.value || null) : null;
    }

    function eventPath(suffix) {
        return "/organizers/" + ORGANIZER + "/events/" + state.event.slug + suffix;
    }

    function loadMainScreen() {
        showScreen("main");
        headerInfo.textContent = (state.deviceName ? state.deviceName + " · " : "") + state.event.name;
        btnChangeEvent.hidden = false;
        btnUnpair.hidden = false;

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
            subs.forEach(function (se) {
                var opt = document.createElement("option");
                opt.value = se.id;
                opt.textContent = pickI18n(se.name) + " — " + new Date(se.date_from).toLocaleString();
                subeventSelect.appendChild(opt);
            });
            loadForCurrentContext();
        });
    }

    subeventSelect.addEventListener("change", function () {
        cart = [];
        activeSeatItem = null;
        loadForCurrentContext();
    });

    function loadForCurrentContext() {
        cart = [];
        activeSeatItem = null;
        renderCart();
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
            ? api(seId ? eventPath("/subevents/" + seId + "/seatmap/") : eventPath("/seatmap/"))
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
                    price: it.default_price,
                    hasVariations: it.has_variations,
                    variations: (it.variations || []).filter(function (v) { return v.active; }).map(function (v) {
                        return {id: v.id, value: pickI18n(v.value), price: v.default_price != null ? v.default_price : it.default_price};
                    }),
                    needsSeat: sellSeats.some(function (s) { return s.product_id === it.id; }),
                };
            });
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

    function cartCountFor(itemId, variationId) {
        return cart.filter(function (c) { return c.itemId === itemId && c.variationId === (variationId || null) && !c.seatGuid; }).length;
    }

    function renderSellItemRow(item) {
        var row = document.createElement("div");
        row.className = "pos-item-row";

        if (item.needsSeat) {
            var label = document.createElement("div");
            label.className = "pos-item-title";
            label.textContent = item.name + " (" + fmtMoney(item.price) + ") — seated";
            row.appendChild(label);

            var btn = document.createElement("button");
            btn.type = "button";
            var seatCount = cart.filter(function (c) { return c.itemId === item.id && c.seatGuid; }).length;
            btn.textContent = (activeSeatItem === item.id ? "Picking seats…" : "Pick seats") + (seatCount ? " (" + seatCount + ")" : "");
            if (activeSeatItem === item.id) btn.className = "pos-btn-primary";
            btn.addEventListener("click", function () {
                activeSeatItem = activeSeatItem === item.id ? null : item.id;
                renderSellItems();
            });
            row.appendChild(btn);
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
        if (delta > 0) {
            cart.push({itemId: itemId, variationId: variationId, seatGuid: null, price: price});
        } else {
            var idx = cart.findIndex(function (c) {
                return c.itemId === itemId && c.variationId === (variationId || null) && !c.seatGuid;
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
        window.PretixSeatingRenderer.drawSeats(svgSell, sellSeats, function (s) {
            if (cart.some(function (c) { return c.seatGuid === s.guid; })) return "#337ab7";
            return {free: "#5cb85c", taken: "#d9534f", held: "#f0ad4e", blocked: "#777777"}[s.status] || "#999";
        }, function (s) {
            var idx = cart.findIndex(function (c) { return c.seatGuid === s.guid; });
            if (idx >= 0) {
                cart.splice(idx, 1);
            } else {
                if (s.status !== "free") return;
                if (s.product_id != null && s.product_id !== activeSeatItem) return;
                var label = [s.zone, s.row_label, s.seat_label].filter(Boolean).join(" / ") || s.guid;
                cart.push({itemId: activeSeatItem, variationId: null, seatGuid: s.guid, price: itemsById[activeSeatItem].default_price, seatLabel: label});
            }
            renderSellItems();
            renderCart();
        }, null, "pointer");
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
        totalDiv.textContent = "Estimated total: " + total.toFixed(2) + " (final price computed at checkout)";
        cartEl.appendChild(totalDiv);
        btnReserve.disabled = false;
        btnSell.disabled = false;
    }

    function buildPositions() {
        var seId = currentSubeventId();
        return cart.map(function (c) {
            var p = {item: c.itemId};
            if (c.variationId) p.variation = c.variationId;
            if (seId) p.subevent = seId;
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

    function doSearch() {
        var q = searchInput.value.trim();
        if (!q) return;
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

    function renderSearchResults(orders) {
        searchResultsEl.innerHTML = "";
        if (!orders.length) {
            searchResultsEl.textContent = "No matching orders.";
            return;
        }
        orders.forEach(function (o) {
            var div = document.createElement("div");
            div.className = "pos-search-result";
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

    function renderOrderDetail() {
        orderDetailEl.hidden = false;
        orderDetailEl.innerHTML = "";
        var order = currentOrder;

        var h = document.createElement("h3");
        h.textContent = order.code + " — " + order.status;
        orderDetailEl.appendChild(h);

        var pending = pendingSum(order);
        var p = document.createElement("p");
        p.textContent = "Total: " + order.total + (parseFloat(pending) > 0 ? " — pending: " + pending : " — fully paid");
        orderDetailEl.appendChild(p);

        var positions = (order.positions || []).filter(function (pos) { return !pos.canceled; });

        var seIds = Array.from(new Set(positions.map(function (pos) { return pos.subevent; }).filter(Boolean)));
        var seatMapPromise;
        if (!window.PretixSeatingRenderer) {
            seatMapPromise = Promise.resolve({multiDate: false, results: []});
        } else if (seIds.length > 1) {
            seatMapPromise = Promise.resolve({multiDate: true, results: []});
        } else {
            seatMapPromise = api(seIds.length === 1 ? eventPath("/subevents/" + seIds[0] + "/seatmap/") : eventPath("/seatmap/"))
                .then(function (res) {
                    var raw = (res.ok && res.data && res.data.results) || [];
                    return {multiDate: false, results: raw.map(toDrawSeat)};
                });
        }

        var list = document.createElement("div");
        positions.forEach(function (pos) {
            var row = document.createElement("div");
            row.className = "pos-position-row";

            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.positionId = pos.id;
            cb.checked = !pos.seat;
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
                badge.textContent = "no seat";
            }
            row.appendChild(badge);

            list.appendChild(row);
        });
        orderDetailEl.appendChild(list);

        if (order.status === "n") {
            var payBtn = document.createElement("button");
            payBtn.type = "button";
            payBtn.className = "pos-btn-primary";
            payBtn.textContent = "Take payment (cash)";
            payBtn.addEventListener("click", function () { payOrder(order); });
            orderDetailEl.appendChild(payBtn);
        }

        var placeMsg = document.createElement("div");
        placeMsg.id = "pos-place-msg";
        placeMsg.className = "pos-msg";

        seatMapPromise.then(function (info) {
            orderSeats = info.results;
            if (info.multiDate) {
                var warn = document.createElement("p");
                warn.className = "pos-hint";
                warn.textContent = "This order spans multiple dates - seat placement here only covers one date at a time and is not shown.";
                orderDetailEl.appendChild(warn);
                return;
            }
            if (!orderSeats.length) return;

            var hint = document.createElement("p");
            hint.className = "pos-hint";
            hint.textContent = "Drag a rectangle over free seats to select several at once, then click \"Place selected\". Drag an already-placed seat of this order onto a free seat to move it.";
            orderDetailEl.appendChild(hint);

            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = "pos-svg-order";
            svg.setAttribute("class", "pos-seatmap");
            orderDetailEl.appendChild(svg);

            var placeBtn = document.createElement("button");
            placeBtn.type = "button";
            placeBtn.textContent = "Place selected seats on checked positions";
            placeBtn.style.marginTop = "10px";
            orderDetailEl.appendChild(placeBtn);
            orderDetailEl.appendChild(placeMsg);

            initOrderSeatMap(svg, placeBtn, placeMsg, list);
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

    function initOrderSeatMap(svg, placeBtn, msgEl, positionListEl) {
        var seats = orderSeats;
        var drag = null;

        if (seatMapMouseUpHandler) window.removeEventListener("mouseup", seatMapMouseUpHandler);

        function ownPositionOfSeat(seat) {
            return (currentOrder.positions || []).find(function (p) {
                return !p.canceled && p.seat && p.seat.seat_guid === seat.guid;
            }) || null;
        }

        function colorFn(s) {
            if (placementPool[s.guid]) return POOL_COLOR;
            return {free: "#5cb85c", taken: "#d9534f", held: "#f0ad4e", blocked: "#777777"}[s.status] || "#999";
        }

        function render() {
            window.PretixSeatingRenderer.drawSeats(svg, seats, colorFn, null, null, "pointer");
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

        svg.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            var seat = seatAtEvent(e);
            drag = {
                startPt: svgPoint(e),
                moved: false,
                clickSeat: seat,
                movePosition: seat ? ownPositionOfSeat(seat) : null,
                rectEl: null,
            };
            e.preventDefault();
        });

        svg.addEventListener("mousemove", function (e) {
            if (!drag) return;
            var pt = svgPoint(e);
            var dx = pt.x - drag.startPt.x, dy = pt.y - drag.startPt.y;
            if (!drag.moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            drag.moved = true;
            if (!drag.movePosition) updateRubberRect(pt);
        });

        seatMapMouseUpHandler = function (e) {
            if (!drag || !svg.isConnected) { drag = null; return; }
            var d = drag;
            drag = null;

            if (!d.moved) {
                if (d.clickSeat && d.clickSeat.status === "free") {
                    if (placementPool[d.clickSeat.guid]) delete placementPool[d.clickSeat.guid];
                    else placementPool[d.clickSeat.guid] = d.clickSeat;
                    render();
                    renderPlaceBtn();
                }
                return;
            }

            if (d.rectEl) d.rectEl.remove();

            if (d.movePosition) {
                var target = seatAtEvent(e);
                if (target && target.status === "free") {
                    movePositionSeat(d.movePosition, target.guid, msgEl);
                }
                return;
            }

            var pt = svgPoint(e);
            var rect = {
                x0: Math.min(d.startPt.x, pt.x), x1: Math.max(d.startPt.x, pt.x),
                y0: Math.min(d.startPt.y, pt.y), y1: Math.max(d.startPt.y, pt.y),
            };
            seats.forEach(function (s) {
                if (s.status !== "free" || s.x == null || s.y == null) return;
                if (s.x >= rect.x0 && s.x <= rect.x1 && s.y >= rect.y0 && s.y <= rect.y1) {
                    placementPool[s.guid] = s;
                }
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
                    loadOrderDetail(currentOrder.code);
                    return;
                }
                var seat = poolSeats[i];
                var posId = positionIds[i];
                i += 1;
                api(eventPath("/orderpositions/" + posId + "/"), {
                    method: "PATCH",
                    body: JSON.stringify({seat: seat.guid}),
                }).then(function (res) {
                    if (res.ok) ok += 1;
                    else failed.push("#" + posId + ": " + describeError(res.data));
                    next();
                });
            }
            next();
        });

        render();
        renderPlaceBtn();
    }

    function movePositionSeat(position, seatGuid, msgEl) {
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
            loadOrderDetail(currentOrder.code);
        });
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
