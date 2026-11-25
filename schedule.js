"use strict";

/**
 * TCMB günlük bülten kontrol zamanları (İstanbul saati).
 * Bülten genelde 15:30 civarı yayımlanır; 15:31, 15:35 ve 15:40'ta kontrol edilir.
 */
const CHECKPOINTS = [
  [15, 31],
  [15, 35],
  [15, 40],
];

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function istanbulOffsetMs(date) {
  const p = istanbulParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

function istanbulDay(date = new Date()) {
  const p = istanbulParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function nextCheckpoint(from = new Date(), checkpoints = CHECKPOINTS) {
  const p = istanbulParts(from);
  const offset = istanbulOffsetMs(from);
  const dayStart = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);

  for (const [hour, minute] of checkpoints) {
    const at = dayStart + hour * 3600000 + minute * 60000 - offset;
    if (at > from.getTime()) return new Date(at);
  }

  const [hour, minute] = checkpoints[0];
  const tomorrowStart = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  return new Date(tomorrowStart + hour * 3600000 + minute * 60000 - offset);
}

module.exports = { CHECKPOINTS, istanbulDay, istanbulParts, nextCheckpoint };
