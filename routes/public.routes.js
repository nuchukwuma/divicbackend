const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const BookingRequest = require("../models/BookingRequest");
const Rate = require("../models/Rate");
const Discount = require("../models/Discount");
const { priceStay, liveDiscounts, publicDiscount } = require("../services/pricing");
const Facility = require("../models/Facility");
const { availabilityByType, validRange, nightsBetween } = require("../services/availability");
const { LOCATIONS, ROOM_PLAN } = require("../utils/constants");
const { verifyTransaction, initializeTransaction, paystackReady, paystackOffReason } = require("../services/paystack");
const { grossUp, splitSettlement, FEE_CONFIG } = require("../services/paystackFees");
const SiteContent = require("../models/SiteContent");
const FaqEntry = require("../models/FaqEntry");
const { askPublic } = require("../services/gemini");
const { settlePaidRequest } = require("../services/websiteBooking");
const { notify } = require("../services/notify");
const { sendBookingRequestReceivedEmail } = require("../services/guestMail");

/**
 * PUBLIC ENDPOINTS — no authentication.
 *
 * This is what the hotel's marketing website talks to. It can read rates and
 * availability and lodge a booking request. It can NOT create a booking, touch
 * a room, or see a guest record. Everything a stranger sends is treated as
 * untrusted input.
 */

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many booking requests from this connection. Please call the hotel instead." },
});

// Public assistant and quote endpoints cost money per call, so they are capped
// far harder than an authenticated route would be. An open LLM endpoint on a
// public site becomes somebody else's free chatbot within a week.
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { error: "You are asking a little too quickly. Wait a moment, or call the hotel and we will help right away." },
});
const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many price checks from this connection. Please try again shortly." },
});

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const clean = (s, max = 200) => String(s || "").trim().slice(0, max);
// The hotel's day, not UTC's — a guest booking just after midnight must not
// be told their own date is in the past.
const { today, dayStart } = require("../utils/day");

/** GET /api/public/properties — everything the website needs to render itself. */
router.get("/properties", async (_req, res, next) => {
  try {
    const rateDocs = await Rate.find().lean();
    const rateBy = Object.fromEntries(rateDocs.map((d) => [d.location, Object.fromEntries(Object.entries(d.prices))]));

    // Offers ship as their own list, not folded into the rate card. A guest
    // reading "₦45,000 a night" and a guest reading "15% off in December" are
    // being told two different things, and the second only means anything if
    // it is stated. The arithmetic still happens on its own at the moment of
    // booking — see services/pricing.js.
    const offers = await Discount.find({ active: true }).sort({ createdAt: -1 }).lean();
    const offersBy = offers.reduce((a, d) => {
      (a[d.location] = a[d.location] || []).push(publicDiscount(d));
      return a;
    }, {});

    // Only open facilities are published. The public site has no business
    // telling a prospective guest the gym is under maintenance, and the status
    // note is an internal message ("Pump being serviced") that never ships.
    const facilities = await Facility.find({ status: "open" })
      .select("location name slug type openingHours").sort({ type: 1, name: 1 }).lean();
    const facilitiesBy = facilities.reduce((a, f) => {
      (a[f.location] = a[f.location] || []).push({
        name: f.name, slug: f.slug, type: f.type, openingHours: f.openingHours || null,
      });
      return a;
    }, {});

    res.json(Object.values(LOCATIONS).map((l) => {
      const plan = ROOM_PLAN[l.id];
      const types = l.typeOrder.map((type) => ({
        type,
        rate: (rateBy[l.id] || l.rates)[type],
        roomCount: plan.filter((r) => r.type === type).length,
        floors: [...new Set(plan.filter((r) => r.type === type).map((r) => r.floor))].sort(),
      }));
      return {
        id: l.id, name: l.name, address: l.address, phone: l.phone,
        totalRooms: plan.length, currency: "NGN", roomTypes: types,
        facilities: facilitiesBy[l.id] || [],
        discounts: offersBy[l.id] || [],
      };
    }));
  } catch (e) { next(e); }
});

/** GET /api/public/availability?location=urban&checkIn=&checkOut= */
router.get("/availability", async (req, res, next) => {
  try {
    const { location, checkIn, checkOut } = req.query;
    if (!LOCATIONS[location]) return res.status(400).json({ error: "Choose a property." });
    const bad = validRange(checkIn, checkOut);
    if (bad) return res.status(400).json({ error: bad });
    if (checkIn < today()) return res.status(400).json({ error: "Check-in cannot be in the past." });

    const counts = await availabilityByType(location, checkIn, checkOut);
    const rateDoc = await Rate.findOne({ location }).lean();
    const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[location].rates;
    const n = nightsBetween(checkIn, checkOut);
    const offers = await liveDiscounts(location);

    res.json({
      location, checkIn, checkOut, nights: n, currency: "NGN",
      // Availability is exposed as counts only. Never publish room numbers to
      // the public web — that tells a stranger exactly which rooms are empty.
      roomTypes: LOCATIONS[location].typeOrder.map((type) => {
        const priced = priceStay({ rate: prices[type], nights: n, roomType: type, checkIn, discounts: offers });
        return {
          type, available: counts[type] || 0,
          rate: prices[type],
          // `total` stays what the guest pays, so a site that never learns
          // about offers still quotes the right number. The strike-through
          // price and the saving are there for one that does.
          total: priced.total,
          fullTotal: priced.gross,
          discountTotal: priced.discountTotal,
          discounts: priced.discounts,
        };
      }),
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/public/booking-requests
 *
 * Body:
 * {
 *   "location":        "exclusive" | "urban",
 *   "roomType":        "standard" | "deluxe" | "superior" | "classic" | "crown",
 *   "checkIn":         "2026-09-20",
 *   "checkOut":        "2026-09-23",
 *   "adults":          2,
 *   "children":        0,
 *   "guestName":       "Adaeze Okonkwo",
 *   "guestPhone":      "08031234567",
 *   "guestEmail":      "adaeze@example.com",
 *   "specialRequests": "High floor if possible",
 *   "paystackReference": "T123456789"        // optional, only if you take a deposit online
 * }
 *
 * Returns 201 with { reference, status: "pending", quotedRate, quotedTotal }.
 * The guest is told the hotel will confirm — no room is held yet.
 */
router.post("/booking-requests", requestLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const location = b.location;
    if (!LOCATIONS[location]) return res.status(400).json({ error: "Choose a property." });
    if (!LOCATIONS[location].typeOrder.includes(b.roomType)) {
      return res.status(400).json({ error: "That room type is not available at this property." });
    }
    const bad = validRange(b.checkIn, b.checkOut);
    if (bad) return res.status(400).json({ error: bad });
    if (b.checkIn < today()) return res.status(400).json({ error: "Check-in cannot be in the past." });

    const name = clean(b.guestName, 120);
    const phone = clean(b.guestPhone, 20);
    if (name.length < 2) return res.status(400).json({ error: "Enter the guest's full name." });
    if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) return res.status(400).json({ error: "Enter a valid phone number." });

    const adults = Math.min(Math.max(Number(b.adults) || 1, 1), 6);
    const children = Math.min(Math.max(Number(b.children) || 0, 0), 6);

    // Price is recalculated server-side. Never trust a total sent by the browser.
    const rateDoc = await Rate.findOne({ location }).lean();
    const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[location].rates;
    const rate = prices[b.roomType];
    const nights = nightsBetween(b.checkIn, b.checkOut);
    const priced = priceStay({
      rate, nights, roomType: b.roomType, checkIn: b.checkIn,
      discounts: await liveDiscounts(location),
    });

    const counts = await availabilityByType(location, b.checkIn, b.checkOut);
    const likelyAvailable = (counts[b.roomType] || 0) > 0;

    const payment = { required: false, verified: false };
    if (b.paystackReference) {
      // Verified against the discounted total — the figure the guest was
      // shown. Checking against the full rate would reject every payment made
      // while an offer was running.
      const check = await verifyTransaction(clean(b.paystackReference, 100), priced.total * 100);
      payment.paystackReference = clean(b.paystackReference, 100);
      payment.required = true;
      payment.verified = check.ok;
      payment.amount = check.ok ? check.amountNaira : undefined;
      payment.verifiedAt = check.ok ? new Date() : undefined;
      if (!check.ok) return res.status(402).json({ error: "We could not confirm that payment. " + check.reason });
    }

    const doc = await BookingRequest.create({
      reference: "WEB-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      location, roomType: b.roomType,
      checkIn: b.checkIn, checkOut: b.checkOut, nights,
      adults, children,
      guestName: name, guestPhone: phone,
      guestEmail: clean(b.guestEmail, 120).toLowerCase() || undefined,
      specialRequests: clean(b.specialRequests, 500) || undefined,
      quotedRate: rate,
      quotedTotal: priced.total, quotedGross: priced.gross, discounts: priced.discounts,
      payment,
      sourceIp: req.headers["x-forwarded-for"] || req.ip,
      userAgent: clean(req.headers["user-agent"], 200),
    });

    // This legacy/direct-payment path can arrive with an already-verified
    // Paystack reference. Do not leave money stranded in BookingRequest: settle
    // it immediately into Booking + Payment just like the normal payment flow.
    if (payment.verified && payment.paystackReference) {
      const check = await verifyTransaction(
        payment.paystackReference,
        Math.round(payment.amount * 100)
      );
      if (!check.ok) {
        doc.payment.verified = false;
        doc.payment.failureReason = check.reason;
        await doc.save();
        return res.status(402).json({ error: "We could not confirm that payment. " + check.reason });
      }
      await settlePaidRequest(req.app, doc, check);
      const settled = await BookingRequest.findById(doc._id).lean();
      if (settled) Object.assign(doc, settled);
    } else {
      req.app.get("io")?.to("loc:" + location).emit("request:new", {
        reference: doc.reference, guestName: doc.guestName, roomType: doc.roomType,
        checkIn: doc.checkIn, checkOut: doc.checkOut,
      });
      await notify(req.app, {
        location, type: "request:new", urgent: true,
        title: "New website request",
        body: `${doc.guestName} · ${doc.checkIn} → ${doc.checkOut} · ${doc.reference}`,
        entity: "BookingRequest", entityId: doc._id, href: "/front-desk?tab=requests",
      });
    }

    // A plain receipt of what was submitted, entirely separate from payment:
    // it fires here regardless of which branch above ran, says nothing about
    // payment status, and never blocks or fails the request itself — sendMail
    // already catches its own errors, so this can only be a no-op at worst.
    sendBookingRequestReceivedEmail(doc);

    res.status(201).json({
      reference: doc.reference,
      status: doc.status,
      location: LOCATIONS[location].name,
      roomType: doc.roomType,
      checkIn: doc.checkIn, checkOut: doc.checkOut, nights,
      quotedRate: rate, quotedTotal: priced.total, currency: "NGN",
      fullTotal: priced.gross, discountTotal: priced.discountTotal, discounts: priced.discounts,
      paid: !!doc.payment.verified,
      bookingRef: doc.booking ? (await require("../models/Booking").findById(doc.booking).select("ref").lean())?.ref : undefined,
      likelyAvailable,
      message: likelyAvailable
        ? "Your request has been received. The hotel will call you to confirm and hold your room."
        : "Your request has been received, but this room type looks fully booked for those dates. The hotel will call you with alternatives.",
      hotelPhone: LOCATIONS[location].phone,
    });
  } catch (e) { next(e); }
});

/** GET /api/public/booking-requests/:reference — lets a guest check their own request. */
router.get("/booking-requests/:reference", async (req, res, next) => {
  try {
    const doc = await BookingRequest.findOne({ reference: req.params.reference.toUpperCase() })
      .select("reference status location roomType checkIn checkOut nights quotedTotal createdAt").lean();
    if (!doc) return res.status(404).json({ error: "No request found with that reference." });
    res.json({ ...doc, locationName: LOCATIONS[doc.location].name });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  QUOTE — what the guest will actually pay                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/public/quote?location=&roomType=&checkIn=&checkOut=
 *
 * Room total, card fee and grand total as three separate numbers. The guest has
 * to see the fee here, before checkout — a total that grows on the Paystack page
 * feels like a trick even when it is small and disclosed, and it is the most
 * common reason a booking is abandoned at the last step.
 */
router.get("/quote", quoteLimiter, async (req, res, next) => {
  try {
    const { location, roomType, checkIn, checkOut } = req.query;
    if (!LOCATIONS[location]) return res.status(400).json({ error: "Choose a property." });
    if (!LOCATIONS[location].typeOrder.includes(roomType)) {
      return res.status(400).json({ error: "That room type is not available at this property." });
    }
    const bad = validRange(checkIn, checkOut);
    if (bad) return res.status(400).json({ error: bad });
    if (checkIn < today()) return res.status(400).json({ error: "Check-in cannot be in the past." });

    const rateDoc = await Rate.findOne({ location }).lean();
    const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[location].rates;
    const rate = prices[roomType];
    const nights = nightsBetween(checkIn, checkOut);
    // The offer comes off before the card fee is worked out, so the guest is
    // not charged a processing fee on money they are not paying.
    const priced = priceStay({
      rate, nights, roomType, checkIn,
      discounts: await liveDiscounts(location),
    });
    const quote = grossUp(priced.total);

    const counts = await availabilityByType(location, checkIn, checkOut);

    res.json({
      location, locationName: LOCATIONS[location].name,
      roomType, checkIn, checkOut, nights,
      rate,
      roomTotal: quote.roomTotal,
      // Shown beside the room total as a struck-through price and a saving —
      // the offer is only worth running if the guest can see it working.
      fullRoomTotal: priced.gross,
      discountTotal: priced.discountTotal,
      discounts: priced.discounts,
      paystackFee: quote.fee,
      totalPayable: quote.totalPayable,
      currency: "NGN",
      roomsAvailable: counts[roomType] || 0,
      feeNote: quote.feesPassedToGuest
        ? "Includes the card processing fee charged by our payment provider."
        : "No card fee is added to your total.",
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  PAY FOR A REQUEST                                                  */
/* ------------------------------------------------------------------ */

/**
 * POST /api/public/booking-requests/:reference/pay
 *
 * Starts Paystack checkout for a request that already exists. The amount is
 * recomputed here from the stored request — nothing about the price is accepted
 * from the browser, or anyone could book a crown suite for one naira by editing
 * the request in dev tools.
 */
/**
 * GET /api/public/payment-options
 *
 * What this hotel can actually take money through right now. Read by the
 * website and by the desk, so neither has to be redeployed when a key lands or
 * is pulled — one server restart with the key set and the card option comes
 * back on its own, everywhere.
 *
 * Unauthenticated on purpose: it says nothing a guest on the booking page is
 * not about to be shown anyway, and the desk needs it before anyone signs in.
 */
router.get("/payment-options", (_req, res) => {
  const online = paystackReady();
  res.json({
    online,
    // Always available: the desk can take a transfer or cash whatever the card
    // situation is, so there is never no way to pay.
    offline: true,
    reason: online ? null : paystackOffReason(),
  });
});

router.post("/booking-requests/:reference/pay", requestLimiter, async (req, res, next) => {
  try {
    const doc = await BookingRequest.findOne({ reference: String(req.params.reference).toUpperCase() });
    if (!doc) return res.status(404).json({ error: "No request found with that reference." });
    if (doc.status === "accepted" && doc.payment.verified) {
      return res.status(409).json({ error: "This booking has already been paid for." });
    }
    if (["declined", "expired"].includes(doc.status)) {
      return res.status(409).json({ error: "This request is no longer open. Please start a new booking." });
    }

    // Nothing should reach here while card payment is off — the website hides
    // the button — but a stale tab or a direct POST must not start a payment
    // the server cannot honour.
    if (!paystackReady()) {
      return res.status(503).json({
        error: "Card payment is not available at the moment. Please pay by transfer, or call the hotel and the desk will take it.",
      });
    }

    const quote = grossUp(doc.quotedTotal);
    const reference = "DIVICWEB_" + doc.reference.replace("-", "") + "_" + Date.now().toString().slice(-6);

    const init = await initializeTransaction({
      email: doc.guestEmail || "bookings@divic.ng",
      amountNaira: quote.totalPayable,
      reference,
      metadata: {
        requestReference: doc.reference,
        location: doc.location,
        roomType: doc.roomType,
        checkIn: doc.checkIn,
        checkOut: doc.checkOut,
        guestName: doc.guestName,
      },
      callbackUrl: (process.env.WEBSITE_ORIGIN || "") + "/booking-status?ref=" + doc.reference,
    });

    if (!init || !init.status) {
      return res.status(502).json({ error: "We could not start the payment. Please try again, or call the hotel." });
    }

    doc.payment.required = true;
    doc.payment.paystackReference = reference;
    doc.payment.roomTotal = quote.roomTotal;
    doc.payment.feeAmount = quote.fee;
    doc.payment.amount = quote.totalPayable;
    doc.payment.initializedAt = new Date();
    await doc.save();

    res.json({
      reference: doc.reference,
      paystackReference: reference,
      authorizationUrl: init.data.authorization_url,
      accessCode: init.data.access_code,
      roomTotal: quote.roomTotal,
      paystackFee: quote.fee,
      totalPayable: quote.totalPayable,
      currency: "NGN",
    });
  } catch (e) { next(e); }
});

/**
 * GET /api/public/booking-requests/:reference/payment-status
 *
 * The website polls this after the guest returns from Paystack. It re-verifies
 * with Paystack rather than trusting the redirect, because a guest landing back
 * on the site proves nothing about whether money moved.
 */
/**
 * POST /api/public/booking-requests/:reference/reconcile-paystack
 *
 * Recovery endpoint for the PMS/website when the guest paid successfully but
 * the webhook was delayed or unavailable. It verifies directly with Paystack
 * and is idempotent through settlePaidRequest. No client-provided amount is
 * trusted.
 */
router.post("/booking-requests/:reference/reconcile-paystack", async (req, res, next) => {
  try {
    const doc = await BookingRequest.findOne({ reference: String(req.params.reference).toUpperCase() });
    if (!doc) return res.status(404).json({ error: "No request found with that reference." });
    if (!doc.payment.paystackReference) {
      return res.status(400).json({ error: "This booking request has no Paystack reference." });
    }

    if (!doc.payment.verified) {
      const check = await verifyTransaction(doc.payment.paystackReference, Math.round(doc.payment.amount * 100));
      if (!check.ok) {
        doc.payment.failureReason = check.reason;
        await doc.save();
        return res.status(402).json({ paid: false, error: check.reason });
      }
      await settlePaidRequest(req.app, doc, check);
    }

    const fresh = await BookingRequest.findById(doc._id)
      .select("reference status location roomType checkIn checkOut nights quotedTotal payment booking")
      .lean();
    const booking = fresh?.booking
      ? await require("../models/Booking").findById(fresh.booking).select("ref roomNumber status needsAttention").lean()
      : null;

    res.json({
      paid: !!fresh?.payment?.verified,
      reference: fresh?.reference,
      paystackReference: fresh?.payment?.paystackReference,
      status: fresh?.status,
      bookingRef: booking?.ref,
      roomAssigned: !!booking?.roomNumber,
      awaitingRoom: !!booking?.needsAttention,
    });
  } catch (e) { next(e); }
});

router.get("/booking-requests/:reference/payment-status", async (req, res, next) => {
  try {
    const doc = await BookingRequest.findOne({ reference: String(req.params.reference).toUpperCase() });
    if (!doc) return res.status(404).json({ error: "No request found with that reference." });

    if (!doc.payment.verified && doc.payment.paystackReference) {
      const check = await verifyTransaction(doc.payment.paystackReference, Math.round(doc.payment.amount * 100));
      if (check.ok) {
        await settlePaidRequest(req.app, doc, check);
        // Reload the request after settlement so the response reflects the
        // committed booking/payment state rather than a stale document.
        const refreshed = await BookingRequest.findById(doc._id).lean();
        if (refreshed) Object.assign(doc, refreshed);
      } else {
        doc.payment.failureReason = check.reason;
        await doc.save();
      }
    }

    const booking = doc.booking
      ? await require("../models/Booking").findById(doc.booking).select("ref roomNumber needsAttention status").lean()
      : null;

    res.json({
      reference: doc.reference,
      status: doc.status,
      paid: !!doc.payment.verified,
      roomTotal: doc.payment.roomTotal,
      paystackFee: doc.payment.feeAmount,
      amountPaid: doc.payment.verified ? doc.payment.amount : undefined,
      bookingRef: booking ? booking.ref : undefined,
      roomAssigned: booking ? !!booking.roomNumber : false,
      // Deliberately not the room number: that is not public information until
      // the guest is standing at the desk.
      awaitingRoom: booking ? !!booking.needsAttention : false,
      hotelPhone: LOCATIONS[doc.location].phone,
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  SITE CONTENT — promos and popups published from the PMS            */
/* ------------------------------------------------------------------ */

router.get("/content", async (req, res, next) => {
  try {
    const location = LOCATIONS[req.query.location] ? req.query.location : null;
    const now = new Date();

    // Live means switched on and inside its window. A December promo written in
    // November turns itself on and off without anyone remembering to do it.
    const filter = {
      active: true,
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
      ],
    };
    if (location) filter.$and.push({ $or: [{ location: "both" }, { location }] });

    const rows = await SiteContent.find(filter).sort({ priority: -1, updatedAt: -1 }).lean();

    // Only the display fields go out. Who edited it and when is internal.
    res.json(rows.map((r) => ({
      key: r.key, type: r.type, location: r.location,
      title: r.title, body: r.body,
      mediaType: r.mediaType, mediaUrl: r.mediaUrl, caption: r.caption,
      ctaLabel: r.ctaLabel, ctaHref: r.ctaHref, priority: r.priority,
    })));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  FAQ                                                                */
/* ------------------------------------------------------------------ */

/**
 * The curated list. Most visitors have an ordinary question — check-in time,
 * parking, whether there is a pool — and this answers it instantly, for free,
 * and it still works when Gemini is down. The bot below is the fallback, not
 * the front door.
 */
router.get("/faq", async (req, res, next) => {
  try {
    const location = LOCATIONS[req.query.location] ? req.query.location : null;
    const filter = { active: true };
    if (location) filter.$or = [{ location: "both" }, { location }];

    const rows = await FaqEntry.find(filter).sort({ category: 1, order: 1 }).lean();
    res.json(rows.map((r) => ({
      question: r.question, answer: r.answer, category: r.category, location: r.location,
    })));
  } catch (e) { next(e); }
});

/**
 * POST /api/public/faq/ask  { question, location? }
 *
 * Context is built from the published FAQ and public property information only.
 * There is deliberately no path from here to bookings, guests, availability or
 * anything else in the PMS — see services/gemini.js askPublic.
 */
router.post("/faq/ask", askLimiter, async (req, res, next) => {
  try {
    const question = clean(req.body && req.body.question, 300);
    if (question.length < 3) {
      return res.status(400).json({ error: "Type a question, or tap one of the suggestions." });
    }
    const location = LOCATIONS[req.body.location] ? req.body.location : null;

    const faqFilter = { active: true };
    if (location) faqFilter.$or = [{ location: "both" }, { location }];
    const faqs = await FaqEntry.find(faqFilter).sort({ order: 1 }).limit(60).lean();

    const rateDocs = await Rate.find().lean();
    const rateBy = Object.fromEntries(rateDocs.map((d) => [d.location, Object.fromEntries(Object.entries(d.prices))]));

    // Offers ship as their own list, not folded into the rate card. A guest
    // reading "₦45,000 a night" and a guest reading "15% off in December" are
    // being told two different things, and the second only means anything if
    // it is stated. The arithmetic still happens on its own at the moment of
    // booking — see services/pricing.js.
    const offers = await Discount.find({ active: true }).sort({ createdAt: -1 }).lean();
    const offersBy = offers.reduce((a, d) => {
      (a[d.location] = a[d.location] || []).push(publicDiscount(d));
      return a;
    }, {});
    const facilities = await Facility.find({ status: "open" }).select("location name type openingHours").lean();

    const information = {
      properties: Object.values(LOCATIONS).map((l) => ({
        name: l.name, address: l.address, phone: l.phone,
        totalRooms: ROOM_PLAN[l.id].length,
        roomTypes: l.typeOrder.map((t) => ({ type: t, nightlyRate: (rateBy[l.id] || l.rates)[t] })),
        facilities: facilities.filter((f) => f.location === l.id).map((f) => ({ name: f.name, hours: f.openingHours })),
      })),
      currency: "NGN",
      publishedAnswers: faqs.map((f) => ({ question: f.question, answer: f.answer })),
      bookingPage: "/book",
      bookingStatusPage: "/booking-status",
    };

    const result = await askPublic({ question, information });
    if (!result.ok) return res.status(503).json({ error: result.text });
    res.json({ answer: result.text });
  } catch (e) { next(e); }
});

module.exports = router;
