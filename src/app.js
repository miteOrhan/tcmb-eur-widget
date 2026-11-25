"use strict";

const $ = (id) => document.getElementById(id);

const card = $("widget");
const nf = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const fmt = (v) => (v == null || !Number.isFinite(v) ? "—" : nf.format(v));

function shortTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function setPct(el, value, prevDate) {
  el.className = "pct";
  if (value == null || !Number.isFinite(value)) {
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "•";
  el.textContent = `${arrow} %${Math.abs(value).toFixed(2).replace(".", ",")}`;
  el.classList.add(value > 0 ? "up" : value < 0 ? "down" : "flat");
  el.title = `Önceki iş gününe göre${prevDate ? ` (${prevDate})` : ""}`;
}

function render(data) {
  if (!data) return;

  const hasValues = data.buy != null && data.sell != null;
  card.classList.toggle("loading", !hasValues && !data.error);
  card.classList.toggle("stale", !!data.stale && hasValues);
  card.classList.toggle("error", !!data.error && !hasValues);

  if (hasValues) {
    $("buy").textContent = fmt(data.buy);
    $("sell").textContent = fmt(data.sell);
    $("buy").title = `${fmt(data.buy)} ₺ · alış`;
    $("sell").title = `${fmt(data.sell)} ₺ · satış`;
    setPct($("buyPct"), data.buyChangePct, data.prevDate);
    setPct($("sellPct"), data.sellChangePct, data.prevDate);
    $("date").textContent = `${data.time || "15:30"} · ${data.date || "—"}`;
    $("date").title = "TCMB resmî günlük gösterge kuru";
  } else {
    $("buy").textContent = "—";
    $("sell").textContent = "—";
    setPct($("buyPct"), null);
    setPct($("sellPct"), null);
    $("date").textContent = data.error ? "TCMB verisi alınamadı" : "Veri yükleniyor…";
  }

  if (data.error && hasValues) {
    $("updated").textContent = "eski veri";
  } else if (data.error) {
    $("updated").textContent = "tekrar dene";
  } else {
    $("updated").textContent = shortTime(data.updatedAt);
  }
}

async function refreshNow() {
  const btn = $("refresh");
  if (btn.classList.contains("spin")) return;
  btn.classList.add("spin");
  try {
    await window.widget.refresh();
  } catch {
    /* durum ana süreçten gelir */
  } finally {
    setTimeout(() => btn.classList.remove("spin"), 650);
  }
}

function markRendered() {
  const started = Date.now();
  const timer = setInterval(() => {
    const ready = $("buy").textContent !== "—";
    if (ready || Date.now() - started > 12000) {
      clearInterval(timer);
      window.widget.rendered();
    }
  }, 200);
}

function boot() {
  window.widget.debug("boot");
  window.addEventListener("error", (event) => window.widget.debug("error: " + event.message));

  $("refresh").addEventListener("click", refreshNow);
  $("hide").addEventListener("click", () => window.widget.hide());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.widget.hide();
  });

  window.widget.onRates(render);

  window.widget
    .getRates()
    .then((data) => {
      window.widget.debug("getRates: " + (data ? "data" : "null"));
      if (data) render(data);
    })
    .catch((err) => window.widget.debug("getRates error: " + (err?.message || err)));

  markRendered();
}

boot();
