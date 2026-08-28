'use strict';
/**
 * IDEMPOTENCY-KEY — new (2026-08-28 production-readiness audit), same
 * design as cs_fixed's middleware/idempotency.js (CAMP/CSTM-2/Transformer/
 * CSVM) adapted to this service's raw MongoDB driver instead of Mongoose.
 * Fully backward compatible: no header sent means zero behavior change.
 *
 * POST /register already has an email-uniqueness check, so a retry could
 * never create two accounts -- but before this it got back a confusing
 * 409 "already_registered" instead of the same success response its
 * first attempt got. This turns that into a real replay.
 */
const { getDB } = require('../db/connection');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const STALE_IN_PROGRESS_MS = 60 * 1000;

function idempotencyGuard(getOwnerId) {
  return async function (req, res, next) {
    const idKey = req.headers['idempotency-key'];
    if (!idKey) return next();

    if (typeof idKey !== 'string' || idKey.length > 255) {
      return res.status(400).json({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key must be a string of 255 characters or fewer.', retryable: false } });
    }

    let ownerId;
    try { ownerId = getOwnerId(req); } catch (_) { return next(); }
    if (!ownerId) return next();

    const db = getDB();
    const col = db.collection('idempotency_records');
    const compositeKey = `${ownerId}:${idKey}:${req.method}:${req.baseUrl}${req.path}`;

    try {
      const existing = await col.findOne({ compositeKey });
      if (existing) {
        if (existing.status === 'completed') {
          res.setHeader('Idempotent-Replay', 'true');
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        const ageMs = Date.now() - existing.createdAt.getTime();
        if (ageMs < STALE_IN_PROGRESS_MS) {
          res.setHeader('Retry-After', '2');
          return res.status(409).json({ error: { code: 'idempotency_key_in_progress', message: 'A request with this Idempotency-Key is already being processed.', retryable: true, retryAfterSeconds: 2 } });
        }
        await col.deleteOne({ _id: existing._id });
      }

      await col.insertOne({ compositeKey, status: 'in_progress', createdAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS) });
    } catch (e) {
      if (e.code === 11000) {
        res.setHeader('Retry-After', '2');
        return res.status(409).json({ error: { code: 'idempotency_key_in_progress', message: 'A request with this Idempotency-Key is already being processed.', retryable: true, retryAfterSeconds: 2 } });
      }
      console.warn('[idempotency] lookup/insert failed, proceeding without guard:', e.message);
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        col.updateOne({ compositeKey }, { $set: { status: 'completed', responseStatus: status, responseBody: body } }).catch(() => {});
      } else {
        col.deleteOne({ compositeKey }).catch(() => {});
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = { idempotencyGuard };
