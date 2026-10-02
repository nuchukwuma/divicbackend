/**
 * Context builders.
 *
 * Every builder returns a small plain object. Nothing raw goes to Gemini —
 * no full booking documents, no guest ID numbers, no phone numbers, no staff
 * passwords. Aggregating here rather than in the prompt is what keeps token
 * use low and stops the model doing arithmetic it will get wrong.
 */

const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Facility = require("../models/Facility");
const Charge = require("../models/Charge");
const Guest = require("../models/Guest");
const BookingRequest = require("../models/BookingRequest");
const Payment = require("../models/Payment");
const User = require("../models/User");
const FaqEntry = require("../models/FaqEntry");
const SiteContent = require("../models/SiteContent");
const Notification = require("../models/Notification");
const Rate = require("../models/Rate");
const Discount = require("../models/Discount");
const MenuItem = require("../models/MenuItem");
const Tab = require("../models/Tab");
const FacilityVisit = require("../models/FacilityVisit");
const Membership = require("../models/Membership");
const ShiftModel = require("../models/Shift");
const ShiftTimes = require("../models/ShiftTimes");
const { onRosterAt, shiftsOn, windowsFor, DEFAULT_TIMES } = require("./roster");
const { priceStay, liveDiscounts, publicDiscount } = require("./pricing");
const { LOCATIONS } = require("../utils/constants");
const { findAvailableRooms, nightsBetween } = require("./availability");
const { foliosFor } = require("./folio");

// The hotel's day, not UTC's. The assistant answers "how did today go", and
// an hour of that answer was about yesterday.
const { today, dayStart, shiftDays: shift } = require("../utils/day");

async function ratesFor(location) {
  const doc = await Rate.findOne({ location }).lean();
  return doc ? Object.fromEntries(Object.entries(doc.prices)) : LOCATIONS[location].rates;
}

/**
 * The published rate is no longer what a guest pays.
 *
 * Offers came along after this file and it kept answering with the rate card,
 * which is not a gap but a wrong answer: asked "what does a deluxe cost", the
 * assistant would quote a figure nobody is charged while an offer is running.
 * Every rate answer now carries the offers with it.
 */
async function offersFor(location) {
  const rows = await liveDiscounts(location);
  return rows.map((d) => {
    const p = publicDiscount(d);
    return {
      name: p.name, takesOff: p.label, kind: p.kind, value: p.value,
      roomTypes: p.roomTypes.length ? p.roomTypes : "every room type",
      minimumNights: p.minNights,
      arrivalsFrom: p.startsOn, arrivalsUntil: p.endsOn,
    };
  });
}

/* ---------------------------------------------------------------- */

async function operationsSnapshot(location) {
  const t = today();
  const [rooms, arriving, inHouse, departing] = await Promise.all([
    Room.find({ location }).lean(),
    Booking.find({ location, status: "confirmed", checkIn: { $lte: t } }).populate("guest", "name").lean(),
    Booking.find({ location, status: "in-house" }).populate("guest", "name").lean(),
    Booking.find({ location, status: "in-house", checkOut: { $lte: t } }).populate("guest", "name").lean(),
  ]);

  // Room and facility charges both count — a bar tab is a balance.
  const folios = await foliosFor(departing);

  const owing = departing
    .map((b) => {
      const f = folios[String(b._id)];
      return {
        guest: b.guest?.name, room: b.roomNumber,
        roomCharges: f.roomCharges, facilityCharges: f.facilityCharges, balance: f.balance,
      };
    })
    .filter((x) => x.balance > 0);

  const byStatus = rooms.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

  return {
    property: LOCATIONS[location].name,
    date: t,
    totalRooms: rooms.length,
    roomsByStatus: byStatus,
    occupancyPercent: Math.round((inHouse.length / rooms.length) * 100),
    arrivingToday: arriving.map((b) => ({ guest: b.guest?.name, room: b.roomNumber, type: b.roomType, nights: b.nights })),
    departingToday: departing.map((b) => ({ guest: b.guest?.name, room: b.roomNumber })),
    departingWithBalance: owing,
    notReadyToSell: rooms.filter((r) => ["dirty", "cleaning", "maintenance"].includes(r.status))
      .map((r) => ({ room: r.number, floor: r.floor, status: r.status })),
  };
}

async function housekeepingSnapshot(location) {
  const rooms = await Room.find({ location }).sort({ floor: 1, number: 1 }).lean();
  const inHouse = await Booking.find({ location, status: "in-house" }).select("roomNumber").lean();
  const occupied = new Set(inHouse.map((b) => b.roomNumber));
  return {
    property: LOCATIONS[location].name,
    totalRooms: rooms.length,
    rooms: rooms.map((r) => ({
      room: r.number, floor: r.floor, type: r.type, status: r.status,
      occupied: occupied.has(r.number), note: r.statusNote || undefined,
    })),
    sellableNow: rooms.filter((r) => r.status === "available").length,
  };
}

async function outstandingBalances(location) {
  const open = await Booking.find({ location, status: { $in: ["confirmed", "in-house"] } })
    .populate("guest", "name").lean();
  const folios = await foliosFor(open);

  const rows = open.map((b) => {
    const f = folios[String(b._id)];
    return {
      guest: b.guest?.name, room: b.roomNumber, ref: b.ref,
      checkOut: b.checkOut,
      roomCharges: f.roomCharges,
      facilityCharges: f.facilityCharges,
      charges: f.totalCharges,
      paid: f.paid,
      balance: f.balance,
    };
  }).filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);

  return {
    property: LOCATIONS[location].name,
    today: today(),
    currency: "NGN",
    totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
    totalFacilityCharges: rows.reduce((s, r) => s + r.facilityCharges, 0),
    note: "Charges are the room plus anything charged to the room at a bar, restaurant or pool.",
    guests: rows,
  };
}

/** Facility takings over a period. Never mixed into ADR or RevPAR. */
async function facilityRevenue(location, from = shift(today(), -30)) {
  const rows = await Charge.aggregate([
    { $match: { location, voided: false, createdAt: { $gte: dayStart(from) } } },
    { $group: {
        _id: { facility: "$facility", settlement: "$settlement" },
        total: { $sum: "$amount" }, count: { $sum: 1 },
    } },
  ]);
  const facilities = await Facility.find({ location }).select("name type").lean();
  const nameBy = Object.fromEntries(facilities.map((f) => [String(f._id), f]));

  const byFacility = {};
  rows.forEach((r) => {
    const f = nameBy[String(r._id.facility)];
    const key = f ? f.name : "Unknown facility";
    byFacility[key] = byFacility[key] || { type: f?.type, chargedToRooms: 0, paidAtTill: 0, total: 0, charges: 0 };
    byFacility[key][r._id.settlement === "room" ? "chargedToRooms" : "paidAtTill"] += r.total;
    byFacility[key].total += r.total;
    byFacility[key].charges += r.count;
  });

  return {
    total: Object.values(byFacility).reduce((s, v) => s + v.total, 0),
    byFacility,
  };
}

async function revenueSummary(location) {
  const from = shift(today(), -30);
  const rooms = await Room.find({ location }).lean();
  const bookings = await Booking.find({
    location, status: { $ne: "cancelled" }, checkIn: { $gte: from },
  }).lean();

  const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
  const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
  const available = rooms.length * 30;

  const byType = {};
  bookings.forEach((b) => {
    byType[b.roomType] = byType[b.roomType] || { bookings: 0, nights: 0, revenue: 0 };
    byType[b.roomType].bookings += 1;
    byType[b.roomType].nights += b.nights;
    byType[b.roomType].revenue += b.totalCharge;
  });
  rooms.forEach((r) => {
    byType[r.type] = byType[r.type] || { bookings: 0, nights: 0, revenue: 0 };
    byType[r.type].roomsOfThisType = (byType[r.type].roomsOfThisType || 0) + 1;
  });

  const facRevenue = await facilityRevenue(location, from);
  return {
    property: LOCATIONS[location].name,
    period: { from, to: today(), days: 30 },
    currency: "NGN",
    totalRooms: rooms.length,
    roomNightsSold: roomNights,
    roomNightsAvailable: available,
    occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
    averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
    revPAR: available ? Math.round(revenue / available) : 0,
    totalRoomRevenue: revenue,
    byRoomType: byType,
    // Kept separate from the room metrics on purpose. ADR and RevPAR mean
    // revenue per room night sold and per available room; folding bar takings
    // into them makes the numbers meaningless.
    facilityRevenue: facRevenue,
    // The one figure that does combine them — a plain statement of how much
    // the business made, so the assistant's revenue answers agree with what
    // the Analytics page shows. ADR and RevPAR above are unaffected.
    totalRevenue: revenue + facRevenue.total,
    currentRates: await ratesFor(location),
  };
}

async function propertyComparison() {
  const out = {};
  for (const id of ["exclusive", "urban"]) out[id] = await revenueSummary(id);
  return { note: "The two properties operate separately and are not pooled.", properties: out };
}

async function pricingSignals(location) {
  const summary = await revenueSummary(location);
  const rates = await ratesFor(location);
  const signals = {};
  Object.entries(summary.byRoomType).forEach(([type, v]) => {
    const roomsOfType = v.roomsOfThisType || 0;
    const possible = roomsOfType * 30;
    signals[type] = {
      currentRate: rates[type],
      roomsOfThisType: roomsOfType,
      nightsSold: v.nights,
      nightsPossible: possible,
      occupancyPercent: possible ? Math.round((v.nights / possible) * 100) : 0,
      revenue: v.revenue,
    };
  });
  return {
    property: LOCATIONS[location].name,
    period: summary.period,
    currency: "NGN",
    byRoomType: signals,
    caveat: "Based only on this property's own booking history. No competitor or market data is available to the system.",
  };
}

async function bookingSources(location) {
  const from = shift(today(), -90);
  const rows = await Booking.aggregate([
    { $match: { location, status: { $ne: "cancelled" }, checkIn: { $gte: from } } },
    { $group: { _id: "$source", bookings: { $sum: 1 }, nights: { $sum: "$nights" }, revenue: { $sum: "$totalCharge" } } },
    { $sort: { bookings: -1 } },
  ]);
  const total = rows.reduce((s, r) => s + r.bookings, 0);
  return {
    property: LOCATIONS[location].name,
    period: { from, to: today(), days: 90 },
    currency: "NGN",
    totalBookings: total,
    sources: rows.map((r) => ({
      source: r._id, bookings: r.bookings, nights: r.nights, revenue: r.revenue,
      sharePercent: total ? Math.round((r.bookings / total) * 100) : 0,
    })),
  };
}

async function repeatGuests() {
  const rows = await Booking.aggregate([
    { $match: { status: { $ne: "cancelled" } } },
    { $group: {
        _id: "$guest",
        stays: { $sum: 1 }, nights: { $sum: "$nights" }, spend: { $sum: "$totalCharge" },
        properties: { $addToSet: "$location" }, lastStay: { $max: "$checkIn" },
    } },
    { $match: { stays: { $gt: 1 } } },
    { $sort: { stays: -1, spend: -1 } },
    { $limit: 20 },
  ]);
  const guests = await Guest.find({ _id: { $in: rows.map((r) => r._id) } }).select("name").lean();
  const nameBy = Object.fromEntries(guests.map((g) => [String(g._id), g.name]));
  return {
    currency: "NGN",
    guests: rows.map((r) => ({
      name: nameBy[String(r._id)] || "Unknown",
      stays: r.stays, nights: r.nights, spend: r.spend,
      stayedAtBothProperties: r.properties.length > 1,
      lastStay: r.lastStay,
    })),
  };
}

async function pendingRequests(location) {
  const reqs = await BookingRequest.find({ location, status: "pending" }).sort({ createdAt: 1 }).lean();
  const enriched = [];
  for (const r of reqs) {
    const free = await findAvailableRooms(location, r.checkIn, r.checkOut, { roomType: r.roomType });
    enriched.push({
      reference: r.reference, guest: r.guestName, roomType: r.roomType,
      checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights,
      quotedTotal: r.quotedTotal,
      roomsFreeOfThatType: free.length,
      canAcceptNow: free.length > 0,
      requestedAt: r.createdAt,
    });
  }
  return { property: LOCATIONS[location].name, today: today(), currency: "NGN", pending: enriched };
}

async function forwardOccupancy(location) {
  const t = today();
  const roomCount = await Room.countDocuments({ location, status: { $ne: "maintenance" } });
  const bookings = await Booking.find({
    location, status: { $in: ["confirmed", "in-house"] }, checkOut: { $gt: t },
  }).select("checkIn checkOut").lean();

  const nights = Array.from({ length: 14 }, (_, i) => {
    const d = shift(t, i);
    const sold = bookings.filter((b) => b.checkIn <= d && b.checkOut > d).length;
    return { date: d, roomsSold: sold, occupancyPercent: roomCount ? Math.round((sold / roomCount) * 100) : 0 };
  });

  return { property: LOCATIONS[location].name, sellableRooms: roomCount, nights };
}



async function todaySales(location) {
  const start = dayStart(today());
  const payments = await Payment.find({ location, voided: false, createdAt: { $gte: start } })
    .populate("facility", "name").lean();
  const byMethod = {};
  let roomSales = 0, facilitySales = 0;
  for (const p of payments) {
    const net = p.netAmount != null ? p.netAmount : p.amount;
    byMethod[p.method] = (byMethod[p.method] || 0) + net;
    if (p.facility) facilitySales += net; else roomSales += net;
  }
  return {
    property: LOCATIONS[location].name, date: today(), currency: "NGN",
    roomSalesToday: roomSales, facilitySalesToday: facilitySales,
    totalSalesToday: roomSales + facilitySales,
    paymentsCollectedToday: payments.length,
    byMethod,
  };
}

async function facilityRevenueToday(location) {
  const start = dayStart(today());
  const rows = await Charge.aggregate([
    { $match: { location, voided: false, createdAt: { $gte: start } } },
    { $group: { _id: { facility: "$facility", settlement: "$settlement" }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const facilities = await Facility.find({ location }).select("name type").sort({ name: 1 }).lean();
  const byFacility = facilities.map(f => {
    const mine = rows.filter(r => String(r._id.facility) === String(f._id));
    const room = mine.find(r => r._id.settlement === "room");
    const paid = mine.find(r => r._id.settlement === "paid");
    return { name: f.name, type: f.type, chargedToRooms: room?.total || 0, paidAtTill: paid?.total || 0,
      revenue: (room?.total || 0) + (paid?.total || 0), charges: (room?.count || 0) + (paid?.count || 0) };
  });
  return { property: LOCATIONS[location].name, date: today(), byFacility,
    total: byFacility.reduce((s, f) => s + f.revenue, 0) };
}

async function recentPayments(location) {
  const rows = await Payment.find({ location }).sort({ createdAt: -1 }).limit(30)
    .populate("facility", "name").lean();
  return { property: LOCATIONS[location].name, payments: rows.map(p => ({
    reference: p.paystackReference || String(p._id), amount: p.amount,
    netAmount: p.netAmount != null ? p.netAmount : p.amount, method: p.method,
    verified: !!p.verified, voided: !!p.voided, facility: p.facility?.name || null,
    bookingId: p.booking ? String(p.booking) : null, createdAt: p.createdAt,
  })) };
}

async function paymentFees(location) {
  const from = shift(today(), -30);
  const rows = await Payment.aggregate([
    { $match: { location, voided: false, createdAt: { $gte: dayStart(from) } } },
    { $group: { _id: "$method", fees: { $sum: { $ifNull: ["$feeAmount", 0] } }, gross: { $sum: "$amount" }, net: { $sum: { $ifNull: ["$netAmount", "$amount"] } }, count: { $sum: 1 } } },
  ]);
  return { property: LOCATIONS[location].name, period: { from, to: today(), days: 30 }, byMethod: rows,
    totalFees: rows.reduce((s, r) => s + (r.fees || 0), 0),
    gross: rows.reduce((s, r) => s + (r.gross || 0), 0),
    net: rows.reduce((s, r) => s + (r.net || 0), 0) };
}

async function arrivalsToday(location) {
  const t = today();
  const rows = await Booking.find({ location, status: "confirmed", checkIn: t })
    .populate("guest", "name").sort({ roomNumber: 1, createdAt: 1 }).lean();
  return { property: LOCATIONS[location].name, date: t, arrivals: rows.map(b => ({
    ref: b.ref, guest: b.guest?.name, room: b.roomNumber, type: b.roomType,
    checkOut: b.checkOut, nights: b.nights, source: b.source, adults: b.adults, children: b.children,
  })) };
}

async function departuresToday(location) {
  const t = today();
  const rows = await Booking.find({ location, status: "in-house", checkOut: t })
    .populate("guest", "name").sort({ roomNumber: 1 }).lean();
  const folios = await foliosFor(rows);
  return { property: LOCATIONS[location].name, date: t, departures: rows.map(b => {
    const f = folios[String(b._id)];
    return { ref: b.ref, guest: b.guest?.name, room: b.roomNumber, type: b.roomType,
      checkIn: b.checkIn, balance: f?.balance || 0, paid: f?.paid || 0 };
  }) };
}

async function inHouseGuests(location) {
  const rows = await Booking.find({ location, status: "in-house" }).populate("guest", "name").sort({ roomNumber: 1 }).lean();
  return { property: LOCATIONS[location].name, guests: rows.map(b => ({
    ref: b.ref, guest: b.guest?.name, room: b.roomNumber, type: b.roomType,
    checkIn: b.checkIn, checkOut: b.checkOut, nights: b.nights,
  })) };
}

async function todayOccupancy(location) {
  const rooms = await Room.find({ location, status: { $ne: "maintenance" } }).lean();
  const occupied = await Booking.countDocuments({ location, status: "in-house" });
  return { property: LOCATIONS[location].name, totalSellableRooms: rooms.length, occupiedRooms: occupied,
    availableSellableRooms: Math.max(rooms.length - occupied, 0), occupancyPercent: rooms.length ? Math.round(occupied / rooms.length * 100) : 0 };
}

async function bookingStatusesToday(location) {
  const t = today();
  const rows = await Booking.find({ location, $or: [
    { status: "no-show" },
    { status: "cancelled", cancelledAt: { $gte: dayStart(t) } },
  ] }).populate("guest", "name").sort({ updatedAt: -1 }).limit(50).lean();
  return { property: LOCATIONS[location].name, date: t, rows: rows.map(b => ({
    ref: b.ref, guest: b.guest?.name, room: b.roomNumber, type: b.roomType,
    checkIn: b.checkIn, checkOut: b.checkOut, status: b.status, cancelReason: b.cancelReason || null,
  })) };
}

async function guestStats(location) {
  const guests = await Guest.find({}).select("name blacklisted").lean();
  const inHouseBookings = await Booking.find({ location, status: "in-house" }).select("guest").lean();
  const byGuest = new Set(inHouseBookings.map(b => String(b.guest)));
  return { property: LOCATIONS[location].name, totalGuestRecords: guests.length,
    currentInHouseGuests: byGuest.size, blacklisted: guests.filter(g => g.blacklisted).map(g => g.name) };
}

async function roomInventory(location) {
  const rooms = await Room.find({ location }).sort({ type: 1, number: 1 }).lean();
  const byType = {};
  const byStatus = {};
  rooms.forEach(r => { (byType[r.type] ||= { total: 0, byStatus: {} }).total++; byType[r.type].byStatus[r.status] = (byType[r.type].byStatus[r.status] || 0) + 1; byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  return { property: LOCATIONS[location].name, totalRooms: rooms.length, byType, byStatus };
}



async function upcomingBookings(location) {
  const from = today(), to = shift(today(), 8);
  const rows = await Booking.find({ location, status: { $in: ["confirmed", "in-house"] }, checkIn: { $gte: from, $lt: to } })
    .populate("guest", "name").sort({ checkIn: 1, roomNumber: 1 }).lean();
  return { property: LOCATIONS[location].name, from, to, bookings: rows.map(b => ({
    ref: b.ref, guest: b.guest?.name, room: b.roomNumber, type: b.roomType,
    checkIn: b.checkIn, checkOut: b.checkOut, status: b.status, source: b.source, totalCharge: b.totalCharge,
  })) };
}

async function roomStatusDetail(location, status) {
  const rooms = await Room.find({ location, status }).sort({ floor: 1, number: 1 }).lean();
  return { property: LOCATIONS[location].name, status, count: rooms.length,
    rooms: rooms.map(r => ({ number: r.number, type: r.type, floor: r.floor, note: r.statusNote || null })) };
}

async function availableRoomsNow(location) {
  const rooms = await Room.find({ location, status: "available" }).sort({ floor: 1, number: 1 }).lean();
  return { property: LOCATIONS[location].name, count: rooms.length, rooms: rooms.map(r => ({ number: r.number, type: r.type, floor: r.floor })) };
}

async function currentRates(location) {
  const [rates, offers] = await Promise.all([ratesFor(location), offersFor(location)]);
  return {
    property: LOCATIONS[location].name,
    rates,
    offersRunning: offers,
    note: offers.length
      ? "These are the published rates. The offers listed come off them automatically when a guest books, online and at the desk, so a guest whose stay qualifies pays less than the rate shown."
      : "No offers are running, so these are what a guest pays.",
  };
}

/** What a stay actually costs, offers included — the question people ask. */
async function quoteStay(location, roomType, checkIn, nights = 1) {
  const rates = await ratesFor(location);
  const rate = rates[roomType];
  if (!Number.isFinite(rate)) return { error: roomType + " is not a room type at " + LOCATIONS[location].name };
  const priced = priceStay({
    rate, nights, roomType, checkIn: checkIn || today(),
    discounts: await liveDiscounts(location),
  });
  return {
    property: LOCATIONS[location].name, roomType, nights,
    nightlyRate: rate, beforeOffers: priced.gross,
    offersApplied: priced.discounts, saving: priced.discountTotal, guestPays: priced.total,
  };
}

async function facilityStatus(location) {
  const facilities = await Facility.find({ location }).sort({ type: 1, name: 1 }).lean();
  return { property: LOCATIONS[location].name, facilities: facilities.map(f => ({ name: f.name, type: f.type,
    status: f.status, statusNote: f.statusNote || null, openingHours: f.openingHours || null, sellsItems: !!f.sellsItems })) };
}

async function requestSummary(location) {
  const rows = await BookingRequest.find({ location }).lean();
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  return { property: LOCATIONS[location].name, total: rows.length, counts };
}

async function publishedContent(location) {
  const rows = await SiteContent.find(SiteContent.liveFilter(location)).sort({ priority: -1, updatedAt: -1 }).lean();
  return { property: LOCATIONS[location].name, content: rows.map(r => ({ type: r.type, title: r.title, body: r.body || "", location: r.location, startsAt: r.startsAt, endsAt: r.endsAt })) };
}

async function faqKnowledge(location) {
  const rows = await FaqEntry.find({ active: true, $or: [{ location: "both" }, { location }] }).sort({ category: 1, order: 1 }).lean();
  const categories = {};
  rows.forEach(r => (categories[r.category || "General"] ||= []).push(r.question));
  return { property: LOCATIONS[location].name, categories, total: rows.length };
}

async function staffOverview() {
  const [users, facilities] = await Promise.all([
    User.find({}).sort({ location: 1, role: 1, name: 1 }).lean(),
    Facility.find({}).select("name location").lean(),
  ]);
  const fBy = Object.fromEntries(facilities.map(f => [String(f._id), f]));
  return { staff: users.map(u => ({
    name: u.name, username: u.username, role: u.role, location: u.location, active: !!u.active,
    assignedFacilities: (u.assignedFacilities || []).map(id => fBy[String(id)]?.name).filter(Boolean),
  })) };
}

async function recentAudit() {
  const AuditLog = require("../models/AuditLog");
  const rows = await AuditLog.find({}).sort({ at: -1 }).limit(30).lean();
  return { entries: rows.map(a => ({ at: a.at, userName: a.userName, role: a.role, location: a.location, action: a.action, entity: a.entity })) };
}



async function notifications(location, userId) {
  const rows = await Notification.find({ location }).sort({ createdAt: -1 }).limit(25).lean();
  return { property: LOCATIONS[location].name,
    unread: userId ? rows.filter(n => !(n.readBy || []).some(id => String(id) === String(userId))).length : rows.length,
    notifications: rows.map(n => ({ title: n.title, body: n.body || "", urgent: !!n.urgent, type: n.type, createdAt: n.createdAt })) };
}


/* ---------------------------------------------------------------- *
 *  What the facilities are actually doing
 *
 *  The assistant could see facility revenue as a lump of Charges from the day
 *  the tills existed, and nothing else: not what a bar sells, not what is open
 *  on its floor right now, not who is in the pool, not who holds a gym
 *  membership. "How was the bar tonight" could be answered with a number and
 *  not one word about what was actually sold.
 * ---------------------------------------------------------------- */

/** What each bar and restaurant sells, and for how much. */
async function barMenus(location) {
  const facilities = await Facility.find({ location, type: { $in: ["bar", "restaurant"] } })
    .select("name type status").lean();
  const items = await MenuItem.find({ location }).select("facility name category price active").lean();
  return {
    property: LOCATIONS[location].name,
    facilities: facilities.map((f) => ({
      name: f.name, type: f.type, status: f.status,
      menu: items.filter((i) => String(i.facility) === String(f._id))
        .map((i) => ({ item: i.name, category: i.category, price: i.price, available: !!i.active })),
    })),
  };
}

/** Tables open now, and what settled today. */
async function barFloor(location) {
  const facilities = await Facility.find({ location, type: { $in: ["bar", "restaurant"] } })
    .select("name").lean();
  const ids = facilities.map((f) => f._id);
  const nameBy = Object.fromEntries(facilities.map((f) => [String(f._id), f.name]));

  const [open, settled] = await Promise.all([
    Tab.find({ facility: { $in: ids }, status: "open" }).populate("openedBy", "name").lean(),
    Tab.find({
      facility: { $in: ids }, status: "settled", voided: { $ne: true },
      settledAt: { $gte: dayStart(today()) },
    }).populate("settledBy", "name").lean(),
  ]);

  const sold = {};
  settled.forEach((t) => (t.lines || []).forEach((l) => {
    sold[l.name] = (sold[l.name] || 0) + l.qty;
  }));

  return {
    property: LOCATIONS[location].name,
    openTables: open.map((t) => ({
      facility: nameBy[String(t.facility)], table: t.tableName,
      room: t.roomNumber || null, guest: t.guestSurname || t.guestName || null,
      items: (t.lines || []).length,
      worth: (t.lines || []).reduce((a, l) => a + l.unitPrice * l.qty, 0),
      openedBy: t.openedBy?.name || null, openedAt: t.createdAt,
    })),
    settledToday: settled.length,
    takenToday: settled.reduce((a, t) => a + (t.total || 0), 0),
    sellingMost: Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([item, qty]) => ({ item, qty })),
  };
}

/** Who is in the pool or the gym today, and the gym's members. */
async function facilityVisitors(location) {
  const facilities = await Facility.find({ location, type: { $in: ["pool", "gym"] } })
    .select("name type entryFee").lean();
  const ids = facilities.map((f) => f._id);
  const nameBy = Object.fromEntries(facilities.map((f) => [String(f._id), f]));

  const [visits, members] = await Promise.all([
    FacilityVisit.find({ facility: { $in: ids }, createdAt: { $gte: dayStart(today()) } }).lean(),
    Membership.find({ facility: { $in: ids } }).sort({ endsOn: -1 }).limit(60).lean(),
  ]);

  const t = today();
  return {
    property: LOCATIONS[location].name,
    facilities: facilities.map((f) => ({ name: f.name, type: f.type, entryFee: f.entryFee || 0 })),
    visitsToday: visits.map((v) => ({
      facility: nameBy[String(v.facility)]?.name, guest: v.guestName, people: v.people,
      paid: v.settlement === "room" ? "charged to room" : "paid at the desk",
      amount: v.amount, stillInside: !v.leftAt,
    })),
    takenFromVisitsToday: visits.reduce((a, v) => a + (v.amount || 0), 0),
    gymMembers: members.map((m) => ({
      facility: nameBy[String(m.facility)]?.name, member: m.memberName, plan: m.planName,
      runs: m.startsOn + " to " + m.endsOn, paid: m.price,
      current: m.startsOn <= t && m.endsOn >= t,
    })),
  };
}

/**
 * Who is on shift, who should be, and who is signed on at four in the morning
 * because they forgot to end it.
 */
async function shiftBoard(location) {
  const users = await User.find(
    location === "all" ? {} : { location: { $in: [location, "all"] } }
  ).select("name role location shifts active").lean();

  const [open, timesDoc] = await Promise.all([
    ShiftModel.find({ user: { $in: users.map((u) => u._id) }, endedAt: { $exists: false } }).lean(),
    ShiftTimes.findOne({ location: location === "all" ? "exclusive" : location }).lean(),
  ]);
  const times = timesDoc || DEFAULT_TIMES;
  const openBy = Object.fromEntries(open.map((s) => [String(s.user), s]));
  const w = windowsFor(times);
  const now = new Date();

  const people = users.filter((u) => u.active).map((u) => {
    const shift = openBy[String(u._id)];
    const roster = onRosterAt(u.shifts, times, now);
    return {
      name: u.name, role: u.role,
      onShift: Boolean(shift),
      onShiftFor: shift ? Math.round((now - new Date(shift.startedAt)) / 60000) + " minutes" : null,
      dueOn: roster.on,
      dueShift: roster.shift || null,
      // Sixteen hours in a row is the answer to "who has been here too long",
      // and the assistant cannot work it out from dueShift alone.
      dueToday: shiftsOn(u.shifts, now),
    };
  });

  return {
    property: LOCATIONS[location] ? LOCATIONS[location].name : "Both properties",
    shiftTimes: { morning: w.morning.startsAt + "–" + w.morning.endsAt, night: w.night.startsAt + "–" + w.night.endsAt },
    onShiftNow: people.filter((p) => p.onShift).map((p) => p.name),
    dueOnNow: people.filter((p) => p.dueOn).map((p) => p.name),
    // The two questions worth asking of this board.
    dueButNotSignedIn: people.filter((p) => p.dueOn && !p.onShift).map((p) => p.name),
    signedInButNotDue: people.filter((p) => p.onShift && !p.dueOn).map((p) => p.name),
    onADoubleToday: people.filter((p) => p.dueToday.length === 2).map((p) => p.name),
    people,
  };
}

const BUILDERS = {
  operationsSnapshot, housekeepingSnapshot, outstandingBalances, revenueSummary,
  propertyComparison, pricingSignals, bookingSources, repeatGuests,
  pendingRequests, forwardOccupancy, todaySales, facilityRevenueToday, recentPayments, paymentFees,
  arrivalsToday, departuresToday, inHouseGuests, todayOccupancy, bookingStatusesToday, guestStats,
  roomInventory, availableRoomsNow, currentRates, facilityStatus, requestSummary, publishedContent,
  faqKnowledge, staffOverview, recentAudit, notifications, upcomingBookings, roomStatusDetail, facilityRevenue,
  // Everything the tills, the offers and the rosters brought with them.
  barMenus, barFloor, facilityVisitors, shiftBoard,
};

async function buildContext(name, location, userId) {
  if (!name || name === "none") return null;
  const fn = BUILDERS[name];
  if (!fn) throw new Error("Unknown context builder: " + name);
  return name === "notifications" ? fn(location, userId) : fn(location);
}

module.exports = { buildContext, BUILDERS };
