const router = require("express").Router();
const Guest = require("../models/Guest");
const Booking = require("../models/Booking");
const { requireAuth, requireModule } = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { TZ } = require("../utils/day");

router.use(requireAuth, requireModule("guests"));

// The search box is a plain substring match, so every regex metacharacter in
// what was typed has to be neutered first. Unescaped it is two bugs at once: a
// receptionist searching "+234" or "Kene (Jr" compiles an invalid pattern and
// gets a 500, and a crafted one ("(a+)+$") backtracks for minutes, blocking the
// event loop for every other user on this single-threaded process.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The guest list.
 *
 * Ordered by who was here last, not alphabetically. A guest record is kept
 * forever and nothing ever deletes one, but an A–Z list capped at a hundred
 * behaves as though it does: the person the desk dealt with last night is
 * somewhere in the middle of the alphabet, past the cap, and the only way to
 * reach them is to already know their name and search for it. From the desk
 * that reads as the records having been wiped overnight — and worse, a
 * returning guest who cannot be found gets typed in again as a new one.
 *
 * So: most recent stay first, a total so the list says how much it is not
 * showing, and a skip so the rest can actually be reached.
 */
router.get("/", async (req, res, next) => {
  try {
    const { q } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const byName = req.query.sort === "name";

    const needle = q ? new RegExp(escapeRegex(String(q).trim()), "i") : null;
    const filter = needle
      ? { $or: [{ name: needle }, { phone: needle }, { email: needle }] }
      : {};

    const total = await Guest.countDocuments(filter);

    const guests = await Guest.aggregate([
      { $match: filter },
      // Each guest's history, joined here rather than in a second query,
      // because the list is ordered by it and a page cannot be chosen before
      // the order is known.
      {
        $lookup: {
          from: Booking.collection.name,
          let: { gid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$guest", "$$gid"] }, status: { $ne: "cancelled" } } },
            {
              $group: {
                _id: null,
                stays: { $sum: 1 }, nights: { $sum: "$nights" },
                spend: { $sum: "$totalCharge" }, lastStay: { $max: "$checkIn" },
                properties: { $addToSet: "$location" },
              },
            },
          ],
          as: "history",
        },
      },
      {
        $addFields: {
          stays: { $ifNull: [{ $arrayElemAt: ["$history.stays", 0] }, 0] },
          nights: { $ifNull: [{ $arrayElemAt: ["$history.nights", 0] }, 0] },
          spend: { $ifNull: [{ $arrayElemAt: ["$history.spend", 0] }, 0] },
          lastStay: { $ifNull: [{ $arrayElemAt: ["$history.lastStay", 0] }, null] },
          properties: { $ifNull: [{ $arrayElemAt: ["$history.properties", 0] }, []] },
        },
      },
      {
        // Somebody added at the desk this morning has no stay yet and must not
        // sink to the bottom of a list headed "most recent" — their record was
        // made a minute ago, so that date stands in.
        $addFields: {
          recency: {
            $ifNull: [
              "$lastStay",
              { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } },
            ],
          },
        },
      },
      { $project: { history: 0 } },
      { $sort: byName ? { name: 1, _id: 1 } : { recency: -1, createdAt: -1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    res.json({ guests, total, hasMore: skip + guests.length < total });
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const guest = await Guest.findById(req.params.id).lean();
    if (!guest) return res.status(404).json({ error: "That guest record does not exist." });
    const stays = await Booking.find({ guest: guest._id }).sort({ checkIn: -1 }).lean();
    res.json({ ...guest, stays });
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "A guest needs at least a name and phone number." });
    const existing = await Guest.findOne({ phone: phone.trim() });
    if (existing) return res.status(409).json({ error: "A guest with that phone number already exists.", guest: existing });
    const guest = await Guest.create(req.body);
    logAction(req, { action: "Added guest " + guest.name, entity: "Guest", entityId: guest._id });
    res.status(201).json(guest);
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const allowed = ["name", "phone", "email", "idType", "idNumber", "address", "notes"];
    const update = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const guest = await Guest.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!guest) return res.status(404).json({ error: "That guest record does not exist." });
    logAction(req, { action: "Updated the record for " + guest.name, entity: "Guest", entityId: guest._id });
    res.json(guest);
  } catch (e) { next(e); }
});

module.exports = router;
// Exported so test/integration.test.js can exercise it without a database.
module.exports.escapeRegex = escapeRegex;
