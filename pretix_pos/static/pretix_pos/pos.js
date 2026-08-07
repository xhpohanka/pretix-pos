(function () {
    "use strict";

    var STATUS_COLORS = {
        free: "#5cb85c",
        taken: "#d9534f",
        held: "#f0ad4e",
        blocked: "#777777",
    };
    var CART_COLOR = "#337ab7";

    document.addEventListener("DOMContentLoaded", function () {
        var root = document.getElementById("pretix-pos");
        if (!root) return;

        var csrfToken = root.dataset.csrfToken;
        var apiItems = root.dataset.apiItems;
        var apiSearch = root.dataset.apiSearch;
        var apiOrder = root.dataset.apiOrder;
        var apiCreateOrder = root.dataset.apiCreateOrder;
        var apiPay = root.dataset.apiPay;
        var seatingApiSeats = root.dataset.seatingApiSeats || "";
        var seatingAssignUrl = root.dataset.seatingAssignUrl || "";

        var subeventSelect = document.getElementById("pos-subevent");
        var itemsEl = document.getElementById("pos-items");
        var cartEl = document.getElementById("pos-cart");
        var emailInput = document.getElementById("pos-email");
        var reserveBtn = document.getElementById("pos-reserve");
        var sellBtn = document.getElementById("pos-sell");
        var orderMsgEl = document.getElementById("pos-order-msg");
        var searchInput = document.getElementById("pos-search");
        var searchBtn = document.getElementById("pos-search-btn");
        var searchResultsEl = document.getElementById("pos-search-results");
        var orderDetailEl = document.getElementById("pos-order-detail");

        var items = [];
        var cart = []; // {key, type: 'seat'|'qty', item_id, item_name, variation_id, variation_name, seat_guid, seat_label, price, count}
        var cartInCartSeatGuids = {};

        function jsonFetch(url, opts) {
            opts = opts || {};
            opts.credentials = "same-origin";
            opts.cache = "no-store";
            opts.headers = Object.assign(
                { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
                opts.headers || {}
            );
            return fetch(url, opts).then(function (r) {
                return r.json().then(function (data) {
                    return { status: r.status, data: data };
                });
            });
        }

        function currentSubevent() {
            return subeventSelect ? subeventSelect.value : "";
        }

        // --- item list / cart building -----------------------------------

        function loadItems() {
            if (subeventSelect && !currentSubevent()) {
                itemsEl.textContent = "Nejdřív vyberte datum.";
                items = [];
                return;
            }
            var url = apiItems + (currentSubevent() ? ("?subevent=" + encodeURIComponent(currentSubevent())) : "");
            jsonFetch(url, { method: "GET" }).then(function (res) {
                if (res.status !== 200) {
                    itemsEl.textContent = "Nepodařilo se načíst produkty.";
                    return;
                }
                items = res.data.items || [];
                renderItems();
            });
        }

        function renderItems() {
            itemsEl.innerHTML = "";
            if (!items.length) {
                itemsEl.textContent = "Žádné produkty.";
                return;
            }
            items.forEach(function (item) {
                itemsEl.appendChild(renderItemRow(item));
            });
        }

        function renderItemRow(item) {
            var row = document.createElement("div");
            row.className = "pos-item-row";

            var title = document.createElement("div");
            title.className = "pos-item-title";
            title.textContent = item.name + (item.price != null ? " — " + item.price : "");
            row.appendChild(title);

            if (item.needs_seat) {
                if (!seatingApiSeats) {
                    var warn = document.createElement("div");
                    warn.className = "text-muted";
                    warn.textContent = "Tato položka vyžaduje výběr místa, ale plugin Seating není pro tuto akci zapnutý.";
                    row.appendChild(warn);
                } else {
                    row.appendChild(buildSeatPicker(item));
                }
            } else if (item.has_variations) {
                row.appendChild(buildQtyPicker(item, item.variations));
            } else {
                row.appendChild(buildQtyPicker(item, null));
            }

            return row;
        }

        function buildQtyPicker(item, variations) {
            var wrap = document.createElement("div");
            wrap.className = "pos-qty-picker";

            var select = null;
            if (variations) {
                select = document.createElement("select");
                select.className = "form-control pos-variation-select";
                variations.forEach(function (v) {
                    var opt = document.createElement("option");
                    opt.value = v.id;
                    opt.textContent = v.value + " — " + v.price;
                    select.appendChild(opt);
                });
                wrap.appendChild(select);
            }

            var qtyInput = document.createElement("input");
            qtyInput.type = "number";
            qtyInput.min = "1";
            qtyInput.value = "1";
            qtyInput.className = "form-control pos-qty";
            wrap.appendChild(qtyInput);

            var addBtn = document.createElement("button");
            addBtn.className = "btn btn-default btn-sm";
            addBtn.type = "button";
            addBtn.textContent = "Přidat";
            addBtn.addEventListener("click", function () {
                var count = parseInt(qtyInput.value, 10) || 0;
                if (count <= 0) return;
                var variation = null;
                if (select) {
                    var vid = parseInt(select.value, 10);
                    variation = variations.find(function (v) { return v.id === vid; });
                }
                addQtyToCart(item, variation, count);
                qtyInput.value = "1";
            });
            wrap.appendChild(addBtn);

            return wrap;
        }

        function buildSeatPicker(item) {
            var wrap = document.createElement("div");

            var toggleBtn = document.createElement("button");
            toggleBtn.className = "btn btn-default btn-sm";
            toggleBtn.type = "button";
            toggleBtn.textContent = "Vybrat místa";
            wrap.appendChild(toggleBtn);

            var panel = document.createElement("div");
            panel.className = "pos-seat-panel";
            panel.style.display = "none";
            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 1200 800");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.style.width = "100%";
            svg.style.maxHeight = "400px";
            svg.style.border = "1px solid #ddd";
            svg.style.background = "#fff";
            panel.appendChild(svg);
            wrap.appendChild(panel);

            var loaded = false;
            toggleBtn.addEventListener("click", function () {
                var show = panel.style.display === "none";
                panel.style.display = show ? "block" : "none";
                if (show && !loaded) {
                    loaded = true;
                    loadSeatsForPanel(item, svg);
                } else if (show) {
                    renderSeatPanel(item, svg, panel._seats || []);
                }
            });

            return wrap;
        }

        function loadSeatsForPanel(item, svg) {
            var url = seatingApiSeats + (currentSubevent() ? ("?subevent=" + encodeURIComponent(currentSubevent())) : "");
            fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
                return r.json();
            }).then(function (data) {
                svg.closest(".pos-seat-panel")._seats = data.seats || [];
                svg.closest(".pos-seat-panel")._plan = data.plan || null;
                renderSeatPanel(item, svg, data.seats || [], data.plan || null);
            }).catch(function () {
                // leave panel empty, non-fatal
            });
        }

        function renderSeatPanel(item, svg, seats, planGeometry) {
            if (!window.PretixSeatingRenderer) return;
            window.PretixSeatingRenderer.drawSeats(svg, seats, function (s) {
                if (cartInCartSeatGuids[s.guid]) return CART_COLOR;
                return STATUS_COLORS[s.status] || "#999";
            }, function (seat) {
                if (seat.status !== "free" || cartInCartSeatGuids[seat.guid]) return;
                if (seat.product_id && seat.product_id !== item.id) return; // belongs to a different category
                addSeatToCart(item, seat);
                renderSeatPanel(item, svg, seats, planGeometry);
            }, planGeometry, "pointer");
        }

        function addQtyToCart(item, variation, count) {
            cart.push({
                key: "qty-" + item.id + "-" + (variation ? variation.id : "0") + "-" + Date.now() + "-" + Math.random(),
                type: "qty",
                item_id: item.id,
                item_name: item.name,
                variation_id: variation ? variation.id : null,
                variation_name: variation ? variation.value : null,
                price: variation ? variation.price : item.price,
                count: count,
            });
            renderCart();
        }

        function addSeatToCart(item, seat) {
            cartInCartSeatGuids[seat.guid] = true;
            cart.push({
                key: "seat-" + seat.guid,
                type: "seat",
                item_id: item.id,
                item_name: item.name,
                seat_guid: seat.guid,
                seat_label: [seat.zone, seat.row_label, seat.seat_label].filter(Boolean).join(" / ") || seat.guid,
                price: item.price,
            });
            renderCart();
        }

        function removeFromCart(key) {
            var entry = cart.find(function (e) { return e.key === key; });
            if (entry && entry.type === "seat") {
                delete cartInCartSeatGuids[entry.seat_guid];
            }
            cart = cart.filter(function (e) { return e.key !== key; });
            renderCart();
            renderItems(); // re-fetch/redraw isn't needed, but a freed seat should show free again on next open
        }

        function renderCart() {
            cartEl.innerHTML = "";
            if (!cart.length) {
                cartEl.textContent = "Prázdný.";
                reserveBtn.disabled = true;
                sellBtn.disabled = true;
                return;
            }
            var ul = document.createElement("ul");
            ul.className = "pos-cart-list";
            cart.forEach(function (e) {
                var li = document.createElement("li");
                var label = e.type === "seat"
                    ? (e.item_name + " — " + e.seat_label)
                    : (e.count + "× " + e.item_name + (e.variation_name ? " (" + e.variation_name + ")" : ""));
                li.textContent = label + " ";
                var rm = document.createElement("button");
                rm.className = "btn btn-link btn-xs";
                rm.type = "button";
                rm.textContent = "✕";
                rm.addEventListener("click", function () { removeFromCart(e.key); });
                li.appendChild(rm);
                ul.appendChild(li);
            });
            cartEl.appendChild(ul);
            reserveBtn.disabled = false;
            sellBtn.disabled = false;
        }

        function buildPositions() {
            var positions = [];
            cart.forEach(function (e) {
                if (e.type === "seat") {
                    positions.push({ item: e.item_id, seat: e.seat_guid });
                } else {
                    for (var i = 0; i < e.count; i++) {
                        var p = { item: e.item_id };
                        if (e.variation_id) p.variation = e.variation_id;
                        positions.push(p);
                    }
                }
            });
            return positions;
        }

        function submitOrder(mode) {
            var positions = buildPositions();
            if (!positions.length) return;
            reserveBtn.disabled = true;
            sellBtn.disabled = true;
            orderMsgEl.textContent = "Zpracovávám…";
            jsonFetch(apiCreateOrder, {
                method: "POST",
                body: JSON.stringify({
                    mode: mode,
                    positions: positions,
                    subevent: currentSubevent() || null,
                    email: emailInput.value.trim(),
                    send_email: false,
                }),
            }).then(function (res) {
                if (res.status !== 201 || !res.data.ok) {
                    orderMsgEl.textContent = "Chyba: " + ((res.data && res.data.error) || "unknown");
                    renderCart();
                    return;
                }
                orderMsgEl.textContent = (mode === "sell" ? "Prodáno" : "Rezervováno") + ", kód objednávky: " + res.data.code;
                cart = [];
                cartInCartSeatGuids = {};
                renderCart();
                showOrderDetail(res.data);
            });
        }

        reserveBtn.addEventListener("click", function () { submitOrder("reserve"); });
        sellBtn.addEventListener("click", function () { submitOrder("sell"); });

        // --- search / existing order -------------------------------------

        function doSearch() {
            var q = searchInput.value.trim();
            if (!q) return;
            jsonFetch(apiSearch + "?q=" + encodeURIComponent(q), { method: "GET" }).then(function (res) {
                renderSearchResults((res.data && res.data.orders) || []);
            });
        }

        function renderSearchResults(orders) {
            searchResultsEl.innerHTML = "";
            if (!orders.length) {
                searchResultsEl.textContent = "Nic nenalezeno.";
                return;
            }
            orders.forEach(function (o) {
                var div = document.createElement("div");
                div.className = "pos-search-result";
                div.textContent = o.code + " — " + (o.email || "—") + " — " + o.status_display + " — " + o.total;
                div.addEventListener("click", function () { loadOrderDetail(o.code); });
                searchResultsEl.appendChild(div);
            });
        }

        function loadOrderDetail(code) {
            jsonFetch(apiOrder + "?code=" + encodeURIComponent(code), { method: "GET" }).then(function (res) {
                if (res.status !== 200 || !res.data.ok) {
                    orderDetailEl.textContent = "Objednávka nenalezena.";
                    return;
                }
                showOrderDetail(res.data);
            });
        }

        function showOrderDetail(order) {
            orderDetailEl.innerHTML = "";

            var h = document.createElement("h4");
            h.textContent = order.code + " (" + order.status_display + ")";
            orderDetailEl.appendChild(h);

            var p = document.createElement("p");
            p.textContent = "Celkem: " + order.total +
                (order.pending_sum && order.pending_sum !== "0.00" ? " — k doplacení: " + order.pending_sum : " — zaplaceno");
            orderDetailEl.appendChild(p);

            var ul = document.createElement("ul");
            (order.positions || []).forEach(function (pos) {
                var li = document.createElement("li");
                li.textContent = pos.item + (pos.variation ? " (" + pos.variation + ")" : "") +
                    (pos.seat_label ? " — " + pos.seat_label : (pos.needs_seat ? " — bez místa" : ""));
                ul.appendChild(li);
            });
            orderDetailEl.appendChild(ul);

            if (order.status === "n") {
                var payBtn = document.createElement("button");
                payBtn.className = "btn btn-primary";
                payBtn.type = "button";
                payBtn.textContent = "Zaplatit hotově";
                payBtn.addEventListener("click", function () {
                    jsonFetch(apiPay, { method: "POST", body: JSON.stringify({ code: order.code }) }).then(function (res) {
                        if (res.status !== 200 || !res.data.ok) {
                            orderDetailEl.appendChild(document.createTextNode(
                                "Chyba: " + ((res.data && res.data.error) || "unknown")
                            ));
                            return;
                        }
                        showOrderDetail(res.data);
                    });
                });
                orderDetailEl.appendChild(payBtn);
                orderDetailEl.appendChild(document.createTextNode(" "));
            }

            if (seatingAssignUrl) {
                var a = document.createElement("a");
                a.href = seatingAssignUrl + "?code=" + encodeURIComponent(order.code);
                a.className = "btn btn-default";
                a.target = "_blank";
                a.rel = "noopener";
                a.textContent = "Přiřadit sedadla";
                orderDetailEl.appendChild(a);
            }
        }

        searchBtn.addEventListener("click", doSearch);
        searchInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); doSearch(); }
        });

        if (subeventSelect) {
            subeventSelect.addEventListener("change", function () {
                cart = [];
                cartInCartSeatGuids = {};
                renderCart();
                loadItems();
            });
        } else {
            loadItems();
        }
        renderCart();
    });
})();
