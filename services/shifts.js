const Shift = require("../models/Shift");
const ShiftTimes = require("../models/ShiftTimes");
const { onRosterAt, DEFAULT_TIMES } = require("./roster");

/** The changeover times at a property, or the defaults if none are set yet. */
async function timesFor(location) {
  if (location === "all") return DEFAULT_TIMES;
  const doc = await ShiftTimes.findOne({ location }).lean();
  return doc || DEFAULT_TIMES;
}

/**
 * Opening and closing the shift somebody is actually working.
 *
 * A shift opens when they sign in, because that is the only moment the system
 * can know for certain that a person has arrived. It does not close when they
 * sign out: a receptionist moving from the desk computer to their phone signs
 * out twice in a minute and has gone home neither time. Closing is asked for.
 */

/** The shift this person has open, if any. */
const openShiftFor = (userId) =>
  Shift.findOne({ user: userId, endedAt: { $exists: false } }).sort({ startedAt: -1 });

/**
 * Opens one if none is open, and returns it either way.
 *
 * Signing in twice in a morning must not start a second shift — the first is
 * still running and this is the same day's work. Idempotent for that reason.
 */
async function startShift(user) {
  const existing = await openShiftFor(user._id);
  if (existing) {
    // Still the same shift, but the caller wants to know what the roster says
    // now, not what it said when the shift opened.
    const times = await timesFor(user.location);
    return { shift: existing, opened: false, roster: onRosterAt(user.shifts, times, new Date()) };
  }

  // What the roster said right now, written down while it is still true. A
  // manager editing the roster next week must not change what today looked like.
  const times = await timesFor(user.location);
  const roster = onRosterAt(user.shifts, times, new Date());
  const { on, shift: which, window } = roster;

  const shift = await Shift.create({
    user: user._id,
    location: user.location,
    startedAt: new Date(),
    wasRostered: on,
    rosteredShift: which || undefined,
    rosteredStart: window?.startsAt,
    rosteredEnd: window?.endsAt,
  });
  return { shift, opened: true, roster };
}

/** Closes whatever is open. `by` is usually them; a manager may close another's. */
async function endShift(userId, by) {
  const shift = await openShiftFor(userId);
  if (!shift) return null;
  shift.endedAt = new Date();
  shift.endedBy = by;
  await shift.save();
  return shift;
}

/** How long a shift has run, in minutes. */
const minutesWorked = (shift) =>
  Math.max(0, Math.round(((shift.endedAt || new Date()) - shift.startedAt) / 60000));

module.exports = { openShiftFor, startShift, endShift, minutesWorked, timesFor };
