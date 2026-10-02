process.env.JWT_SECRET = "t";
process.env.MONGO_URI = "mongodb://stub";
const mongoose = require("mongoose");
mongoose.connect = async () => ({});

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
};

// ---------- requireOperational, tested directly against the middleware ----------
const { requireOperational } = require("../middleware/auth");

function fakeReq(role, body) { return { user: { role }, body: body || {} }; }
function fakeRes() {
  const r = {};
  r.status = (c) => { r._status = c; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

console.log("\n=== requireOperational ===");

// The operational role itself always passes, no override needed.
{
  const mw = requireOperational("receptionist");
  let nextCalled = false;
  mw(fakeReq("receptionist"), fakeRes(), () => { nextCalled = true; });
  check("receptionist passes with no override", nextCalled);
}

// Owner without override is refused, told exactly why.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("owner"), res, () => { nextCalled = true; });
  check("owner without override is refused", !nextCalled && res._status === 403);
  check("refusal names the operational role", res._body.error.includes("receptionist"));
  check("refusal flags requiresOverride", res._body.requiresOverride === true);
}

// Owner WITH override but no reason -> 400, not 403.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("owner", { override: true }), res, () => { nextCalled = true; });
  check("override without a reason is a 400", !nextCalled && res._status === 400);
}

// Owner WITH override AND reason -> passes, and is flagged for the log.
{
  const mw = requireOperational("receptionist");
  const req = fakeReq("owner", { override: true, overrideReason: "desk was empty" });
  let nextCalled = false;
  mw(req, fakeRes(), () => { nextCalled = true; });
  check("owner with override+reason passes", nextCalled);
  check("req.isOverride is set for the activity log", req.isOverride === true);
}

// Manager behaves identically to owner.
{
  const mw = requireOperational("cleaner");
  const req = fakeReq("manager", { override: true, overrideReason: "urgent" });
  let nextCalled = false;
  mw(req, fakeRes(), () => { nextCalled = true; });
  check("manager with override+reason also passes", nextCalled);
}

// A role that is neither operational nor owner/manager is refused outright,
// with no override path offered at all.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("cleaner", { override: true, overrideReason: "x" }), res, () => { nextCalled = true; });
  check("an unrelated role has no override path", !nextCalled && res._status === 403 && !res._body.requiresOverride);
}

// Multiple operational roles: facility passes for payments alongside receptionist.
{
  const mw = requireOperational("receptionist", "facility");
  let a = false, b = false;
  mw(fakeReq("receptionist"), fakeRes(), () => { a = true; });
  mw(fakeReq("facility"), fakeRes(), () => { b = true; });
  check("both listed operational roles pass", a && b);
}

// ---------- today's sales split logic ----------
console.log("\n=== today's-sales payment split ===");
function splitToday(payments) {
  let roomSalesToday = 0, facilitySalesToday = 0;
  const byFacility = {};
  payments.forEach((p) => {
    const net = p.netAmount != null ? p.netAmount : p.amount;
    if (p.facility) {
      facilitySalesToday += net;
      const name = p.facility.name || "Unknown facility";
      byFacility[name] = (byFacility[name] || 0) + net;
    } else {
      roomSalesToday += net;
    }
  });
  return { roomSalesToday, facilitySalesToday, byFacility, total: roomSalesToday + facilitySalesToday };
}

{
  const r = splitToday([
    { amount: 50000, netAmount: 48000 },                                 // room payment, has a fee
    { amount: 5000, facility: { name: "Bar" } },                          // till payment, no fee split recorded
    { amount: 3000, netAmount: 3000, facility: { name: "Restaurant" } },
  ]);
  check("room payments excluded from facility total", r.roomSalesToday === 48000);
  check("facility payments summed correctly", r.facilitySalesToday === 8000);
  check("uses netAmount when present, falls back to amount", r.byFacility.Bar === 5000 && r.byFacility.Restaurant === 3000);
  check("total is the sum of both", r.total === 56000);
}

// ---------- SiteContent media validation (same logic as badHref/badMediaUrl) ----------
console.log("\n=== mediaUrl validation ===");
function badHref(href) {
  if (!href) return null;
  const v = String(href).trim();
  if (v.startsWith("/") && !v.startsWith("//")) return null;
  if (/^https:\/\/[^\s]+$/i.test(v)) return null;
  return "bad";
}
check("relative path is accepted", badHref("/book") === null);
check("https link is accepted", badHref("https://youtube.com/watch?v=abc") === null);
check("protocol-relative // is rejected", badHref("//evil.com") !== null);
check("javascript: is rejected", badHref("javascript:alert(1)") !== null);
check("plain http:// is rejected", badHref("http://insecure.com") !== null);

// ---------- Cloudinary upload signatures ----------
console.log("\n=== Cloudinary upload signature ===");
{
  const { signUpload, isConfigured } = require("../services/cloudinary");

  // Unconfigured: the manager is told what is missing, not handed a broken
  // upload that fails at Cloudinary.
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  check("reports itself unconfigured when keys are absent", isConfigured() === false);
  const missing = signUpload("image");
  check("unconfigured upload is refused as 503", missing.ok === false && missing.status === 503);
  check("...and names the variables to set", /CLOUDINARY_API_SECRET/.test(missing.error));

  process.env.CLOUDINARY_CLOUD_NAME = "divic";
  process.env.CLOUDINARY_API_KEY = "111";
  process.env.CLOUDINARY_API_SECRET = "shh";
  process.env.CLOUDINARY_FOLDER = "divic/site-content";

  const bad = signUpload("document");
  check("a media type that is not image or video is refused", bad.ok === false && bad.status === 400);

  const img = signUpload("image");
  check("image uploads go to the image endpoint", img.upload.uploadUrl === "https://api.cloudinary.com/v1_1/divic/image/upload");
  check("video uploads go to the video endpoint", signUpload("video").upload.uploadUrl.endsWith("/video/upload"));
  check("video is allowed to be larger than an image", signUpload("video").upload.maxBytes > img.upload.maxBytes);
  check("the secret is never handed to the browser", JSON.stringify(img.upload).includes("shh") === false);

  // The signature is Cloudinary's own recipe: signed params sorted, joined,
  // secret appended, SHA-1. Recomputed here independently — if the service
  // ever signs a different set of params than the browser sends, Cloudinary
  // rejects every upload, and this is what catches that before a manager does.
  const expected = require("crypto").createHash("sha1")
    .update("folder=divic/site-content&timestamp=" + img.upload.timestamp + "shh")
    .digest("hex");
  check("signature matches Cloudinary's documented recipe", img.upload.signature === expected);
}


// ---------- discount arithmetic ----------
console.log("\n=== discounts ===");
{
  const { priceStay, applies } = require("../services/pricing");
  const on = (d) => ({ active: true, minNights: 1, roomTypes: [], ...d });
  const stay = { rate: 50000, nights: 4, roomType: "deluxe", checkIn: "2026-12-10" };

  check("no offers leaves the price alone",
    priceStay({ ...stay, discounts: [] }).total === 200000);

  const pct = priceStay({ ...stay, discounts: [on({ name: "December", kind: "percent", value: 15 })] });
  check("a percentage comes off the whole stay", pct.total === 170000 && pct.discountTotal === 30000);
  check("the gross is kept so a bill can explain itself", pct.gross === 200000);

  const fixed = priceStay({ ...stay, discounts: [on({ name: "Long stay", kind: "fixed", value: 20000 })] });
  check("a flat amount comes off the stay, not each night", fixed.total === 180000);

  // Both at once — the thing the manager was promised when they were told
  // offers are "calculated together".
  const both = priceStay({ ...stay, discounts: [
    on({ name: "December", kind: "percent", value: 15 }),
    on({ name: "Long stay", kind: "fixed", value: 20000 }),
  ] });
  check("offers stack", both.total === 150000);
  check("percentage is taken before the flat amount", both.discounts[0].amount === 30000);
  check("each offer is credited with what it took off",
    both.discounts.reduce((a, d) => a + d.amount, 0) === both.discountTotal);

  // Two percentages must total their sum, not compound, or the website's
  // headline and the bill disagree.
  const two = priceStay({ ...stay, discounts: [
    on({ name: "A", kind: "percent", value: 10 }),
    on({ name: "B", kind: "percent", value: 10 }),
  ] });
  check("two percentages add rather than compound", two.discountTotal === 40000);
  check("...and their credited shares still add up to it",
    two.discounts.reduce((a, d) => a + d.amount, 0) === 40000);

  check("a percentage is capped short of free",
    priceStay({ ...stay, discounts: [on({ name: "Absurd", kind: "percent", value: 400 })] }).total === 20000);
  check("a flat amount can never make the bill negative",
    priceStay({ ...stay, discounts: [on({ name: "Absurd", kind: "fixed", value: 900000 })] }).total === 0);

  // Applicability.
  check("an inactive offer is ignored",
    priceStay({ ...stay, discounts: [{ active: false, name: "Off", kind: "percent", value: 50 }] }).total === 200000);
  check("an offer for other room types is ignored",
    priceStay({ ...stay, discounts: [on({ name: "Suites", kind: "percent", value: 50, roomTypes: ["superior"] })] }).total === 200000);
  check("an offer for this room type applies",
    priceStay({ ...stay, discounts: [on({ name: "Deluxe", kind: "percent", value: 50, roomTypes: ["deluxe"] })] }).total === 100000);
  check("a stay too short for the offer is ignored",
    priceStay({ ...stay, nights: 2, discounts: [on({ name: "Week", kind: "percent", value: 50, minNights: 7 })] }).total === 100000);

  // Judged on arrival date, which is the rule a receptionist can explain.
  const december = on({ name: "Dec", kind: "percent", value: 20, startsOn: "2026-12-01", endsOn: "2026-12-31" });
  check("an offer applies to an arrival inside its window",
    applies(december, { roomType: "deluxe", checkIn: "2026-12-10", nights: 4 }) === true);
  check("an arrival before the window misses it",
    applies(december, { roomType: "deluxe", checkIn: "2026-11-30", nights: 4 }) === false);
  check("an arrival after the window misses it",
    applies(december, { roomType: "deluxe", checkIn: "2027-01-02", nights: 4 }) === false);
}


// ---------- report periods and combining ----------
console.log("\n=== month and year windows ===");
{
  const { windowFor, nightsIn, combine } = require("../services/report");

  const sep = windowFor({ period: "month", month: "2026-09" });
  check("a month runs to the first of the next", sep.from === "2026-09-01" && sep.to === "2026-10-01");
  // A window that ends a day early drops the busiest day of the month and
  // nothing on the printed page would look wrong.
  check("a 30-day month counts 30 nights", nightsIn(sep.from, sep.to) === 30);
  check("a month is named the way a person would", sep.label === "September 2026");

  const dec = windowFor({ period: "month", month: "2026-12" });
  check("December rolls into the next year", dec.to === "2027-01-01");
  check("...and still counts 31 nights", nightsIn(dec.from, dec.to) === 31);

  const feb = windowFor({ period: "month", month: "2028-02" });
  check("February in a leap year counts 29 nights", nightsIn(feb.from, feb.to) === 29);

  // An arbitrary stretch of days, which is what somebody asking "how did the
  // long weekend go?" actually wants.
  const range = windowFor({ period: "range", from: "2026-09-03", to: "2026-09-09" });
  check("a range ends the day after the last day asked for", range.to === "2026-09-10");
  // "3rd to the 9th" is seven days to everyone who is not a computer.
  check("...so the 3rd to the 9th is seven nights, not six", nightsIn(range.from, range.to) === 7);
  check("a range is labelled the way a person writes dates",
    range.label === "3 September 2026 to 9 September 2026");
  check("the last day asked for is handed back for the date pickers", range.lastDay === "2026-09-09");

  const oneDay = windowFor({ period: "range", from: "2026-09-03", to: "2026-09-03" });
  check("a single day is one night", nightsIn(oneDay.from, oneDay.to) === 1);
  check("...and is labelled as just that day", oneDay.label === "3 September 2026");

  check("a backwards range is refused",
    windowFor({ period: "range", from: "2026-09-09", to: "2026-09-03" }) === null);
  check("a range missing an end is refused",
    windowFor({ period: "range", from: "2026-09-09" }) === null);
  check("a range of nonsense is refused",
    windowFor({ period: "range", from: "last tuesday", to: "today" }) === null);

  const yr = windowFor({ period: "year", year: "2026" });
  check("a year runs January to January", yr.from === "2026-01-01" && yr.to === "2027-01-01");
  check("a year counts 365 nights", nightsIn(yr.from, yr.to) === 365);
  const leap = windowFor({ period: "year", year: "2028" });
  check("a leap year counts 366", nightsIn(leap.from, leap.to) === 366);

  check("a month of 13 is refused", windowFor({ period: "month", month: "2026-13" }) === null);
  check("a month of 00 is refused", windowFor({ period: "month", month: "2026-00" }) === null);
  check("nonsense is refused", windowFor({ period: "month", month: "September" }) === null);
  check("a year outside living memory is refused", windowFor({ period: "year", year: "1066" }) === null);

  // Two properties of different sizes, which is the case the obvious
  // implementation gets wrong.
  const branch = (o) => ({
    id: o.id, name: o.name,
    rooms: {
      sellable: o.sellable, bookings: o.bookings, nightsSold: o.nightsSold,
      nightsAvailable: o.nightsAvailable, occupancyPercent: 0,
      averageDailyRate: Math.round(o.revenue / o.nightsSold), revPAR: 0,
      revenue: o.revenue, discountsGiven: o.discounts || 0,
      byRoomType: o.byRoomType || {}, bySource: o.bySource || {},
    },
    facilities: { total: o.facilities, chargedToRooms: o.facilities, paidAtTill: 0, byFacility: o.byFacility || [] },
    collected: { byMethod: o.byMethod || {}, payments: o.payments || 0, cardFees: o.cardFees || 0, total: o.collected || 0 },
    revenue: { rooms: o.revenue, facilities: o.facilities, total: o.revenue + o.facilities },
  });

  const small = branch({ id: "exclusive", name: "Divic Exclusive", sellable: 15,
    bookings: 10, nightsSold: 100, nightsAvailable: 450, revenue: 5000000, facilities: 400000,
    byRoomType: { deluxe: { bookings: 10, nights: 100, revenue: 5000000 } },
    bySource: { "walk-in": 6, website: 4 }, byMethod: { cash: 1000000 }, collected: 1000000, payments: 5 });
  const big = branch({ id: "urban", name: "Divic Urban", sellable: 21,
    bookings: 30, nightsSold: 400, nightsAvailable: 630, revenue: 12000000, facilities: 900000,
    byRoomType: { deluxe: { bookings: 30, nights: 400, revenue: 12000000 } },
    bySource: { website: 30 }, byMethod: { cash: 500000, transfer: 2000000 }, collected: 2500000, payments: 20 });

  const all = combine([small, big]);
  check("room revenue adds across properties", all.revenue.rooms === 17000000);
  check("facility revenue adds across properties", all.revenue.facilities === 1300000);
  check("the business total is both together", all.revenue.total === 18300000);
  check("nights sold add", all.rooms.nightsSold === 500);
  check("occupancy is worked out from combined nights", all.rooms.occupancyPercent === Math.round((500 / 1080) * 100));
  // Averaging the two branch rates gives 40,000 — true of neither property and
  // of the business least of all.
  check("the average rate is recomputed, not averaged between branches",
    all.rooms.averageDailyRate === Math.round(17000000 / 500));
  check("...which is not the average of the two branch rates",
    all.rooms.averageDailyRate !== Math.round((small.rooms.averageDailyRate + big.rooms.averageDailyRate) / 2));
  check("room types merge across properties",
    all.rooms.byRoomType.deluxe.nights === 500 && all.rooms.byRoomType.deluxe.revenue === 17000000);
  check("booking sources merge", all.rooms.bySource.website === 34 && all.rooms.bySource["walk-in"] === 6);
  check("payment methods merge", all.collected.byMethod.cash === 1500000 && all.collected.byMethod.transfer === 2000000);
  check("collected totals add", all.collected.total === 3500000 && all.collected.payments === 25);

  const alone = combine([small]);
  check("one property on its own reports itself unchanged",
    alone.revenue.total === small.revenue.total && alone.rooms.averageDailyRate === small.rooms.averageDailyRate);
}


// ---------- what appears on a front desk bill ----------
console.log("\n=== signed to the room ===");
{
  const { shapeBreakdown } = require("../services/folio");

  const row = (booking, facility, amount, items = 1) =>
    ({ _id: { booking, facility }, amount, items });

  const facilities = [
    { _id: "bar1", name: "Rooftop Bar", type: "bar" },
    { _id: "pool1", name: "Pool", type: "pool" },
    { _id: "gym1", name: "Gym", type: "gym" },
  ];

  const out = shapeBreakdown([
    row("bk1", "pool1", 6000),
    row("bk1", "bar1", 18000, 7),
    row("bk2", "gym1", 40000),
  ], facilities);

  check("each booking gets only its own charges",
    out.bk1.length === 2 && out.bk2.length === 1);
  // The whole point: the pool's money must not appear under the bar's name.
  check("facilities are named, not lumped under one",
    out.bk1.map((l) => l.name).sort().join("|") === "Pool|Rooftop Bar");
  check("the largest line is first, since that is the one being queried",
    out.bk1[0].name === "Rooftop Bar" && out.bk1[0].amount === 18000);
  check("the facility's type comes through for the bill", out.bk1[1].type === "pool");
  check("how many items made up the line is kept", out.bk1[0].items === 7);
  check("the lines add up to what the folio says is owed",
    out.bk1.reduce((a, l) => a + l.amount, 0) === 24000);

  // A facility deleted after a guest signed for something there.
  const orphan = shapeBreakdown([row("bk3", "gone", 5000)], facilities);
  check("a deleted facility does not drop the charge off the bill",
    orphan.bk3.length === 1 && orphan.bk3[0].amount === 5000);
  check("...and it is named plainly rather than left blank",
    orphan.bk3[0].name === "A facility");

  check("a guest who signed for nothing has no lines at all",
    shapeBreakdown([], facilities).bk1 === undefined);
}


// ---------- the month-end prompt ----------
console.log("\n=== reports still owed ===");
{
  const { periodsDue } = require("../services/report");

  const fresh = periodsDue("2026-09-13");
  check("the month that just ended is offered first among the months",
    fresh.find((d) => d.kind === "month").period === "2026-08");
  check("the closed year is offered too", fresh.some((d) => d.kind === "year" && d.period === "2025"));
  // Three months back and no further: a prompt reaching to 2019 is a prompt
  // nobody reads, and any period can still be pulled by hand.
  check("it does not reach back forever", fresh.filter((d) => d.kind === "month").length === 3);
  check("the current month is never asked for, it has not ended",
    fresh.every((d) => d.period !== "2026-09"));

  const partly = periodsDue("2026-09-13", [{ kind: "month", period: "2026-08" }, { kind: "year", period: "2025" }]);
  check("a month already taken is not asked for again",
    partly.every((d) => d.period !== "2026-08"));
  check("a year already taken is not asked for again",
    partly.every((d) => d.kind !== "year"));
  check("the ones still outstanding remain", partly.length === 2);

  // January, where "last month" and "last year" are different years.
  const january = periodsDue("2026-01-04");
  check("in January the months roll back into the previous year",
    january.find((d) => d.kind === "month").period === "2025-12");
  check("...and the year just ended is the one offered",
    january.find((d) => d.kind === "year").period === "2025");

  check("nothing is outstanding once everything is taken",
    periodsDue("2026-09-13", fresh).length === 0);

  // ---- a system that went live this month owes nothing yet ----
  // The first morning after deployment must not open with a demand for last
  // year's accounts. Being asked for figures that cannot exist is how people
  // learn to dismiss the prompt, which costs the one month it is there for.
  const justLive = periodsDue("2026-09-13", [], "2026-09-01");
  check("a hotel live this month is owed nothing at all", justLive.length === 0);

  const liveInJune = periodsDue("2026-09-13", [], "2026-06-20");
  check("a hotel live in June is not asked for last year",
    liveInJune.every((d) => d.kind !== "year"));
  check("...but is asked for every closed month it has been running",
    liveInJune.map((d) => d.period).join() === "2026-08,2026-07,2026-06");

  // June is the month it went live: a part-month of real figures is still
  // worth filing, so the month it started in counts.
  check("the month it went live is itself due",
    periodsDue("2026-07-02", [], "2026-06-20").some((d) => d.period === "2026-06"));

  const liveLastYear = periodsDue("2026-01-05", [], "2025-11-01");
  check("a hotel live last November is asked for that year",
    liveLastYear.some((d) => d.kind === "year" && d.period === "2025"));
  check("...and only for the months it existed for",
    liveLastYear.filter((d) => d.kind === "month").map((d) => d.period).join() === "2025-12,2025-11");

  check("no start date means the old behaviour, unchanged",
    periodsDue("2026-09-13", [], null).length === fresh.length);
}


// ---------- the till: order state and split takings ----------
console.log("\n=== till ===");
{
  const { tabState, partsOf, methodKey } = require("../services/till");

  // The three states the bar was asked for, and voided, which is none of them.
  check("an open table is unpaid", tabState({ status: "open" }) === "unpaid");
  check("settled at the till is paid",
    tabState({ status: "settled", settlement: "paid" }) === "paid");
  check("settled onto a room is charged to the room",
    tabState({ status: "settled", settlement: "room" }) === "room");
  check("a voided order says so rather than reverting to unpaid",
    tabState({ status: "settled", settlement: "paid", voided: true }) === "voided");
  check("...even one that was on a room",
    tabState({ status: "settled", settlement: "room", voided: true }) === "voided");

  // A split with any room part leaves money on somebody's folio, so the badge
  // has to say so — reporting it as simply "paid" is the bug worth catching.
  const mixed = { status: "settled", settlement: "paid", parts: [
    { settlement: "paid", amount: 20000, paymentMethod: "cash" },
    { settlement: "room", amount: 20000, roomNumber: "204" },
  ] };
  check("a split with a room part reads as charged to the room", tabState(mixed) === "room");
  check("a split paid entirely at the till reads as paid",
    tabState({ status: "settled", settlement: "paid", parts: [
      { settlement: "paid", amount: 10000, paymentMethod: "cash" },
      { settlement: "paid", amount: 10000, paymentMethod: "transfer" },
    ] }) === "paid");

  // An unsplit bill records no parts at all, so the fallback has to reproduce
  // the single settlement faithfully or every older order vanishes from the
  // takings breakdown.
  const plain = { status: "settled", settlement: "paid", total: 15000 };
  check("a bill with no parts still yields one", partsOf(plain).length === 1);
  check("...for its whole value", partsOf(plain)[0].amount === 15000);
  check("...under its own settlement", partsOf(plain)[0].settlement === "paid");
  check("a split yields its own parts", partsOf(mixed).length === 2);

  check("room money is bucketed as the room, not as a payment method",
    methodKey({ settlement: "room", paymentMethod: "cash" }) === "room");
  check("till money is bucketed by how it was paid",
    methodKey({ settlement: "paid", paymentMethod: "transfer" }) === "transfer");
  check("a till payment with no method recorded falls back to cash",
    methodKey({ settlement: "paid" }) === "cash");

  // The whole point of splitting by part: the cash figure must not swallow
  // money that actually went onto a room.
  const takings = {};
  partsOf(mixed).forEach((p) => { takings[methodKey(p)] = (takings[methodKey(p)] || 0) + p.amount; });
  check("a split table lands in two buckets", Object.keys(takings).length === 2);
  check("...and cash holds only the cash half", takings.cash === 20000);
  check("...and the room holds only the room half", takings.room === 20000);
  check("the buckets still add up to the bill",
    Object.values(takings).reduce((a, b) => a + b, 0) === 40000);
}


// ---------- who may change a menu ----------
console.log("\n=== the menu is a manager's to write ===");
{
  const { requireRole } = require("../middleware/auth");

  const passes = (role) => {
    let ok = false;
    const res = { status() { return this; }, json() { return this; } };
    requireRole("manager", "owner")({ user: { role } }, res, () => { ok = true; });
    return ok;
  };

  check("a manager may write the menu", passes("manager"));
  check("the owner may write the menu", passes("owner"));
  check("bar staff may not write the menu", passes("facility") === false);
  check("a receptionist may not write the menu", passes("receptionist") === false);
  check("a cleaner may not write the menu", passes("cleaner") === false);

  // The guard above is only worth anything if it is actually on the routes.
  // Checked against the source because that is precisely the invariant: every
  // write to a menu goes through the manager gate, and reading does not.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../routes/facilityOps.routes.js"), "utf8");

  const menuRoutes = src.split("\n")
    .filter((l) => /^router\.(get|post|patch|delete|put)\(/.test(l) && l.includes("/menu"));

  check("there are menu routes to check", menuRoutes.length >= 3);

  const writes = menuRoutes.filter((l) => !l.startsWith("router.get("));
  check("every menu write is manager and owner only",
    writes.length > 0 && writes.every((l) => l.includes('requireRole("manager", "owner")')));
  check("...and none of them is open on the pos module alone",
    writes.every((l) => !l.includes('requireModule("pos")')));
  check("reading the menu stays open to whoever works the till",
    menuRoutes.some((l) => l.startsWith("router.get(") && l.includes('requireModule("pos")')));

  // Selling from the menu is the one thing everyone at the till can do, and
  // must not have been caught by the tightening.
  const lineRoute = src.split("\n").find((l) =>
    l.startsWith("router.post(") && l.includes("/tabs/:tabId/lines"));
  check("adding an item to a table is still open to bar staff",
    Boolean(lineRoute) && lineRoute.includes('requireModule("pos")') &&
    !lineRoute.includes('requireRole("manager", "owner")'));
}


// ---------- when a day starts here ----------
console.log("\n=== the hotel's day ===");
{
  const { today, dayOf, dayStart, dayEnd, shiftDays, daysBetween, TZ } = require("../utils/day");

  check("the zone is the hotel's, not the server's", TZ === "Africa/Lagos");

  // Lagos is UTC+1, so its day begins at 23:00 UTC the evening before. Every
  // figure on the dashboard used to start an hour late because of this.
  check("a day begins at 23:00 UTC the night before",
    dayStart("2026-09-14").toISOString() === "2026-09-13T23:00:00.000Z");
  check("and ends when the next one starts, exclusive",
    dayEnd("2026-09-14").toISOString() === dayStart("2026-09-15").toISOString());
  check("a day is exactly 24 hours long",
    dayEnd("2026-09-14") - dayStart("2026-09-14") === 86400000);

  // The hour that was wrong: half past midnight in Lagos.
  const justAfterMidnight = new Date("2026-09-14T23:30:00Z");
  check("a sale at 00:30 belongs to the new day", dayOf(justAfterMidnight) === "2026-09-15");
  check("...which UTC would have called the old one",
    justAfterMidnight.toISOString().slice(0, 10) === "2026-09-14");
  check("...and it falls inside the new day's window",
    justAfterMidnight >= dayStart("2026-09-15") && justAfterMidnight < dayEnd("2026-09-15"));
  check("...and outside the old day's",
    !(justAfterMidnight >= dayStart("2026-09-14") && justAfterMidnight < dayEnd("2026-09-14")));

  // The last minute of a day has to count as that day, or a night's takings
  // lose their busiest hour.
  const lastMinute = new Date("2026-09-14T22:59:59Z"); // 23:59:59 in Lagos
  check("the last second of the evening is still today", dayOf(lastMinute) === "2026-09-14");
  check("...and inside today's window",
    lastMinute >= dayStart("2026-09-14") && lastMinute < dayEnd("2026-09-14"));

  // Every instant belongs to exactly one day, with no gap and no overlap.
  check("days do not overlap", dayEnd("2026-09-14").getTime() === dayStart("2026-09-15").getTime());

  check("today is a real date", /^\d{4}-\d{2}-\d{2}$/.test(today()));
  check("shifting a day crosses a month end", shiftDays("2026-09-30", 1) === "2026-10-01");
  check("shifting back crosses a year end", shiftDays("2027-01-01", -1) === "2026-12-31");
  check("a week is seven days", daysBetween("2026-09-09", "2026-09-16") === 7);
  check("February in a leap year has 29", daysBetween("2028-02-01", "2028-03-01") === 29);
}


// ---------- two shifts round the clock ----------
console.log("\n=== who is meant to be on ===");
{
  const { onRosterAt, shiftsOn, badRoster, badTimes, cleanRoster, windowsFor, lengthOf, covers, minutesOf }
    = require("../services/roster");

  const times = { morningStartsAt: "07:00", nightStartsAt: "19:00" };
  const w = windowsFor(times);

  // The point of setting two times rather than four: the shifts tile the
  // clock. A gap at dawn covered by nobody cannot be expressed.
  check("morning runs to the night's start", w.morning.endsAt === times.nightStartsAt);
  check("night runs to the morning's start", w.night.endsAt === times.morningStartsAt);
  check("together they are exactly 24 hours", lengthOf(w.morning) + lengthOf(w.night) === 1440);
  check("no minute is covered by both",
    [0, 6 * 60, 7 * 60, 12 * 60, 18 * 60, 19 * 60, 23 * 60].every(
      (m) => covers(w.morning, m) !== covers(w.night, m)));

  // Uneven shifts still tile.
  const early = windowsFor({ morningStartsAt: "06:00", nightStartsAt: "22:00" });
  check("a 16/8 split still covers the whole day",
    lengthOf(early.morning) + lengthOf(early.night) === 1440);
  check("...with the long one being the morning", lengthOf(early.morning) === 960);

  const at = (iso) => new Date(iso);   // times below are Lagos, an hour ahead
  const mornings = [{ day: 1, shift: "morning" }];   // Monday mornings
  check("on shift mid-morning", onRosterAt(mornings, times, at("2026-09-14T10:00:00Z")).on === true);
  check("off before the changeover", onRosterAt(mornings, times, at("2026-09-14T05:00:00Z")).on === false);
  check("off after the night takes over", onRosterAt(mornings, times, at("2026-09-14T19:00:00Z")).on === false);
  check("on at the very start", onRosterAt(mornings, times, at("2026-09-14T06:00:00Z")).on === true);
  check("off on another day", onRosterAt(mornings, times, at("2026-09-15T10:00:00Z")).on === false);
  check("it names the shift", onRosterAt(mornings, times, at("2026-09-14T10:00:00Z")).shift === "morning");

  // Half of every day at a hotel: the night shift crosses midnight.
  const nights = [{ day: 1, shift: "night" }];       // Monday nights
  check("on at nine on Monday evening",
    onRosterAt(nights, times, at("2026-09-14T20:00:00Z")).on === true);        // Mon 21:00
  check("still on at two on Tuesday morning",
    onRosterAt(nights, times, at("2026-09-15T01:00:00Z")).on === true);        // Tue 02:00
  check("...and it is still counted as the Monday night shift",
    onRosterAt(nights, times, at("2026-09-15T01:00:00Z")).shift === "night");
  check("off by eight on Tuesday morning",
    onRosterAt(nights, times, at("2026-09-15T07:00:00Z")).on === false);       // Tue 08:00
  check("not on during Monday daytime",
    onRosterAt(nights, times, at("2026-09-14T10:00:00Z")).on === false);

  // Somebody on mornings is not dragged in by the previous night's wrap.
  check("a morning person is off at 2am",
    onRosterAt(mornings, times, at("2026-09-15T01:00:00Z")).on === false);

  check("no roster means never due", onRosterAt([], times, new Date()).on === false);
  check("an absent roster does not throw", onRosterAt(undefined, times, new Date()).on === false);
  check("missing times fall back to sensible ones",
    onRosterAt(mornings, undefined, at("2026-09-14T10:00:00Z")).on === true);

  // Validation.
  check("a good roster passes", badRoster([{ day: 1, shift: "morning" }]) === null);
  check("an absent roster is allowed", badRoster(undefined) === null);
  // A double is a real thing a short-staffed week asks for, so it is allowed.
  check("both shifts on one day are allowed",
    badRoster([{ day: 1, shift: "morning" }, { day: 1, shift: "night" }]) === null);
  check("the same shift twice on one day is refused",
    badRoster([{ day: 1, shift: "night" }, { day: 1, shift: "night" }]) !== null);
  check("a fortnight's worth of entries is refused",
    badRoster(Array.from({ length: 15 }, () => ({ day: 1, shift: "morning" }))) !== null);
  check("an invented shift is refused", badRoster([{ day: 1, shift: "afternoon" }]) !== null);
  check("a day outside the week is refused", badRoster([{ day: 9, shift: "night" }]) !== null);

  check("good times pass", badTimes(times) === null);
  check("a bad time is refused", badTimes({ morningStartsAt: "7am", nightStartsAt: "19:00" }) !== null);
  check("25:00 is refused", badTimes({ morningStartsAt: "25:00", nightStartsAt: "19:00" }) !== null);
  // Both shifts changing over at once would make one the whole day and the
  // other nothing at all.
  check("identical changeover times are refused",
    badTimes({ morningStartsAt: "07:00", nightStartsAt: "07:00" }) !== null);

  const tidied = cleanRoster([{ day: 0, shift: "night" }, { day: 1, shift: "morning" }]);
  check("Monday comes before Sunday", tidied[0].day === 1 && tidied[1].day === 0);
  check("junk entries are dropped",
    cleanRoster([{ day: 2, shift: "brunch" }, { day: 3, shift: "night" }]).length === 1);

  const double = cleanRoster([{ day: 1, shift: "night" }, { day: 1, shift: "morning" }]);
  check("a double survives tidying", double.length === 2);
  check("...with the morning first, since the night runs out of it",
    double[0].shift === "morning" && double[1].shift === "night");
  check("a shift written twice is collapsed",
    cleanRoster([{ day: 1, shift: "night" }, { day: 1, shift: "night" }]).length === 1);

  // ---- somebody covering a whole day on their own ----
  const both = [{ day: 1, shift: "morning" }, { day: 1, shift: "night" }];
  check("on a double at ten in the morning",
    onRosterAt(both, times, at("2026-09-14T10:00:00Z")).shift === "morning");   // Mon 11:00
  check("still on the same double at nine at night",
    onRosterAt(both, times, at("2026-09-14T20:00:00Z")).shift === "night");     // Mon 21:00
  check("and at two the next morning, on the night half",
    onRosterAt(both, times, at("2026-09-15T01:00:00Z")).on === true);           // Tue 02:00
  check("off once the Tuesday morning shift takes over",
    onRosterAt(both, times, at("2026-09-15T07:00:00Z")).on === false);          // Tue 08:00
  // Half past each Lagos hour, which is an hour ahead of UTC.
  const lagos = (d, h) => new Date(Date.UTC(2026, 8, d, h - 1, 30));
  check("a double runs unbroken from its start to the next morning",
    [...Array(17)].map((_, i) => lagos(14, 7 + i))          // Mon 07:30 – 23:30
      .concat([...Array(7)].map((_, i) => lagos(15, i)))    // Tue 00:30 – 06:30
      .every((t) => onRosterAt(both, times, t).on === true));
  check("...and covers nothing before it starts",
    [...Array(7)].map((_, i) => lagos(14, i))               // Mon 00:30 – 06:30
      .every((t) => onRosterAt(both, times, t).on === false));

  check("the day's shifts are listed in the order it runs them",
    shiftsOn(both, at("2026-09-14T10:00:00Z")).join() === "morning,night");
  check("an off day lists nothing", shiftsOn(both, at("2026-09-15T10:00:00Z")).length === 0);
  check("shiftsOn survives an absent roster", shiftsOn(undefined, new Date()).length === 0);
}


// ---------- the assistant keeping up ----------
console.log("\n=== the assistant ===");
{
  const { BUILDERS } = require("../services/aiContext");
  const { PREPARED_PROMPTS } = require("../services/aiPrompts");

  // This is the drift that does not announce itself. A feature ships, nobody
  // teaches the assistant about it, and it answers confidently from a world
  // that no longer exists — which is worse than saying it does not know.
  const missing = PREPARED_PROMPTS
    .map((p) => String(p.context || "").split(":")[0])
    .filter((k) => k && k !== "none" && !BUILDERS[k]);
  check("every prompt points at a builder that exists", missing.length === 0,
    missing.join(", "));

  const reached = new Set(PREPARED_PROMPTS.map((p) => String(p.context || "").split(":")[0]));
  const unreachable = Object.keys(BUILDERS).filter((k) => !reached.has(k));
  check("every builder is reachable from some prompt", unreachable.length === 0,
    unreachable.join(", "));

  // Named explicitly, because these are the ones it was blind to and a silent
  // regression here reads as the assistant simply being unhelpful.
  ["barMenus", "barFloor", "facilityVisitors", "shiftBoard"].forEach((k) => {
    check("it can see " + k, typeof BUILDERS[k] === "function");
  });

  const ids = PREPARED_PROMPTS.map((p) => p.id);
  check("no two prompts share an id", new Set(ids).size === ids.length);
  check("every prompt has a role list",
    PREPARED_PROMPTS.every((p) => Array.isArray(p.roles) && p.roles.length));
  check("every prompt says what to do with the context",
    PREPARED_PROMPTS.every((p) => typeof p.instruction === "string" && p.instruction.length > 10));
}


console.log("\n" + (fail === 0 ? "ALL " + pass + " NEW CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
