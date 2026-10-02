const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { ROLES } = require("../utils/constants");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // "all" means both properties — only valid for manager and owner. A
    // facility user always has a concrete property, never "all".
    location: { type: String, enum: ["exclusive", "urban", "all"], required: true },

    // Which facilities a facility user covers. One bartender might cover the
    // indoor and outdoor bars at Divic 1; another only the restaurant
    // at Divic Urban. Every entry must sit at the user's own property —
    // enforced in routes/staff.routes.js.
    assignedFacilities: [{ type: mongoose.Schema.Types.ObjectId, ref: "Facility" }],
    phone: { type: String, trim: true },

    /**
     * The week this person is meant to work: which of the property's two
     * shifts they are on, per day.
     *
     * A day with no entry is a day off — absence is the right shape for "not in
     * on Tuesdays", rather than a row that has to mean nothing. `day` is 0 for
     * Sunday, matching JavaScript; the screens read the week Monday-first
     * because that is how it is said aloud.
     *
     * The times themselves are not here. A hotel runs round the clock on two
     * shifts, and when those change over is a decision about the building, not
     * about one person — it lives on ShiftTimes, and a manager moving the
     * night shift an hour later moves it for everybody at once rather than
     * editing twenty accounts.
     */
    shifts: [{
      _id: false,
      day: { type: Number, min: 0, max: 6, required: true },
      shift: { type: String, enum: ["morning", "night"], required: true },
    }],

    active: { type: Boolean, default: true },
    /* Somebody who has left. Set instead of deleting the record when the
       account has history — an audit entry, a shift, a payment taken — because
       nineteen collections point at this id and deleting it would turn every
       one of those into "somebody". A removed account is gone from the staff
       list, cannot sign in, and can still be named by the records it made. */
    removedAt: Date,
    lastLoginAt: Date,

    // Set the first time this account dismisses or finishes the guided tour.
    // Tracked here rather than in the browser so it follows the account, not
    // the device — a receptionist who tours the app on the front-desk PC
    // should not be offered it again just for signing in on their phone.
    tourSeenAt: Date,

    // Password protection. A user gets 5 failed password attempts; the 5th
    // failure locks the account until a manager or owner explicitly unlocks it.
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    loginLockedAt: Date,
    loginUnlockedAt: Date,
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

userSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// Never let the hash leave the server, even by accident.
userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id, name: this.name, username: this.username, role: this.role,
    location: this.location, phone: this.phone, active: this.active,
    removedAt: this.removedAt || null,
    assignedFacilities: (this.assignedFacilities || []).map(String),
    shifts: (this.shifts || []).map((s) => ({ day: s.day, shift: s.shift })),
    tourSeenAt: this.tourSeenAt || null,
  };
};

module.exports = mongoose.model("User", userSchema);
