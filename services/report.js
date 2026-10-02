/**
 * The arithmetic behind a filed month-end or year-end record.
 *
 * Split out from the route because these three are the parts that are easy to
 * get quietly wrong and impossible to notice: a window that ends a day early
 * drops the busiest day of the month, and a combined average worked out the
 * obvious way is true of neither property. Both are testable here without a
 * database, and both are tested.
 */

const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Calendar arithmetic over plain dates, shared with everything else that does
// it — three private copies of "the day after this one" is three chances for
// one of them to be subtly different.
const { shiftDays, daysBetween } = require("../utils/day");

/** The day after this one, so a range the user gave inclusively ends correctly. */
const dayAfter = (iso) => shiftDays(iso, 1);

/** A date as a person writes it — "3 September 2026". */
function prettyDay(iso) {
  const [y, m, d] = iso.split("-");
  return Number(d) + " " + MONTHS[Number(m) - 1] + " " + y;
}

/**
 * First day of the window, and the first day after it.
 *
 * Three shapes, and the distinction between them matters beyond convenience.
 * A month and a year are *named* periods — they close, they get filed, and the
 * month-end prompt is built on being able to say "September 2026" and mean
 * exactly one thing. An arbitrary range is a question somebody is asking today
 * ("how did the long weekend go?") and will never be filed under a name. Both
 * are wanted; only the first two can be asked for again later and mean the
 * same thing.
 *
 * `to` is always exclusive internally — the first instant of the day after —
 * because a window that stops at midnight on its last day silently drops
 * everything that happened on it. The range the user typed is inclusive of
 * both ends, which is what anyone means by "3rd to the 9th", so it is
 * converted here rather than in each caller.
 */
function windowFor(query) {
  if (query.period === "range") {
    const { from, to } = query;
    if (!isDay(from) || !isDay(to)) return null;
    if (to < from) return null;
    return {
      kind: "range",
      label: from === to ? prettyDay(from) : prettyDay(from) + " to " + prettyDay(to),
      from,
      to: dayAfter(to),
      // Kept so the page can put back in the date pickers exactly what was
      // typed, rather than the exclusive end nobody asked for.
      lastDay: to,
    };
  }
  if (query.period === "year") {
    const year = Number(query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
    return { kind: "year", label: String(year), from: year + "-01-01", to: (year + 1) + "-01-01" };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(String(query.month || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    kind: "month",
    label: MONTHS[month - 1] + " " + year,
    from: m[1] + "-" + m[2] + "-01",
    to: nextYear + "-" + String(nextMonth).padStart(2, "0") + "-01",
  };
}

/** How many nights the window spans — the denominator for occupancy. */
const nightsIn = (from, to) => daysBetween(from, to);


/** Adds two property reports into the collective one. */
function combine(reports) {
  const sum = (fn) => reports.reduce((s, r) => s + fn(r), 0);
  const mergeCounts = (fn) => reports.reduce((a, r) => {
    Object.entries(fn(r)).forEach(([k, v]) => { a[k] = (a[k] || 0) + v; });
    return a;
  }, {});

  const nightsSold = sum((r) => r.rooms.nightsSold);
  const nightsAvailable = sum((r) => r.rooms.nightsAvailable);
  const roomRevenue = sum((r) => r.rooms.revenue);
  const facilityTotal = sum((r) => r.facilities.total);

  return {
    rooms: {
      sellable: sum((r) => r.rooms.sellable),
      bookings: sum((r) => r.rooms.bookings),
      nightsSold, nightsAvailable,
      occupancyPercent: nightsAvailable ? Math.round((nightsSold / nightsAvailable) * 100) : 0,
      // Recomputed from the combined totals, never averaged from the two
      // branches: averaging two ADRs weights a 15-room property equally with a
      // 21-room one and gives a figure that is true of neither.
      averageDailyRate: nightsSold ? Math.round(roomRevenue / nightsSold) : 0,
      revPAR: nightsAvailable ? Math.round(roomRevenue / nightsAvailable) : 0,
      revenue: roomRevenue,
      discountsGiven: sum((r) => r.rooms.discountsGiven),
      byRoomType: reports.reduce((a, r) => {
        Object.entries(r.rooms.byRoomType).forEach(([k, v]) => {
          const t = (a[k] = a[k] || { bookings: 0, nights: 0, revenue: 0 });
          t.bookings += v.bookings; t.nights += v.nights; t.revenue += v.revenue;
        });
        return a;
      }, {}),
      bySource: mergeCounts((r) => r.rooms.bySource),
    },
    facilities: {
      total: facilityTotal,
      chargedToRooms: sum((r) => r.facilities.chargedToRooms),
      paidAtTill: sum((r) => r.facilities.paidAtTill),
      byFacility: reports.flatMap((r) =>
        r.facilities.byFacility.map((f) => ({ ...f, property: r.name }))
      ).sort((a, b) => b.revenue - a.revenue),
    },
    collected: {
      byMethod: mergeCounts((r) => r.collected.byMethod),
      payments: sum((r) => r.collected.payments),
      cardFees: sum((r) => r.collected.cardFees),
      total: sum((r) => r.collected.total),
    },
    revenue: { rooms: roomRevenue, facilities: facilityTotal, total: roomRevenue + facilityTotal },
  };
}



/**
 * Which named periods have closed and not yet been taken away by this person.
 *
 * Deliberately short-sighted: the last three closed months and the last closed
 * year, nothing older. A prompt that reaches back to 2019 is a prompt nobody
 * reads, and any period at all can still be pulled by hand whenever it is
 * wanted. The point is the one at the top of the list — the month that just
 * ended, while it is still the thing on everyone's mind.
 *
 * `since` is the day this system started holding records. Nothing that closed
 * before it is ever due: a hotel that went live in September is not behind on
 * last year's accounts, and being told on the first morning that it owes itself
 * a copy of a year it has no figures for teaches everyone to dismiss the prompt
 * — which costs the one month it exists for.
 */
function periodsDue(todayIso, alreadyTaken = [], since = null) {
  const taken = new Set(alreadyTaken.map((t) => t.kind + ":" + t.period));
  const [y, m] = todayIso.split("-").map(Number);
  const sinceMonth = since ? String(since).slice(0, 7) : null;   // "2026-09"
  const sinceYear = sinceMonth ? Number(sinceMonth.slice(0, 4)) : null;
  const due = [];

  // The year, first: it is the bigger document and the easier one to forget.
  const lastYear = y - 1;
  if (lastYear >= 2000 && !taken.has("year:" + lastYear) &&
      (sinceYear === null || lastYear >= sinceYear)) {
    due.push({ kind: "year", period: String(lastYear), label: String(lastYear) });
  }

  for (let back = 1; back <= 3; back++) {
    let mm = m - back;
    let yy = y;
    while (mm < 1) { mm += 12; yy -= 1; }
    const period = yy + "-" + String(mm).padStart(2, "0");
    if (taken.has("month:" + period)) continue;
    if (sinceMonth && period < sinceMonth) continue;
    due.push({ kind: "month", period, label: MONTHS[mm - 1] + " " + yy });
  }

  return due;
}

module.exports = { windowFor, nightsIn, combine, dayAfter, periodsDue, MONTHS };
