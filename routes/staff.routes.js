const router = require("express").Router();
const User = require("../models/User");
const Facility = require("../models/Facility");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { ROLES } = require("../utils/constants");
const Shift = require("../models/Shift");
const AuditLog = require("../models/AuditLog");
const ShiftTimes = require("../models/ShiftTimes");
const { badRoster, badTimes, cleanRoster, onRosterAt, shiftsOn, windowsFor, DEFAULT_TIMES } = require("../services/roster");
const { endShift, timesFor } = require("../services/shifts");
const { dayStart, dayEnd, today, shiftDays } = require("../utils/day");

router.use(requireAuth, requireRole("manager", "owner"));

/**
 * Resolves the facilities a user is being assigned to and checks every one of
 * them sits at that user's own property. A Divic Urban bartender must never be
 * assignable to a Divic 1 bar, so this returns an error string rather
 * than silently dropping the ones that do not belong.
 */
async function resolveAssignedFacilities(ids, location) {
  if (!Array.isArray(ids)) {
    return { error: "Send the assigned facilities as a list." };
  }
  const wanted = [...new Set(ids.map(String))];
  if (!wanted.length) return { ids: [] };
  if (!["exclusive", "urban"].includes(location)) {
    return { error: "Give this person a property before assigning them facilities." };
  }
  let found;
  try {
    found = await Facility.find({ _id: { $in: wanted } }).select("location name").lean();
  } catch {
    return { error: "One of those facilities is not a valid record." };
  }
  if (found.length !== wanted.length) {
    return { error: "One of those facilities does not exist." };
  }
  const wrong = found.find((f) => f.location !== location);
  if (wrong) {
    return { error: wrong.name + " is at the other property and cannot be assigned to this person." };
  }
  return { ids: found.map((f) => f._id) };
}

router.get("/", async (req, res, next) => {
  try {
    // A manager cannot see or touch owner accounts.
    const filter = req.user.role === "owner" ? {} : { role: { $ne: "owner" } };
    // People who have left are off the list unless somebody asks for them —
    // their records are kept so the history they made still has a name on it.
    if (req.query.includeRemoved !== "1") filter.removedAt = { $exists: false };
    const users = await User.find(filter).sort({ name: 1 });

    // Who is actually signed on, in one query rather than one per person.
    const open = await Shift.find({
      user: { $in: users.map((u) => u._id) }, endedAt: { $exists: false },
    }).select("user startedAt wasRostered").lean();
    const openBy = Object.fromEntries(open.map((s) => [String(s.user), s]));

    // Both properties' changeover times, fetched once. A manager covering
    // both sees each person judged against their own building's hours.
    const allTimes = await ShiftTimes.find().lean();
    const timesBy = Object.fromEntries(allTimes.map((t) => [t.location, t]));

    const now = new Date();
    res.json(users.map((u) => {
      const shift = openBy[String(u._id)];
      const roster = onRosterAt(u.shifts, timesBy[u.location] || DEFAULT_TIMES, now);
      return {
        ...u.toSafeJSON(),
        lastLoginAt: u.lastLoginAt,
        failedLoginAttempts: u.failedLoginAttempts || 0,
        loginLocked: Boolean(u.loginLockedAt),
        loginLockedAt: u.loginLockedAt || null,
        // Two different questions, and the gap between them is the point.
        onShift: Boolean(shift),
        shiftStartedAt: shift?.startedAt || null,
        shiftMinutes: shift ? Math.round((now - new Date(shift.startedAt)) / 60000) : 0,
        dueOn: roster.on,
        dueShift: roster.shift,
        dueWindow: roster.window ? roster.window.startsAt + "–" + roster.window.endsAt : null,
        // What the whole of today asks of them. Two entries is a double, and a
        // manager reading the board needs to see that before somebody has been
        // there sixteen hours.
        dueToday: shiftsOn(u.shifts, now),
      };
    }));
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, username, password, role, location, phone, assignedFacilities, shifts } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: "A new account needs a name, username and starting password." });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a valid role." });
    if (password.length < 8) return res.status(400).json({ error: "The starting password needs at least 8 characters." });
    // Only an owner can mint managers or other owners. Facility staff are a
    // manager's to create.
    if (req.user.role === "manager" && !["receptionist", "cleaner", "facility"].includes(role)) {
      return res.status(403).json({ error: "Only the owner can create manager or owner accounts." });
    }
    if (location === "all" && !["manager", "owner", "receptionist"].includes(role)) {
      return res.status(400).json({ error: "Managers, owners, and receptionists can cover both properties." });
    }

    let assigned = [];
    if (role === "facility") {
      const check = await resolveAssignedFacilities(assignedFacilities || [], location);
      if (check.error) return res.status(400).json({ error: check.error });
      assigned = check.ids;
    } else if (assignedFacilities && assignedFacilities.length) {
      return res.status(400).json({ error: "Only facility staff can be assigned to facilities." });
    }

    const rosterError = badRoster(shifts);
    if (rosterError) return res.status(400).json({ error: rosterError });

    const user = new User({
      name, username: username.toLowerCase().trim(), role, location, phone,
      assignedFacilities: assigned,
      shifts: cleanRoster(shifts),
    });
    await user.setPassword(password);
    await user.save();

    logAction(req, {
      action: "Created a " + role + " account for " + name +
        (user.shifts.length
          ? " on a roster of " + user.shifts.length + " shift" + (user.shifts.length === 1 ? "" : "s")
          : " with no shifts set"),
      entity: "User", entityId: user._id,
    });
    res.status(201).json(user.toSafeJSON());
  } catch (e) { next(e); }
});

router.post("/:id/unlock-login", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });

    // A manager may unlock operational staff but not an owner account.
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can unlock an owner account." });
    }

    const wasLocked = Boolean(user.loginLockedAt || user.failedLoginAttempts);
    user.failedLoginAttempts = 0;
    user.loginLockedAt = undefined;
    user.loginUnlockedAt = new Date();
    await user.save();

    logAction(req, {
      action: "Granted login access to " + user.name,
      entity: "User",
      entityId: user._id,
      location: user.location,
      after: { loginAccessGranted: true, wasLocked },
    });

    res.json({
      ok: true,
      message: user.name + " can sign in again.",
      user: {
        ...user.toSafeJSON(),
        failedLoginAttempts: 0,
        loginLocked: false,
        loginLockedAt: null,
        loginUnlockedAt: user.loginUnlockedAt,
      },
    });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/staff/:id — somebody has left.
 *
 * Two outcomes, and which one you get depends on whether the account ever did
 * anything. An account created by mistake ten minutes ago is deleted outright.
 * An account that has signed in, worked a shift, taken a payment or changed a
 * booking is kept and marked as gone: nineteen collections carry its id, and
 * deleting the row would quietly turn every payment it took and every booking
 * it made into "somebody". That is not a tidier system, it is a system that
 * cannot answer who did this.
 *
 * Either way it leaves the staff list, cannot sign in, and its shift is closed.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });
    if (user.removedAt) return res.status(409).json({ error: user.name + " has already been removed." });

    if (String(user._id) === String(req.user.id || req.user._id)) {
      return res.status(400).json({ error: "You cannot remove your own account." });
    }
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can remove an owner account." });
    }
    // The last way into the system is not something one click should be able
    // to close.
    if (user.role === "owner") {
      const owners = await User.countDocuments({
        role: "owner", active: true, removedAt: { $exists: false }, _id: { $ne: user._id },
      });
      if (!owners) {
        return res.status(400).json({ error: "This is the last owner account. Make somebody else an owner first." });
      }
    }

    // Every write in this system goes through the audit log, so an account
    // with no audit entry, no shift and no sign-in has touched nothing and
    // nothing can be pointing at it.
    const [entries, shifts] = await Promise.all([
      AuditLog.countDocuments({ user: user._id }),
      Shift.countDocuments({ user: user._id }),
    ]);
    const hasHistory = Boolean(entries || shifts || user.lastLoginAt);

    // Going home is implied by leaving. An open shift left running would sit
    // on the board forever.
    await endShift(user._id, req.user.id || req.user._id);

    if (hasHistory) {
      user.active = false;
      user.removedAt = new Date();
      await user.save();
    } else {
      await User.deleteOne({ _id: user._id });
    }

    logAction(req, {
      action: "Removed " + user.name + "'s account" +
        (hasHistory ? " — kept on record, they had history" : " — deleted, it had no history"),
      entity: "User", entityId: user._id, location: user.location,
    });

    res.json({
      ok: true,
      deleted: !hasHistory,
      message: hasHistory
        ? user.name + " has been removed from the staff list. Their record is kept so everything they did still has their name on it."
        : user.name + "'s account had no history and has been deleted outright.",
    });
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can change an owner account." });
    }

    const { name, role, location, phone, password, active, assignedFacilities, shifts } = req.body;
    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (shifts !== undefined) {
      const rosterError = badRoster(shifts);
      if (rosterError) return res.status(400).json({ error: rosterError });
      user.shifts = cleanRoster(shifts);
    }
    if (role) {
      if (req.user.role === "manager" && !["receptionist", "cleaner", "facility"].includes(role)) {
        return res.status(403).json({ error: "Only the owner can assign manager or owner roles." });
      }
      user.role = role;
    }
    if (location) user.location = location;

    // Same rule POST enforces: "all" is a manager and owner privilege. Checked
    // against the role the account ENDS UP with, because role and location can
    // change in one request — without this, editing a manager down to
    // receptionist leaves location "all" behind and scopeLocation then lets
    // them read both properties.
    if (user.location === "all" && !["manager", "owner", "receptionist"].includes(user.role)) {
      return res.status(400).json({ error: "Managers, owners, and receptionists can cover both properties." });
    }

    // Validate the assignment against whatever role and property the account
    // ends up with, not the ones it had when the request arrived.
    if (user.role === "facility") {
      if (user.location === "all") {
        return res.status(400).json({ error: "Facility staff work at one property, not both." });
      }
      if (assignedFacilities !== undefined || location) {
        const check = await resolveAssignedFacilities(
          assignedFacilities !== undefined ? assignedFacilities : user.assignedFacilities.map(String),
          user.location
        );
        if (check.error) return res.status(400).json({ error: check.error });
        user.assignedFacilities = check.ids;
      }
    } else {
      // Moving somebody off the facility role drops their tills with it.
      if (assignedFacilities && assignedFacilities.length) {
        return res.status(400).json({ error: "Only facility staff can be assigned to facilities." });
      }
      user.assignedFacilities = [];
    }

    if (active !== undefined) {
      if (String(user._id) === req.user.id) {
        return res.status(400).json({ error: "You cannot deactivate your own account." });
      }
      user.active = active;
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: "The new password needs at least 8 characters." });
      await user.setPassword(password);
      // An authorised password reset also restores login access.
      user.failedLoginAttempts = 0;
      user.loginLockedAt = undefined;
      user.loginUnlockedAt = new Date();
    }
    await user.save();

    logAction(req, { action: "Updated the account for " + user.name, entity: "User", entityId: user._id });
    res.json(user.toSafeJSON());
  } catch (e) { next(e); }
});

/**
 * POST /api/staff/:id/end-shift — closing a shift somebody left running.
 *
 * People forget. A bartender who shuts the till and goes home at two in the
 * morning without signing out reads as still on duty the next afternoon, which
 * makes the whole board useless. Ending it for them is recorded as the
 * manager's act, not theirs.
 */
router.post("/:id/end-shift", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can end an owner's shift." });
    }

    const shift = await endShift(user._id, req.user.id);
    if (!shift) return res.status(409).json({ error: user.name + " is not on shift." });

    const minutes = Math.round((shift.endedAt - shift.startedAt) / 60000);
    logAction(req, {
      action: "Ended " + user.name + "'s shift for them, after " +
        Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m",
      entity: "Shift", entityId: shift._id, location: shift.location,
    });
    res.json({ ok: true, minutes });
  } catch (e) { next(e); }
});

/**
 * GET /api/staff/shifts?from=&to= — shifts worked, for the activity log.
 *
 * Shown beside what people did rather than as its own screen: "who was here"
 * is the first question asked about any entry in that log.
 */
router.get("/shifts", async (req, res, next) => {
  try {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : today();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : shiftDays(to, -6);

    const rows = await Shift.find({ startedAt: { $gte: dayStart(from), $lt: dayEnd(to) } })
      .populate("user", "name role location")
      .populate("endedBy", "name")
      .sort({ startedAt: -1 }).limit(300).lean();

    const now = new Date();
    res.json(rows.map((s) => ({
      id: s._id,
      name: s.user?.name || "A former account",
      role: s.user?.role || null,
      location: s.location,
      startedAt: s.startedAt,
      endedAt: s.endedAt || null,
      open: !s.endedAt,
      minutes: Math.round(((s.endedAt || now) - new Date(s.startedAt)) / 60000),
      wasRostered: !!s.wasRostered,
      rosteredShift: s.rosteredShift || null,
      rosteredWindow: s.rosteredStart ? s.rosteredStart + "–" + s.rosteredEnd : null,
      // Only set when somebody else closed it, which is worth seeing.
      endedByOther: s.endedBy && String(s.endedBy._id) !== String(s.user?._id) ? s.endedBy.name : null,
    })));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  SHIFT TIMES — when the two shifts change over                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/staff/shift-times — both properties' changeover times.
 *
 * Two numbers per property, not four: when mornings start and when nights do,
 * each shift running until the other begins. Four free times could be set to
 * leave an hour at dawn covered by nobody, and that mistake surfaces weeks
 * later as an argument rather than at the moment it is made.
 */
router.get("/shift-times", async (req, res, next) => {
  try {
    const rows = await ShiftTimes.find().lean();
    const by = Object.fromEntries(rows.map((r) => [r.location, r]));
    res.json(["exclusive", "urban"].map((location) => {
      const t = by[location] || DEFAULT_TIMES;
      const w = windowsFor(t);
      return {
        location,
        morningStartsAt: t.morningStartsAt,
        nightStartsAt: t.nightStartsAt,
        // Worked out here so the screens and the roster can never disagree
        // about which hours a shift actually covers.
        windows: { morning: w.morning, night: w.night },
        isDefault: !by[location],
      };
    }));
  } catch (e) { next(e); }
});

/** PUT /api/staff/shift-times — a manager or owner moving the changeover. */
router.put("/shift-times", async (req, res, next) => {
  try {
    const { location, morningStartsAt, nightStartsAt } = req.body || {};
    if (!["exclusive", "urban"].includes(location)) {
      return res.status(400).json({ error: "Choose a property." });
    }
    if (req.user.location !== "all" && req.user.location !== location) {
      return res.status(403).json({ error: "You can only set the hours at your own property." });
    }
    const bad = badTimes({ morningStartsAt, nightStartsAt });
    if (bad) return res.status(400).json({ error: bad });

    const before = await ShiftTimes.findOne({ location }).lean();
    const doc = await ShiftTimes.findOneAndUpdate(
      { location },
      { morningStartsAt, nightStartsAt, updatedBy: req.user.id },
      { new: true, upsert: true }
    );

    logAction(req, {
      action: "Set the shift changeover at " + location + " to mornings from " +
        morningStartsAt + " and nights from " + nightStartsAt,
      entity: "ShiftTimes", entityId: doc._id, location,
      before: before ? { morningStartsAt: before.morningStartsAt, nightStartsAt: before.nightStartsAt } : null,
      after: { morningStartsAt, nightStartsAt },
    });

    const w = windowsFor(doc);
    res.json({
      location, morningStartsAt: doc.morningStartsAt, nightStartsAt: doc.nightStartsAt,
      windows: { morning: w.morning, night: w.night },
    });
  } catch (e) { next(e); }
});

module.exports = router;
