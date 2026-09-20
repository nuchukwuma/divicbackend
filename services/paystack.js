const https = require("https");
const crypto = require("crypto");

// The secret key never leaves the server. The frontend only ever sees the
// public key and the transaction reference.
function paystackRequest(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path,
        method,
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error("Paystack returned an unreadable response")); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Verifies a transaction with Paystack before anything is written to a folio.
 * A client-side success callback is not proof of payment — a guest can close
 * the tab mid-payment, and a hostile caller can POST whatever they like.
 */
async function verifyTransaction(reference, expectedKobo) {
  const res = await paystackRequest("/transaction/verify/" + encodeURIComponent(reference));
  if (!res || !res.status || !res.data) {
    return { ok: false, reason: "Paystack did not confirm this reference." };
  }
  const { status, amount, currency } = res.data;
  if (status !== "success") return { ok: false, reason: "Payment status from Paystack: " + status, raw: res.data };
  if (currency !== "NGN") return { ok: false, reason: "Unexpected currency: " + currency, raw: res.data };
  if (typeof expectedKobo === "number" && amount < expectedKobo) {
    return { ok: false, reason: "Paid amount is less than the amount due.", raw: res.data };
  }
  return { ok: true, amountNaira: amount / 100, raw: res.data };
}

async function initializeTransaction({ email, amountNaira, reference, metadata, callbackUrl }) {
  return paystackRequest("/transaction/initialize", "POST", {
    email,
    amount: Math.round(amountNaira * 100),   // Paystack works in kobo
    reference,
    metadata,
    callback_url: callbackUrl,
    currency: "NGN",
  });
}

/**
 * Verifies a Paystack webhook against the raw request body.
 *
 * This is not optional. An unverified webhook endpoint lets anyone POST
 * "payment succeeded" for any reference and get a room for free. The signature
 * is HMAC-SHA512 of the RAW body using the secret key, so the route must use
 * express.raw — a body that has been parsed and re-stringified will not match.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!Buffer.isBuffer(rawBody)) return false;
  if (!signature || !process.env.PAYSTACK_SECRET_KEY) return false;
  const expected = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  // Constant-time compare, so a caller cannot narrow the signature by timing.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a transaction and return the amount/reference Paystack actually reports.
 * Useful for reconciliation jobs and callback recovery where the local request
 * record may be missing or stale.
 */
async function verifyAndDescribeTransaction(reference) {
  const res = await paystackRequest(
    "/transaction/verify/" + encodeURIComponent(reference)
  );
  if (!res || !res.status || !res.data) {
    return { ok: false, reason: "Paystack did not return transaction details." };
  }
  const data = res.data;
  if (data.status !== "success") {
    return { ok: false, reason: "Payment status from Paystack: " + data.status, raw: data };
  }
  if (data.currency !== "NGN") {
    return { ok: false, reason: "Unexpected currency: " + data.currency, raw: data };
  }
  return {
    ok: true,
    amountNaira: Number(data.amount || 0) / 100,
    reference: data.reference || reference,
    raw: data,
  };
}


/**
 * Whether card payment is actually on.
 *
 * A live secret key, and nothing else, counts. A test key takes fake money:
 * on a real hotel's site it would show a guest a receipt for a payment that
 * never happened, and the desk would find out at checkout. So an unset key, a
 * placeholder, and sk_test_ all read as off, and the option is not offered to
 * anybody rather than offered and failing.
 *
 * PAYSTACK_ENABLED=1 forces it on for a staging environment that means to use
 * a test key deliberately. It is an override, not the normal path.
 */
function paystackReady() {
  const key = String(process.env.PAYSTACK_SECRET_KEY || "").trim();
  const forced = /^(1|true|yes)$/i.test(String(process.env.PAYSTACK_ENABLED || ""));
  if (forced) return Boolean(key);
  return key.startsWith("sk_live_");
}

/** Why it is off, in words a manager can act on. */
function paystackOffReason() {
  const key = String(process.env.PAYSTACK_SECRET_KEY || "").trim();
  if (!key) return "No Paystack key is set on the server yet.";
  if (key.startsWith("sk_test_")) return "The server is on a Paystack test key, which cannot take real money.";
  return "Paystack is not set up on this server yet.";
}

module.exports = {
  verifyTransaction, verifyAndDescribeTransaction, initializeTransaction, paystackRequest, verifyWebhookSignature,
  paystackReady, paystackOffReason,
};
