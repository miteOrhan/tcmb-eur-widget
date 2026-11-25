"use strict";

/**
 * TCMB resmî günlük kur servisi (EUR/TRY).
 * - today.xml → son yayımlanan bülten
 * - önceki iş günü XML'i → günlük değişim yüzdesi
 * - disk önbelleği → internet yokken son iyi veriyi gösterir
 */

const fs = require("node:fs");
const path = require("node:path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TCMB-EUR-Widget/1.0";
const TODAY_URL = "https://www.tcmb.gov.tr/kurlar/today.xml";
const TIMEOUT = 12000;
const TTL = 10 * 60 * 1000;

const round4 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function parseTcmbXml(xml) {
  if (!xml || !xml.includes("<Tarih_Date")) throw new Error("TCMB XML okunamadı");

  const date = (xml.match(/<Tarih_Date[^>]*\bTarih="([^"]+)"/) || [])[1] || null;
  const block = (xml.match(/<Currency[^>]*CurrencyCode="EUR"[^>]*>([\s\S]*?)<\/Currency>/) || [])[1];
  if (!block) throw new Error("EUR verisi bulunamadı");

  const pick = (tag) => {
    const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    if (!m) return null;
    const n = Number(String(m[1]).replace(",", ".").trim());
    return Number.isFinite(n) ? n : null;
  };

  return { date, buy: pick("ForexBuying"), sell: pick("ForexSelling") };
}

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* Ağ hatasında gün geriye doğru denemek anlamsız; hemen önbelleğe düş. */
function isNetworkError(err) {
  return (
    err?.name === "TimeoutError" ||
    err?.name === "AbortError" ||
    err instanceof TypeError ||
    /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(String(err?.message || err))
  );
}

function istanbulToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("day")}.${get("month")}.${get("year")}`;
}

function shiftDay(dateStr, delta) {
  const [dd, mm, yyyy] = String(dateStr).split(".").map(Number);
  if (!dd || !mm || !yyyy) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd, 12));
  d.setUTCDate(d.getUTCDate() + delta);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function urlFor(dateStr) {
  const [dd, mm, yyyy] = String(dateStr).split(".");
  return `https://www.tcmb.gov.tr/kurlar/${yyyy}${mm}/${dd}${mm}${yyyy}.xml`;
}

async function bulletinFrom(dateStr, maxBack = 10) {
  let d = dateStr;
  for (let i = 0; i < maxBack; i++) {
    try {
      const parsed = parseTcmbXml(await fetchXml(urlFor(d)));
      if (parsed.buy != null && parsed.sell != null) return parsed;
    } catch (err) {
      if (isNetworkError(err)) throw err;
    }
    d = shiftDay(d, -1);
    if (!d) break;
  }
  return null;
}

async function fetchBulletin() {
  try {
    const parsed = parseTcmbXml(await fetchXml(TODAY_URL));
    if (parsed.buy != null && parsed.sell != null) return parsed;
  } catch (err) {
    if (isNetworkError(err)) throw err;
  }

  const found = await bulletinFrom(shiftDay(istanbulToday(), -1));
  if (found) return found;
  throw new Error("TCMB kuru alınamadı");
}

async function fetchPrevious(bulletinDate) {
  if (!bulletinDate) return null;
  let d = bulletinDate;
  for (let i = 0; i < 10; i++) {
    d = shiftDay(d, -1);
    if (!d) return null;
    try {
      const parsed = parseTcmbXml(await fetchXml(urlFor(d)));
      if (parsed.buy != null && parsed.sell != null) return parsed;
    } catch (err) {
      if (isNetworkError(err)) return null;
    }
  }
  return null;
}

async function fetchRates() {
  const cur = await fetchBulletin();
  const prev = await fetchPrevious(cur.date);

  const change = (now, before) =>
    now != null && before != null && before !== 0 ? round2((now / before - 1) * 100) : null;

  return {
    currency: "EUR",
    date: cur.date,
    time: "15:30",
    buy: round4(cur.buy),
    sell: round4(cur.sell),
    buyChangePct: change(cur.buy, prev?.buy),
    sellChangePct: change(cur.sell, prev?.sell),
    prevDate: prev?.date || null,
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}

function createService({ cacheFile, ttl = TTL } = {}) {
  let data = null;
  let at = 0;
  let inflight = null;

  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (raw && raw.data) {
      data = raw.data;
      at = Number(raw.at) || 0;
    }
  } catch {
    /* ilk çalıştırma */
  }

  function persist() {
    try {
      if (cacheFile) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ at, data }));
      }
    } catch {
      /* önbellek yazılamasa da devam */
    }
  }

  function current() {
    if (!data) return null;
    const fresh = at > 0 && Date.now() - at < ttl;
    return { ...data, stale: !fresh };
  }

  async function get(force = false) {
    if (!force && data && Date.now() - at < ttl) return { ...data, stale: false };
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        data = await fetchRates();
        at = Date.now();
        persist();
        return { ...data, stale: false };
      } catch (err) {
        if (data) return { ...data, stale: true, error: String(err.message || err) };
        throw err;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  return { get, current };
}

module.exports = { createService, fetchRates, parseTcmbXml };
