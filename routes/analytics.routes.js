const router = require("express").Router();
const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Payment = require("../models/Payment");
const Charge = require("../models/Charge");
const Facility = require("../models/Facility");
const { foliosFor } = require("../services/folio");
const { requireAuth, requireRole, scopeLocation } = require("../middleware/auth");
const { LOCATIONS } = require("../utils/constants");
const ReportExport = require("../models/ReportExport");
const User = require("../models/User");
const { windowFor, nightsIn, combine, periodsDue, MONTHS } = require("../services/report");

// Revenue and analytics are manager and owner only. Receptionists never see them.
router.use(requireAuth, requireRole("manager", "owner"));

// The hotel's day, not UTC's — see utils/day.js. Lagos is an hour ahead, so
// a day computed in UTC rolls over at 1am and "today's sales" spends that hour
// reporting yesterday's.
const { today, dayOf, dayStart, dayEnd, shiftDays: shift } = require("../utils/day");

/**
 * Facility takings over a period, broken down by facility.
 *
 * This is deliberately NOT folded into ADR, RevPAR or totalRoomRevenue. Those
 * are defined industry metrics — revenue per room night sold and per available
 * room — and mixing bar takings into them makes the numbers meaningless and
 * uncomparable to anything outside this hotel.
 */
async function facilityRevenue(location, from, to) {
  const when = { $gte: dayStart(from) };
  // `to` is exclusive and given as a date, so a month's report stops at the
  // first instant of the next month rather than at midnight on its last day —
  // which would silently drop everything sold on the last day of the month.
  if (to) when.$lt = dayStart(to);
  const rows = await Charge.aggregate([
    { $match: { location, voided: false, createdAt: when } },
    { $group: {
        _id: { facility: "$facility", settlement: "$settlement" },
        total: { $sum: "$amount" }, count: { $sum: 1 },
    } },
  ]);
  const facilities = await Facility.find({ location }).select("name type").sort({ type: 1, name: 1 }).lean();

  const byFacility = facilities.map((f) => {
    const mine = rows.filter((r) => String(r._id.facility) === String(f._id));
    const room = mine.find((r) => r._id.settlement === "room");
    const till = mine.find((r) => r._id.settlement === "paid");
    return {
      facilityId: f._id, name: f.name, type: f.type,
      chargedToRooms: room?.total || 0,
      paidAtTill: till?.total || 0,
      revenue: (room?.total || 0) + (till?.total || 0),
      charges: (room?.count || 0) + (till?.count || 0),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    total: byFacility.reduce((s, f) => s + f.revenue, 0),
    chargedToRooms: byFacility.reduce((s, f) => s + f.chargedToRooms, 0),
    paidAtTill: byFacility.reduce((s, f) => s + f.paidAtTill, 0),
    byFacility,
  };
}

router.get("/summary", scopeLocation, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const from = shift(today(), -days);
    let facRev;

    const rooms = await Room.countDocuments({ location: req.location });
    const bookings = await Booking.find({
      location: req.location, status: { $ne: "cancelled" }, checkIn: { $gte: from },
    }).lean();

    const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
    const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
    const available = rooms * days;

    const byType = {};
    bookings.forEach((b) => {
      byType[b.roomType] = byType[b.roomType] || { bookings: 0, nights: 0, revenue: 0 };
      byType[b.roomType].bookings++;
      byType[b.roomType].nights += b.nights;
      byType[b.roomType].revenue += b.totalCharge;
    });

    const bySource = {};
    bookings.forEach((b) => {
      bySource[b.source] = (bySource[b.source] || 0) + 1;
    });

    // Reported net of card fees. When a guest pays online the Paystack fee is
    // added on top of the room rate, and that money passes straight through to
    // Paystack — counting it as collected revenue would flatter every figure on
    // this page. `cardFeesCollected` is shown separately so the owner can still
    // see what the gateway is costing.
    const collected = await Payment.aggregate([
      { $match: { location: req.location, voided: false, createdAt: { $gte: new Date(from) } } },
      { $group: {
          _id: "$method",
          total: { $sum: { $ifNull: ["$netAmount", "$amount"] } },
          fees: { $sum: { $ifNull: ["$feeAmount", 0] } },
      } },
    ]);

    res.json({
      location: req.location, period: { from, to: today(), days },
      totalRooms: rooms, roomNightsSold: roomNights, roomNightsAvailable: available,
      occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
      averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
      revPAR: available ? Math.round(revenue / available) : 0,
      totalRoomRevenue: revenue,
      byRoomType: byType, bySource,
      // Every naira taken in the period, front desk and facility tills alike.
      collectedByMethod: Object.fromEntries(collected.map((c) => [c._id, c.total])),
      cardFeesCollected: collected.reduce((sum, c) => sum + (c.fees || 0), 0),
      // Its own figure, alongside the room metrics and never inside them.
      facilityRevenue: (facRev = await facilityRevenue(req.location, from)),
      // A plain statement of how much the business made — rooms plus
      // facilities. This is the ONLY figure that combines the two; ADR and
      // RevPAR above stay room-revenue only, unconditionally, because they are
      // defined industry metrics and folding bar takings into them would make
      // them meaningless against any benchmark or the hotel's own history.
      totalRevenue: revenue + facRev.total,
    });
  } catch (e) { next(e); }
});

/** Night-by-night occupancy, for the chart. */
router.get("/occupancy", scopeLocation, async (req, res, next) => {
  try {
    const back = Math.min(Number(req.query.back) || 7, 60);
    const forward = Math.min(Number(req.query.forward) || 7, 60);
    const rooms = await Room.countDocuments({ location: req.location, status: { $ne: "maintenance" } });
    const start = shift(today(), -back);
    const end = shift(today(), forward);

    const bookings = await Booking.find({
      location: req.location, status: { $ne: "cancelled" },
      checkIn: { $lt: end }, checkOut: { $gt: start },
    }).select("checkIn checkOut totalCharge nights rate").lean();

    const nights = [];
    for (let i = -back; i <= forward; i++) {
      const d = shift(today(), i);
      const staying = bookings.filter((b) => b.checkIn <= d && b.checkOut > d);
      nights.push({
        date: d,
        roomsSold: staying.length,
        occupancyPercent: rooms ? Math.round((staying.length / rooms) * 100) : 0,
        roomRevenue: staying.reduce((s, b) => s + b.rate, 0),
        isFuture: i > 0,
      });
    }
    res.json({ location: req.location, sellableRooms: rooms, nights });
  } catch (e) { next(e); }
});

/**
 * GET /api/analytics/today?location=
 *
 * "Sales" here means money that actually changed hands today — the sum of
 * Payment.netAmount (falling back to amount for older records with no fee
 * split) created today. This is deliberately a different figure from the
 * 30-day totalRoomRevenue in /summary, which is booking-based (what was
 * charged) rather than payment-based (what was actually paid) — the two will
 * not usually match on any single day, and that is expected, not a bug.
 *
 * Split by whether the payment carries a facility (paid at a till) or not
 * (a room payment, whichever method it came in by).
 */
router.get("/today", scopeLocation, async (req, res, next) => {
  try {
    const start = dayStart(today());
    const payments = await Payment.find({
      location: req.location, voided: false, createdAt: { $gte: start },
    }).populate("facility", "name").lean();

    let roomSalesToday = 0;
    let facilitySalesToday = 0;
    const facilitySalesByFacility = {};

    payments.forEach((p) => {
      const net = p.netAmount != null ? p.netAmount : p.amount;
      if (p.facility) {
        facilitySalesToday += net;
        const name = p.facility.name || "Unknown facility";
        facilitySalesByFacility[name] = (facilitySalesByFacility[name] || 0) + net;
      } else {
        roomSalesToday += net;
      }
    });

    /**
     * What is still owed, which is the one figure on this endpoint that is not
     * about today at all.
     *
     * A day's takings reset at midnight and should; a debt does not. Money owed
     * by a guest who has already left is the more urgent of the two and used to
     * vanish from the dashboard the moment they checked out — the only figure
     * there counted guests staying tonight. It is read here rather than in the
     * browser because the dashboard's booking list is capped, and a money
     * figure that quietly understates itself is worse than no figure.
     */
    const open = await Booking.find({
      location: req.location, status: { $in: ["confirmed", "in-house", "checked-out"] },
    }).select("status totalCharge").limit(2000).lean();
    const folios = await foliosFor(open);

    let owedInHouse = 0;
    let owedDeparted = 0;
    open.forEach((b) => {
      const balance = Math.max(0, folios[String(b._id)]?.balance || 0);
      if (!balance) return;
      if (b.status === "checked-out") owedDeparted += balance;
      else owedInHouse += balance;
    });

    res.json({
      date: today(),
      location: req.location,
      currency: "NGN",
      roomSalesToday,
      facilitySalesToday,
      facilitySalesByFacility,
      totalSalesToday: roomSalesToday + facilitySalesToday,
      paymentsCollectedToday: payments.length,
      outstanding: {
        inHouse: owedInHouse,
        departed: owedDeparted,
        total: owedInHouse + owedDeparted,
      },
    });
  } catch (e) { next(e); }
});

/** Both properties side by side. They stay separate — nothing is pooled. */
router.get("/compare", async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const from = shift(today(), -days);
    const out = {};
    for (const location of ["exclusive", "urban"]) {
      const rooms = await Room.countDocuments({ location });
      const bookings = await Booking.find({ location, status: { $ne: "cancelled" }, checkIn: { $gte: from } }).lean();
      const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
      const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
      const available = rooms * days;
      out[location] = {
        totalRooms: rooms, roomNightsSold: roomNights,
        occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
        averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
        revPAR: available ? Math.round(revenue / available) : 0,
        totalRoomRevenue: revenue, bookings: bookings.length,
        facilityRevenue: (await facilityRevenue(location, from)).total,
      };
    }
    res.json({ period: { from, to: today(), days }, properties: out });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 *  THE RECORD — a month or a year, across the business                *
 * ------------------------------------------------------------------ */

/**
 * GET /api/analytics/report?period=month&month=2026-09
 * GET /api/analytics/report?period=year&year=2026
 *
 * The figures an owner closes a month or a year on, for both properties at
 * once and for each on its own.
 *
 * Everything else in this file is a live view of the last N days — useful for
 * running the hotel, useless for saying what September was. This is the other
 * thing: a fixed window that will read the same in March as it does today, so
 * a printed report can be filed and later relied on.
 *
 * Two revenue figures are reported side by side and they are not the same
 * number. What was CHARGED comes from bookings and tells you what the month
 * sold; what was COLLECTED comes from payments and tells you what actually
 * arrived. A guest who books in September and pays in October puts them out of
 * step, which is correct and worth stating on the page rather than reconciling
 * away.
 */

async function reportFor(location, win) {
  const sellableRooms = await Room.countDocuments({ location });
  const days = nightsIn(win.from, win.to);

  // Counted by arrival, the same basis /summary uses, so the two pages can be
  // read together without one quietly meaning something else.
  const bookings = await Booking.find({
    location, status: { $ne: "cancelled" },
    checkIn: { $gte: win.from, $lt: win.to },
  }).lean();

  const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
  const charged = bookings.reduce((s, b) => s + b.totalCharge, 0);
  const discounted = bookings.reduce((s, b) => s + (b.discountTotal || 0), 0);
  const available = sellableRooms * days;

  const byRoomType = {};
  const bySource = {};
  bookings.forEach((b) => {
    const t = (byRoomType[b.roomType] = byRoomType[b.roomType] || { bookings: 0, nights: 0, revenue: 0 });
    t.bookings++; t.nights += b.nights; t.revenue += b.totalCharge;
    bySource[b.source] = (bySource[b.source] || 0) + 1;
  });

  const payments = await Payment.aggregate([
    { $match: {
        location, voided: false,
        createdAt: { $gte: dayStart(win.from), $lt: dayStart(win.to) },
    } },
    { $group: {
        _id: "$method",
        total: { $sum: { $ifNull: ["$netAmount", "$amount"] } },
        fees: { $sum: { $ifNull: ["$feeAmount", 0] } },
        count: { $sum: 1 },
    } },
  ]);

  const facilities = await facilityRevenue(location, win.from, win.to);

  return {
    id: location,
    name: LOCATIONS[location].name,
    rooms: {
      sellable: sellableRooms,
      bookings: bookings.length,
      nightsSold: roomNights,
      nightsAvailable: available,
      occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
      // Room revenue only, always. Folding the bar into ADR or RevPAR would
      // make them unreadable against any benchmark, including this hotel's own
      // last year.
      averageDailyRate: roomNights ? Math.round(charged / roomNights) : 0,
      revPAR: available ? Math.round(charged / available) : 0,
      revenue: charged,
      discountsGiven: discounted,
      byRoomType, bySource,
    },
    facilities,
    collected: {
      byMethod: Object.fromEntries(payments.map((p) => [p._id, p.total])),
      payments: payments.reduce((s, p) => s + p.count, 0),
      cardFees: payments.reduce((s, p) => s + (p.fees || 0), 0),
      total: payments.reduce((s, p) => s + p.total, 0),
    },
    revenue: { rooms: charged, facilities: facilities.total, total: charged + facilities.total },
  };
}

router.get("/report", async (req, res, next) => {
  try {
    const win = windowFor(req.query);
    if (!win) {
      return res.status(400).json({
        error: "Ask for a month as period=month&month=2026-09, a year as period=year&year=2026, " +
          "or any stretch of days as period=range&from=2026-09-01&to=2026-09-14.",
      });
    }
    if (win.from > today()) {
      return res.status(400).json({
        error: win.kind === "range" ? "That range has not started yet." : "That " + win.kind + " has not started yet.",
      });
    }

    // A manager sees their own property; only somebody over both gets the
    // collective figure, because for anyone else it is not their business.
    const mine = req.user.location === "all"
      ? ["exclusive", "urban"]
      : [req.user.location];

    const properties = [];
    for (const location of mine) properties.push(await reportFor(location, win));

    // A year is also worth reading month by month — that is where a season
    // shows up, and a single annual total hides it completely.
    let months = null;
    if (win.kind === "year") {
      months = [];
      for (let m = 1; m <= 12; m++) {
        const label = win.label + "-" + String(m).padStart(2, "0");
        const sub = windowFor({ period: "month", month: label });
        if (sub.from > today()) break;
        const rows = [];
        for (const location of mine) rows.push(await reportFor(location, sub));
        const all = combine(rows);
        months.push({
          month: label, label: MONTHS[m - 1],
          roomRevenue: all.revenue.rooms,
          facilityRevenue: all.revenue.facilities,
          total: all.revenue.total,
          nightsSold: all.rooms.nightsSold,
          occupancyPercent: all.rooms.occupancyPercent,
        });
      }
    }

    res.json({
      period: win,
      currency: "NGN",
      // True when this is the whole business rather than one branch — the
      // report says which on its face, so a printed page is never ambiguous
      // about what it covers.
      collective: mine.length > 1,
      generatedAt: new Date().toISOString(),
      properties,
      totals: combine(properties),
      months,
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 *  THE MONTH-END AND YEAR-END PROMPT                                  *
 * ------------------------------------------------------------------ */

/**
 * GET /api/analytics/report/due
 *
 * What this person still owes themselves a copy of. A month's figures are
 * most useful in the first week after it ends and least useful the longer
 * nobody looks; a prompt that appears on its own is the difference between a
 * record that gets filed every month and one that gets filed the first month.
 */
/**
 * The day this hotel's records begin.
 *
 * The month-end prompt is anchored to it so a freshly deployed system is never
 * told it owes itself last year's accounts. The first booking is the honest
 * answer; before there is one, the first account created is when somebody
 * started using this at all.
 */
async function recordsBeganOn() {
  const [booking, account] = await Promise.all([
    Booking.findOne().sort({ createdAt: 1 }).select("createdAt").lean(),
    User.findOne().sort({ createdAt: 1 }).select("createdAt").lean(),
  ]);
  const first = booking?.createdAt || account?.createdAt;
  return first ? dayOf(first) : today();
}

router.get("/report/due", async (req, res, next) => {
  try {
    const [taken, since] = await Promise.all([
      ReportExport.find({ user: req.user.id }).select("kind period").lean(),
      recordsBeganOn(),
    ]);
    res.json({ due: periodsDue(today(), taken, since) });
  } catch (e) { next(e); }
});

/**
 * POST /api/analytics/report/due — "I have taken this one away."
 *
 * Recorded when the report is actually printed or saved, not when it is merely
 * opened: looking at September on screen is not the same as having a copy of
 * it, and marking it done for a glance would quietly defeat the whole prompt.
 */
router.post("/report/due", async (req, res, next) => {
  try {
    const { kind, period } = req.body || {};
    if (!["month", "year"].includes(kind)) {
      return res.status(400).json({ error: "Say whether this is a month or a year." });
    }
    const ok = kind === "month" ? /^\d{4}-\d{2}$/.test(period) : /^\d{4}$/.test(period);
    if (!ok) return res.status(400).json({ error: "That is not a period this can record." });

    // Upsert: pressing print twice is not an error worth showing anyone.
    await ReportExport.updateOne(
      { user: req.user.id, kind, period },
      { $setOnInsert: { at: new Date() } },
      { upsert: true }
    );
    const [taken, since] = await Promise.all([
      ReportExport.find({ user: req.user.id }).select("kind period").lean(),
      recordsBeganOn(),
    ]);
    res.json({ due: periodsDue(today(), taken, since) });
  } catch (e) { next(e); }
});

module.exports = router;
