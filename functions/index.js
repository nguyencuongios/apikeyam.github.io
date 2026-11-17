const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.database();
const ADMIN_TOKEN = defineSecret("ADMIN_TOKEN");
const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "256kb" }));

const ROOTS = new Set([
  "tweaks", "packages", "api_keys", "licenses", "devices",
  "activations", "blacklist", "api_logs", "audit_logs", "settings"
]);
const now = () => Date.now();
const id = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const response = (res, status, success, code, message, data = {}) =>
  res.status(status).json({ success, code, message, data, timestamp: now() });

function requireAdmin(req, res, next) {
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(supplied, ADMIN_TOKEN.value())) {
    return response(res, 401, false, "ADMIN_UNAUTHORIZED", "Administrator authorization required");
  }
  next();
}
function requireJsonObject(req, res, next) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return response(res, 400, false, "INVALID_BODY", "A JSON object is required");
  }
  next();
}
function logRequest(req, status, started, extra = {}) {
  const record = {
    id: id("req"), method: req.method, path: req.path, status,
    responseTimeMs: Math.max(0, now() - started), timestamp: now(),
    requestId: req.headers["x-request-id"] || id("client"),
    ...extra
  };
  db.ref("api_logs").push(record).catch(() => {});
}
function audit(action, collection, recordId, details = {}) {
  return db.ref("audit_logs").push({
    id: id("audit"), action, collection, recordId,
    details, timestamp: now()
  });
}
function cleanInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (["__proto__", "constructor", "prototype"].includes(k)) continue;
    if (typeof v === "string") out[k] = v.trim().slice(0, 4000);
    else if (["number", "boolean"].includes(typeof v) || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 100);
    else if (typeof v === "object") out[k] = v;
  }
  return out;
}
function expired(record) {
  return Number(record.expiresAt || 0) > 0 && Number(record.expiresAt) <= now();
}
async function readRecord(collection, key) {
  const snap = await db.ref(`${collection}/${key}`).get();
  return snap.exists() ? snap.val() : null;
}
function adminOnly(req, res, next) { requireAdmin(req, res, next); }

app.get("/api/v1/server/health", async (req, res) => {
  const started = now();
  try {
    await db.ref(".info/connected").get();
    logRequest(req, 200, started);
    return response(res, 200, true, "OK", "API is responding", { api: "online", database: "reachable" });
  } catch (e) {
    logRequest(req, 503, started);
    return response(res, 503, false, "DATABASE_ERROR", "Database health check failed");
  }
});

// Admin summary: counts are derived from live database records, never seeded.
app.get("/api/v1/admin/overview", adminOnly, async (req, res) => {
  const started = now();
  try {
    const names = ["api_keys", "packages", "tweaks", "devices", "licenses", "api_logs", "activations"];
    const snaps = await Promise.all(names.map(n => db.ref(n).get()));
    const data = {};
    names.forEach((n, i) => {
      const obj = snaps[i].val() || {};
      const rows = Object.values(obj);
      data[n] = rows.length;
      if (n === "api_keys") {
        data.activeKeys = rows.filter(x => x.status === "ACTIVE" && !expired(x)).length;
        data.expiredKeys = rows.filter(x => expired(x) || x.status === "EXPIRED").length;
        data.revokedKeys = rows.filter(x => x.status === "REVOKED").length;
      }
      if (n === "devices") {
        const threshold = Number((req.query.onlineWindowSeconds || 300)) * 1000;
        data.activeDevices = rows.filter(x => x.status === "ACTIVE").length;
        data.onlineDevices = rows.filter(x => now() - Number(x.lastHeartbeat || 0) <= threshold).length;
      }
      if (n === "api_logs") data.failedRequests = rows.filter(x => Number(x.status) >= 400).length;
    });
    data.updatedAt = now();
    logRequest(req, 200, started);
    return response(res, 200, true, "OK", "Overview loaded", data);
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "Could not load overview");
  }
});

// Paginated list for admin modules.
app.get("/api/v1/admin/:collection", adminOnly, async (req, res) => {
  const started = now();
  const collection = req.params.collection;
  if (!ROOTS.has(collection)) return response(res, 404, false, "NOT_FOUND", "Unknown collection");
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const snap = await db.ref(collection).get();
    let rows = Object.entries(snap.val() || {}).map(([key, value]) => ({ id: key, ...value }));
    const q = String(req.query.q || "").toLowerCase();
    if (q) rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
    if (req.query.status) rows = rows.filter(row => row.status === req.query.status);
    rows.sort((a, b) => Number(b.updatedAt || b.createdAt || b.timestamp || 0) - Number(a.updatedAt || a.createdAt || a.timestamp || 0));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    logRequest(req, 200, started);
    return response(res, 200, true, "OK", "Records loaded", { items: page, total, limit, offset });
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "Could not read records");
  }
});

// Create record
app.post("/api/v1/admin/:collection", adminOnly, requireJsonObject, async (req, res) => {
  const started = now();
  const collection = req.params.collection;
  if (!ROOTS.has(collection)) return response(res, 404, false, "NOT_FOUND", "Unknown collection");
  try {
    const body = cleanInput(req.body);
    const recordId = String(body.id || id(collection.slice(0, 3))).replace(/[.#$[\]/]/g, "_").slice(0, 100);
    delete body.id;
    const record = { ...body, createdAt: now(), updatedAt: now() };
    if (collection === "api_keys" && !record.keyHash) {
      if (!record.licenseKey) return response(res, 400, false, "KEY_REQUIRED", "licenseKey is required");
      record.keyHash = sha256(record.licenseKey);
      delete record.licenseKey;
    }
    const ref = db.ref(`${collection}/${recordId}`);
    if ((await ref.get()).exists()) return response(res, 409, false, "DUPLICATE_ID", "Record ID already exists");
    await ref.set(record);
    await audit("CREATE", collection, recordId);
    logRequest(req, 201, started);
    return response(res, 201, true, "CREATED", "Record created", { id: recordId });
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "Could not create record");
  }
});

// Update record
app.patch("/api/v1/admin/:collection/:recordId", adminOnly, requireJsonObject, async (req, res) => {
  const started = now();
  const { collection, recordId } = req.params;
  if (!ROOTS.has(collection)) return response(res, 404, false, "NOT_FOUND", "Unknown collection");
  try {
    const ref = db.ref(`${collection}/${recordId}`);
    if (!(await ref.get()).exists()) return response(res, 404, false, "NOT_FOUND", "Record not found");
    const patch = cleanInput(req.body);
    delete patch.id; delete patch.createdAt; delete patch.keyHash;
    patch.updatedAt = now();
    await ref.update(patch);
    await audit("UPDATE", collection, recordId, { fields: Object.keys(patch) });
    logRequest(req, 200, started);
    return response(res, 200, true, "UPDATED", "Record updated", { id: recordId });
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "Could not update record");
  }
});

// Explicit delete only. No implicit cascade.
app.delete("/api/v1/admin/:collection/:recordId", adminOnly, async (req, res) => {
  const started = now();
  const { collection, recordId } = req.params;
  if (!ROOTS.has(collection)) return response(res, 404, false, "NOT_FOUND", "Unknown collection");
  try {
    const ref = db.ref(`${collection}/${recordId}`);
    const snap = await ref.get();
    if (!snap.exists()) return response(res, 404, false, "NOT_FOUND", "Record not found");
    await audit("DELETE", collection, recordId, { previousStatus: snap.val().status || null });
    await ref.remove();
    logRequest(req, 200, started);
    return response(res, 200, true, "DELETED", "Record deleted", { id: recordId });
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "Could not delete record");
  }
});

// Generate cryptographically secure package token.
app.post("/api/v1/admin/package-token", adminOnly, (req, res) => {
  const token = crypto.randomBytes(36).toString("base64url").replace(/-/g, "_");
  return response(res, 200, true, "GENERATED", "Package token generated", { token });
});

// Public validation: send only key, packageId, tweakId, deviceFingerprint.
// Store only a hash of the license key.
app.post("/api/v1/license/validate", requireJsonObject, async (req, res) => {
  const started = now();
  try {
    const { licenseKey, packageId, tweakId, deviceFingerprint } = req.body;
    if (!licenseKey || !packageId || !tweakId || !deviceFingerprint)
      return response(res, 400, false, "INVALID_REQUEST", "Required fields are missing");
    const hash = sha256(licenseKey);
    const snap = await db.ref("api_keys").orderByChild("keyHash").equalTo(hash).limitToFirst(1).get();
    if (!snap.exists()) return response(res, 401, false, "INVALID_KEY", "License key is invalid");
    const [keyId, key] = Object.entries(snap.val())[0];
    if (key.status === "REVOKED") return response(res, 403, false, "REVOKED_KEY", "License has been revoked");
    if (key.status === "SUSPENDED") return response(res, 403, false, "SUSPENDED_KEY", "License is suspended");
    if (expired(key)) return response(res, 403, false, "EXPIRED_KEY", "License has expired");
    if (key.status === "BLACKLISTED") return response(res, 403, false, "KEY_BLACKLISTED", "License is blocked");
    if (key.packageId !== packageId) return response(res, 403, false, "PACKAGE_MISMATCH", "Package does not match");
    if (key.tweakId !== tweakId) return response(res, 403, false, "TWEAK_MISMATCH", "Tweak does not match");
    const blocked = await db.ref("blacklist").orderByChild("fingerprintHash").equalTo(sha256(deviceFingerprint)).get();
    if (blocked.exists()) return response(res, 403, false, "DEVICE_BLOCKED", "Device is blocked");
    const devicesSnap = await db.ref("devices").orderByChild("keyId").equalTo(keyId).get();
    const devices = Object.values(devicesSnap.val() || {}).filter(d => d.status !== "REVOKED");
    const found = devices.find(d => d.fingerprintHash === sha256(deviceFingerprint));
    if (!found && devices.length >= Number(key.deviceLimit || 1))
      return response(res, 403, false, "DEVICE_LIMIT_REACHED", "Device limit reached");
    logRequest(req, 200, started, { keyId });
    return response(res, 200, true, "VALID", "License validated", { keyId, status: key.status, expiresAt: key.expiresAt || null });
  } catch (e) {
    logRequest(req, 500, started);
    return response(res, 500, false, "DATABASE_ERROR", "License validation failed");
  }
});

app.post("/api/v1/license/activate", requireJsonObject, async (req, res) => {
  const { licenseKey, packageId, tweakId, deviceFingerprint, deviceName = "iOS Device" } = req.body;
  if (!licenseKey || !packageId || !tweakId || !deviceFingerprint)
    return response(res, 400, false, "INVALID_REQUEST", "Required fields are missing");
  const hash = sha256(licenseKey);
  const snap = await db.ref("api_keys").orderByChild("keyHash").equalTo(hash).limitToFirst(1).get();
  if (!snap.exists()) return response(res, 401, false, "INVALID_KEY", "License key is invalid");
  const [keyId, key] = Object.entries(snap.val())[0];
  if (key.status === "REVOKED" || key.status === "SUSPENDED" || expired(key))
    return response(res, 403, false, expired(key) ? "EXPIRED_KEY" : `${key.status}_KEY`, "License cannot be activated");
  if (key.packageId !== packageId) return response(res, 403, false, "PACKAGE_MISMATCH", "Package does not match");
  if (key.tweakId !== tweakId) return response(res, 403, false, "TWEAK_MISMATCH", "Tweak does not match");
  const fpHash = sha256(deviceFingerprint);
  const devicesSnap = await db.ref("devices").orderByChild("keyId").equalTo(keyId).get();
  const entries = Object.entries(devicesSnap.val() || {});
  let existing = entries.find(([, d]) => d.fingerprintHash === fpHash && d.status === "ACTIVE");
  if (!existing && entries.filter(([, d]) => d.status === "ACTIVE").length >= Number(key.deviceLimit || 1))
    return response(res, 403, false, "DEVICE_LIMIT_REACHED", "Device limit reached");
  let deviceId;
  if (existing) deviceId = existing[0];
  else {
    deviceId = id("dev");
    await db.ref(`devices/${deviceId}`).set({
      keyId, packageId, tweakId, fingerprintHash: fpHash,
      deviceName: String(deviceName).slice(0, 100), status: "ACTIVE",
      firstActivation: now(), lastHeartbeat: now(), createdAt: now(), updatedAt: now()
    });
  }
  await db.ref(`api_keys/${keyId}`).update({ status: "ACTIVE", activatedAt: key.activatedAt || now(), updatedAt: now() });
  await db.ref("activations").push({ keyId, deviceId, packageId, tweakId, timestamp: now(), action: "ACTIVATE" });
  return response(res, 200, true, "ACTIVATED", "Device activated", { keyId, deviceId });
});

app.post("/api/v1/license/heartbeat", requireJsonObject, async (req, res) => {
  const { deviceId, deviceFingerprint } = req.body;
  if (!deviceId || !deviceFingerprint) return response(res, 400, false, "INVALID_REQUEST", "Device details required");
  const ref = db.ref(`devices/${deviceId}`);
  const snap = await ref.get();
  if (!snap.exists()) return response(res, 404, false, "DEVICE_NOT_FOUND", "Device not found");
  const device = snap.val();
  if (device.fingerprintHash !== sha256(deviceFingerprint)) return response(res, 403, false, "DEVICE_BLOCKED", "Device proof failed");
  if (device.status !== "ACTIVE") return response(res, 403, false, "DEVICE_BLOCKED", "Device is not active");
  await ref.update({ lastHeartbeat: now(), updatedAt: now() });
  return response(res, 200, true, "HEARTBEAT_OK", "Heartbeat accepted", { lastHeartbeat: now() });
});

app.get("/api/v1/admin/export/:collection", adminOnly, async (req, res) => {
  const collection = req.params.collection;
  if (!ROOTS.has(collection)) return response(res, 404, false, "NOT_FOUND", "Unknown collection");
  const snap = await db.ref(collection).get();
  return response(res, 200, true, "OK", "Export ready", { collection, exportedAt: now(), records: snap.val() || {} });
});

exports.api = onRequest({ secrets: [ADMIN_TOKEN], cors: true, maxInstances: 10 }, app);
