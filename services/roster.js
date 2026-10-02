/**
 * Who is supposed to be working, and when.
 *
 * A hotel does not close, so the week is not a grid of arbitrary times: it is
 * two shifts going round the clock, and a person is on one of them or off. The
 * property sets the changeover — when mornings start, and when nights do — and
 * each shift runs until the other begins.
 *
 * Two times rather than four is the whole design. Four free times can be set to
 * leave an hour at dawn covered by nobody, or two hours covered by both, and
 * neither mistake announces itself; it surfaces weeks later as an argument
 * about who was meant to be there. Two times cannot express a gap.
 *
 * The night shift crosses midnight, which is not an edge case here but half of
 * every day. At one in the morning the person due is the one rostered for last
 * night, and anyone asking has to be told that rather than "nobody".
 *
 * A person may be put on both shifts of the same day — a double. Short-staffed
 * weeks are ordinary at a hotel, and a roster that cannot say "she is covering
 * Tuesday on her own" gets worked around by not writing it down at all, which
 * is worse than writing down twenty-four hours. Two of the same shift on one
 * day is still refused: that is a slip of the hand, not a longer day.
 */

const { minutesNow, weekdayOf } = require("../utils/day");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Rosters read Monday first, which is how the week is said aloud. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHIFT_KEYS = ["morning", "night"];

const DEFAULT_TIMES = { morningStartsAt: "07:00", nightStartsAt: "19:00" };

const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));

/** "08:30" -> 510. */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** The window each shift covers, derived from the two changeover times. */
function windowsFor(times = DEFAULT_TIMES) {
  const morning = times.morningStartsAt || DEFAULT_TIMES.morningStartsAt;
  const night = times.nightStartsAt || DEFAULT_TIMES.nightStartsAt;
  return {
    morning: { key: "morning", name: "Morning", startsAt: morning, endsAt: night },
    night: { key: "night", name: "Night", startsAt: night, endsAt: morning },
  };
}

/** A shift that ends at or before it starts runs through midnight. */
const wrapsMidnight = (w) => minutesOf(w.endsAt) <= minutesOf(w.startsAt);

/** How long a shift lasts, in minutes, counting the wrap. */
function lengthOf(w) {
  const start = minutesOf(w.startsAt);
  const end = minutesOf(w.endsAt);
  return end > start ? end - start : 1440 - start + end;
}

/** Is this minute-of-day inside the window? */
function covers(w, mins) {
  const start = minutesOf(w.startsAt);
  const end = minutesOf(w.endsAt);
  return wrapsMidnight(w) ? mins >= start || mins < end : mins >= start && mins < end;
}

/**
 * Whether somebody is rostered on at a given moment, and on which shift.
 *
 * Checks every shift rostered for today and yesterday's too, because a night
 * shift started yesterday is still running in the small hours — that is half of
 * every day at a hotel, not an edge case. Somebody on a double is on today's
 * morning and today's night, so both have to be looked at.
 */
function onRosterAt(shifts, times, at = new Date()) {
  const list = (shifts || []).filter((s) => SHIFT_KEYS.includes(s.shift));
  if (!list.length) return { on: false, shift: null, window: null };

  const w = windowsFor(times);
  const day = weekdayOf(at);
  const mins = minutesNow(at);

  // Every shift rostered for today, because somebody may be on both of them.
  // The two windows tile the clock without overlapping, so at most one of them
  // can be the answer.
  for (const s of list.filter((x) => x.day === day)) {
    const window = w[s.shift];
    if (!covers(window, mins)) continue;
    // A wrapping shift covers both ends of the day; only the part at or after
    // its start belongs to today's assignment. The small hours belong to
    // yesterday's.
    if (wrapsMidnight(window) && mins < minutesOf(window.startsAt)) continue;
    return { on: true, shift: s.shift, window };
  }

  // Still on last night's shift, in the morning after.
  for (const s of list.filter((x) => x.day === (day + 6) % 7)) {
    const window = w[s.shift];
    if (wrapsMidnight(window) && mins < minutesOf(window.endsAt)) {
      return { on: true, shift: s.shift, window };
    }
  }

  return { on: false, shift: null, window: null };
}

/**
 * The shifts somebody is rostered for on the calendar day of `at`, in the
 * order the day runs them. Two of them is a double.
 */
function shiftsOn(shifts, at = new Date()) {
  const day = weekdayOf(at);
  return SHIFT_KEYS.filter((key) =>
    (shifts || []).some((s) => s.day === day && s.shift === key));
}

/** Validation for a roster a manager has just set. */
function badRoster(shifts) {
  if (shifts === undefined) return null;
  if (!Array.isArray(shifts)) return "Send the shifts as a list.";
  // Seven days, two shifts each: a fortnight's worth of entries is impossible.
  if (shifts.length > 14) return "There are only seven days in a week.";

  const seen = new Set();
  for (const s of shifts) {
    if (!Number.isInteger(s?.day) || s.day < 0 || s.day > 6) return "Each shift needs a day of the week.";
    if (!SHIFT_KEYS.includes(s.shift)) {
      return DAYS[s.day] + " must be the morning shift or the night shift.";
    }
    // Both shifts on one day is a double, and allowed. The same shift twice is
    // a slip.
    const key = s.day + ":" + s.shift;
    if (seen.has(key)) {
      return DAYS[s.day] + " has the " + s.shift + " shift on it twice.";
    }
    seen.add(key);
  }
  return null;
}

/** Validation for the two changeover times. */
function badTimes({ morningStartsAt, nightStartsAt } = {}) {
  if (!isTime(morningStartsAt) || !isTime(nightStartsAt)) {
    return "Give both changeover times as HH:MM.";
  }
  if (morningStartsAt === nightStartsAt) {
    return "The two shifts cannot change over at the same moment — one of them would be the whole day and the other nothing.";
  }
  return null;
}

/** Tidied, and in the order a week is read. */
function cleanRoster(shifts) {
  const seen = new Set();
  return (shifts || [])
    .filter((s) => SHIFT_KEYS.includes(s.shift))
    .filter((s) => {
      const key = s.day + ":" + s.shift;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s) => ({ day: s.day, shift: s.shift }))
    // Day first, and within a double the morning comes before the night it
    // runs into.
    .sort((a, b) =>
      WEEK_ORDER.indexOf(a.day) - WEEK_ORDER.indexOf(b.day) ||
      SHIFT_KEYS.indexOf(a.shift) - SHIFT_KEYS.indexOf(b.shift));
}

module.exports = {
  DAYS, WEEK_ORDER, SHIFT_KEYS, DEFAULT_TIMES,
  minutesOf, windowsFor, wrapsMidnight, lengthOf, covers,
  onRosterAt, shiftsOn, badRoster, badTimes, cleanRoster, isTime,
};
