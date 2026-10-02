/**
 * Checks that do not need a database.
 *
 *   node test/integration.test.js
 *
 * Covers the things most expensive to get wrong: the Paystack gross-up (money),
 * webhook signature verification (security), the permission map (who sees what),
 * and the room plan (matches the client's brief).
 *
 * The database-backed paths — a paid request becoming a booking, webhook
 * idempotency, the sold-out fallback — are not covered here because they need a
 * MongoDB replica set for the transaction. Run those against a real Atlas
 * cluster before going live.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_dummy";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://stub";

const crypto = require("crypto");
const mongoose = require("mongoose");
mongoose.connect = async () => ({});   // never dial a real database

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
};

console.log("\n=== Route modules load and mount ===");
const express = require("express");
const app = express();
for (const [path, mod] of [
  ["/api/auth","../routes/auth.routes"], ["/api/rooms","../routes/rooms.routes"],
  ["/api/bookings","../routes/bookings.routes"], ["/api/requests","../routes/requests.routes"],
  ["/api/guests","../routes/guests.routes"], ["/api/payments","../routes/payments.routes"],
  ["/api/facilities","../routes/facilities.routes"], ["/api/staff","../routes/staff.routes"],
  ["/api/analytics","../routes/analytics.routes"], ["/api/audit","../routes/audit.routes"],
  ["/api/ai","../routes/ai.routes"], ["/api/public","../routes/public.routes"],
  ["/api/notifications","../routes/notifications.routes"], ["/api/content","../routes/content.routes"],
  ["/api/webhooks","../routes/webhook.routes"], ["/api/todos","../routes/todos.routes"],
]) {
  try { app.use(path, require(mod)); check(path, true); }
  catch (e) { check(path, false, e.message); }
}

console.log("\n=== Models compile ===");
for (const m of ["User","Room","Rate","Guest","Booking","BookingRequest","Payment","Charge",
                 "Facility","AuditLog","FailedWrite","Notification","SiteContent","FaqEntry","Todo"]) {
  try { require("../models/" + m); check(m, true); }
  catch (e) { check(m, false, e.message); }
}

console.log("\n=== Paystack gross-up nets the hotel exactly the room rate ===");
const { grossUp, feeOn, splitSettlement } = require("../services/paystackFees");
// 2450/2500/2510 straddle the flat-fee waiver; 130000 upward sits past the cap.
for (const t of [2000, 2450, 2500, 2510, 40000, 45000, 50000, 55000, 60000, 65000, 130000, 195000, 500000]) {
  const g = grossUp(t);
  const nets = g.totalPayable - feeOn(g.totalPayable);
  check("N" + t.toLocaleString() + " -> pay N" + g.totalPayable.toLocaleString() +
        " (fee N" + g.fee.toLocaleString() + ")",
        Math.abs(nets - t) < 0.02, "hotel nets N" + nets.toFixed(2));
}
const s = splitSettlement(197150, 195000);
check("settlement split keeps the fee out of revenue",
  s.netAmount === 195000 && s.feeAmount === 2150, "net " + s.netAmount + ", fee " + s.feeAmount);

console.log("\n=== Card payment is off until a live key is set ===");
{
  const { paystackReady, paystackOffReason } = require("../services/paystack");
  const key = process.env.PAYSTACK_SECRET_KEY;
  const flag = process.env.PAYSTACK_ENABLED;
  const withEnv = (k, f) => {
    process.env.PAYSTACK_SECRET_KEY = k === null ? "" : k;
    if (f === undefined) delete process.env.PAYSTACK_ENABLED; else process.env.PAYSTACK_ENABLED = f;
    const out = { ready: paystackReady(), reason: paystackOffReason() };
    return out;
  };

  // A test key takes fake money. Offering it on a live site would show a guest
  // a receipt for a payment that never happened, and the desk would find out
  // at checkout — so it counts as off, not as on.
  check("a test key is not good enough", withEnv("sk_test_abc").ready === false);
  check("...and it says why", /test key/i.test(withEnv("sk_test_abc").reason));
  check("no key at all is off", withEnv(null).ready === false);
  check("...and it says why", /no paystack key/i.test(withEnv(null).reason));
  check("a live key turns it on", withEnv("sk_live_abc").ready === true);
  check("whitespace around a live key does not fool it", withEnv("  sk_live_abc  ").ready === true);
  // Staging sometimes means to use a test key. That has to be deliberate.
  check("the override turns a test key on", withEnv("sk_test_abc", "1").ready === true);
  check("the override cannot conjure a key from nothing", withEnv(null, "1").ready === false);

  process.env.PAYSTACK_SECRET_KEY = key;
  if (flag === undefined) delete process.env.PAYSTACK_ENABLED; else process.env.PAYSTACK_ENABLED = flag;
}

console.log("\n=== Webhook signature ===");
const { verifyWebhookSignature } = require("../services/paystack");
const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "X" } }));
const good = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(body).digest("hex");
check("accepts a correctly signed body", verifyWebhookSignature(body, good) === true);
check("rejects a forged signature", verifyWebhookSignature(body, "a".repeat(128)) === false);
check("rejects a missing signature", verifyWebhookSignature(body, undefined) === false);
check("rejects a tampered body", verifyWebhookSignature(Buffer.from(body.toString() + " "), good) === false);
check("rejects a wrong-length signature", verifyWebhookSignature(body, "abc") === false);

console.log("\n=== Guest search escapes what was typed ===");
const { escapeRegex } = require("../routes/guests.routes");
// A Nigerian phone prefix and a name with a bracket are ordinary things to type
// into the search box; unescaped, both compile to an invalid pattern and 500.
for (const typed of ["+234", "Kene (Jr", "a**b", "[unclosed", "back\\slash", "?x"]) {
  let ok = true;
  try { new RegExp(escapeRegex(typed), "i"); } catch { ok = false; }
  check('"' + typed + '" compiles to a valid pattern', ok);
}
check("escaping keeps it a literal match",
  new RegExp(escapeRegex("+234"), "i").test("+2348012345678"));
check("escaped metacharacters no longer match as wildcards",
  new RegExp(escapeRegex("a.c"), "i").test("abc") === false);
// The catastrophic-backtracking case: escaped, it is a harmless literal.
const t0 = Date.now();
new RegExp(escapeRegex("(a+)+$"), "i").test("a".repeat(40) + "b");
check("a crafted pattern no longer backtracks", Date.now() - t0 < 50,
  Date.now() - t0 + "ms");

console.log("\n=== Permissions ===");
const { PERMISSIONS, ROOM_PLAN } = require("../utils/constants");
check("cleaner cannot reach billing", !PERMISSIONS.cleaner.includes("billing"));
check("cleaner cannot reach analytics", !PERMISSIONS.cleaner.includes("analytics"));
check("cleaner cannot publish to the website", !PERMISSIONS.cleaner.includes("content"));
check("facility staff cannot reach bookings", !PERMISSIONS.facility.includes("bookings"));
check("facility staff cannot reach guests", !PERMISSIONS.facility.includes("guests"));
check("facility staff cannot publish to the website", !PERMISSIONS.facility.includes("content"));
check("receptionist cannot see revenue", !PERMISSIONS.receptionist.includes("analytics"));
check("receptionist cannot publish to the website", !PERMISSIONS.receptionist.includes("content"));
check("receptionist can use the shared to-do list", PERMISSIONS.receptionist.includes("todos"));
check("cleaner can use the shared to-do list", PERMISSIONS.cleaner.includes("todos"));
check("facility staff can use the shared to-do list", PERMISSIONS.facility.includes("todos"));
check("manager can publish to the website", PERMISSIONS.manager.includes("content"));
check("owner can publish to the website", PERMISSIONS.owner.includes("content"));

console.log("\n=== Room plan matches the brief ===");
const count = (loc, type) => ROOM_PLAN[loc].filter((r) => r.type === type).length;
check("Exclusive has 15 rooms", ROOM_PLAN.exclusive.length === 15);
check("Urban has 21 rooms", ROOM_PLAN.urban.length === 21);
check("Exclusive: standard 6, deluxe 5, superior 4",
  count("exclusive","standard")===6 && count("exclusive","deluxe")===5 && count("exclusive","superior")===4);
check("Urban: classic 5, deluxe 6, superior 4, crown 6",
  count("urban","classic")===5 && count("urban","deluxe")===6 &&
  count("urban","superior")===4 && count("urban","crown")===6);


console.log("\n=== Password lock policy ===");
const fs = require("fs");
const userModelText = fs.readFileSync(require("path").join(__dirname, "../models/User.js"), "utf8");
const authRouteText = fs.readFileSync(require("path").join(__dirname, "../routes/auth.routes.js"), "utf8");
const staffRouteText = fs.readFileSync(require("path").join(__dirname, "../routes/staff.routes.js"), "utf8");
check("User stores failed login attempts", userModelText.includes("failedLoginAttempts"));
check("User stores login lock state", userModelText.includes("loginLockedAt"));
check("5 failed attempts are the lock threshold", authRouteText.includes("user.failedLoginAttempts >= 5"));
check("locked login returns HTTP 423", authRouteText.includes("res.status(423)"));
check("successful login resets failed attempts", authRouteText.includes("user.failedLoginAttempts = 0"));
check("manager/owner unlock route exists", staffRouteText.includes('/unlock-login'));
check("manager cannot unlock owner accounts", staffRouteText.includes('Only the owner can unlock an owner account.'));

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
