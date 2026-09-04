'use strict';

const { isObject, clone, isOpaqueId, isSafeNonNegativeInt, isSafePositiveInt, isValidClockValue, normalizeTime, digestOf } = require('./primitives');

// v1 shipped before `release`/`released` existed: it is the pre-release
// contract, and a genuine v1 store can therefore never contain a `released`
// record. v2 is a breaking addition (a new terminal status and its
// `releasedAt`/`releaseIdempotencyKey` fields); old v1-only code must fail
// closed on a v2 store via this schema-version mismatch rather than silently
// misreading a status it does not know about. See README.md for the
// documented rollback boundary this implies.
const RESERVATION_STORE_SCHEMA_VERSION_V1 = 'jarvos-storage-janitor.reservation-store.v1';
const RESERVATION_STORE_SCHEMA_VERSION = 'jarvos-storage-janitor.reservation-store.v2';
const RESERVATION_STATES = Object.freeze(['active', 'consumed', 'expired', 'released']);
const MAX_MUTATE_ATTEMPTS = 8;

function emptyState() {
  return { schemaVersion: RESERVATION_STORE_SCHEMA_VERSION, revision: 0, currentFence: 0, reservations: {}, idempotencyIndex: {} };
}

function validateState(state) {
  const errors = [];
  if (!isObject(state)) return { ok: false, errors: ['reservation-store state must be an object'] };
  if (state.schemaVersion !== RESERVATION_STORE_SCHEMA_VERSION) errors.push(`state.schemaVersion must be ${RESERVATION_STORE_SCHEMA_VERSION}`);
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('state.revision must be a non-negative integer');
  if (!Number.isInteger(state.currentFence) || state.currentFence < 0) errors.push('state.currentFence must be a non-negative integer');
  if (!isObject(state.reservations)) errors.push('state.reservations must be an object');
  if (!isObject(state.idempotencyIndex)) errors.push('state.idempotencyIndex must be an object');
  return { ok: errors.length === 0, errors };
}

// A legitimate v1 store only ever wrote `active`, `consumed`, or `expired`;
// a `released` record under a v1 schemaVersion is impossible for genuine v1
// data, so it is rejected as invalid rather than silently normalized.
function validateV1State(state) {
  const errors = [];
  if (!isObject(state)) return { ok: false, errors: ['reservation-store state must be an object'] };
  if (state.schemaVersion !== RESERVATION_STORE_SCHEMA_VERSION_V1) errors.push(`state.schemaVersion must be ${RESERVATION_STORE_SCHEMA_VERSION_V1}`);
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('state.revision must be a non-negative integer');
  if (!Number.isInteger(state.currentFence) || state.currentFence < 0) errors.push('state.currentFence must be a non-negative integer');
  if (!isObject(state.reservations)) errors.push('state.reservations must be an object');
  if (!isObject(state.idempotencyIndex)) errors.push('state.idempotencyIndex must be an object');
  if (isObject(state.reservations)) {
    for (const record of Object.values(state.reservations)) {
      if (isObject(record) && record.status === 'released') {
        errors.push(`reservation ${record.reservationId} has status "released" under schemaVersion ${RESERVATION_STORE_SCHEMA_VERSION_V1}, which is impossible for a genuine v1 store`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Upgrades an already-validated v1 state to the v2 shape in memory, adding
// the `released`-status fields a v1 record never had. This does not persist
// anything by itself: a mutation persists the upgrade via its normal save,
// while a read-only `get` returns the upgraded shape without writing it back.
function upgradeV1State(state) {
  const upgraded = clone(state);
  upgraded.schemaVersion = RESERVATION_STORE_SCHEMA_VERSION;
  for (const record of Object.values(upgraded.reservations)) {
    if (record.releaseIdempotencyKey === undefined) record.releaseIdempotencyKey = null;
    if (record.releasedAt === undefined) record.releasedAt = null;
  }
  return upgraded;
}

// Every read path funnels through here so a legitimate v1 store loads and
// upgrades exactly once, a v2 store loads as-is, and anything else --
// including a v1 store impossibly marked `released` -- fails closed.
function loadAndUpgradeState(loaded) {
  if (isObject(loaded) && loaded.schemaVersion === RESERVATION_STORE_SCHEMA_VERSION_V1) {
    const v1Validation = validateV1State(loaded);
    if (!v1Validation.ok) return { ok: false, errors: v1Validation.errors };
    return { ok: true, state: upgradeV1State(loaded) };
  }
  const validation = validateState(loaded);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, state: loaded };
}

// A conflict here is the store's declared atomic primitive speaking: a
// conforming backend detects a stale compare-and-set precondition and raises
// exactly this shape rather than silently overwriting the loser's read.
function createReservationConflictError() {
  const error = new Error('concurrent reservation-store mutation');
  error.reservationConflict = true;
  return error;
}

// Raised only after the retry budget for a persistently-conflicting mutation
// is exhausted. It is a distinct, typed condition from a generic backend
// failure so a caller can tell "the backend is unavailable" apart from "the
// backend is fine but too contended right now."
function createReservationContentionError() {
  const error = new Error('reservation-store mutation exceeded its retry budget due to persistent contention');
  error.reservationContention = true;
  return error;
}

function reservationId(idempotencyKey) {
  return `reservation_${digestOf(idempotencyKey).slice(0, 32)}`;
}

function publicReservation(record) {
  return {
    version: RESERVATION_STORE_SCHEMA_VERSION,
    reservationId: record.reservationId,
    poolId: record.poolId,
    fenceGeneration: record.fenceGeneration,
    amountBytes: record.amountBytes,
    consumedBytes: record.consumedBytes,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt,
    releasedAt: record.releasedAt,
  };
}

function isExpired(record, now) {
  return new Date(record.expiresAt).getTime() <= new Date(now).getTime();
}

// An injected clock is untrusted output, not a validated timestamp: it must
// pass through the same strict UTC ISO-8601 check as an explicit `now`
// before it can resolve, so a malformed clock cannot write an invalid
// timestamp into a persisted record.
function resolveNow(now, clock) {
  const candidate = now === undefined ? clock() : now;
  if (!isValidClockValue(candidate)) return { ok: false };
  return { ok: true, value: new Date(candidate).toISOString() };
}

function createReservationStore(options = {}) {
  if (!options.backend || typeof options.backend.load !== 'function' || typeof options.backend.save !== 'function') {
    throw new Error('reservation store backend must implement load() and save()');
  }
  const backend = options.backend;
  const clock = options.clock || (() => new Date().toISOString());

  async function mutate(mutator) {
    for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
      const loaded = await backend.load();
      const normalized = loadAndUpgradeState(loaded);
      if (!normalized.ok) throw new Error(`invalid reservation-store state: ${normalized.errors.join('; ')}`);
      const state = clone(normalized.state);
      const expectedRevision = state.revision;
      const outcome = mutator(state);
      if (outcome && outcome.__noCommit) return outcome.value;
      state.revision = expectedRevision + 1;
      try {
        await backend.save(state, expectedRevision);
        return outcome;
      } catch (error) {
        if (error && error.reservationConflict && attempt < MAX_MUTATE_ATTEMPTS - 1) continue;
        if (error && error.reservationConflict) throw createReservationContentionError();
        throw error;
      }
    }
    throw createReservationContentionError();
  }

  function noCommit(value) {
    return { __noCommit: true, value };
  }

  // No public method may ever throw past its caller: conflict exhaustion is
  // reported as `store_contention`, and any other backend failure (or an
  // off-contract adapter throwing something unexpected) is reported as
  // `store_unavailable`.
  async function guarded(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error && error.reservationContention) return { ok: false, reason: 'store_contention', errors: [error.message] };
      return { ok: false, reason: 'store_unavailable', errors: [error && error.message ? error.message : String(error)] };
    }
  }

  function reserve({ idempotencyKey, amountBytes, fenceGeneration, poolId, capacityLimitBytes, expiresAt, now } = {}) {
    return guarded(async () => {
      if (
        !isOpaqueId(idempotencyKey)
        || !isSafePositiveInt(amountBytes)
        || !Number.isInteger(fenceGeneration) || fenceGeneration < 0
        || !isOpaqueId(poolId)
        || !isSafeNonNegativeInt(capacityLimitBytes)
      ) {
        return {
          ok: false,
          reason: 'invalid_request',
          errors: ['idempotencyKey, amountBytes, fenceGeneration, poolId, and capacityLimitBytes are required and must be well-formed'],
        };
      }
      const resolvedNow = resolveNow(now, clock);
      if (!resolvedNow.ok) return { ok: false, reason: 'invalid_request', errors: ['now must be a valid UTC ISO-8601 timestamp'] };
      const effectiveNow = resolvedNow.value;

      let expiresIso;
      try { expiresIso = normalizeTime(expiresAt, 'expiresAt'); } catch (error) { return { ok: false, reason: 'invalid_request', errors: [error.message] }; }
      if (new Date(expiresIso).getTime() <= new Date(effectiveNow).getTime()) {
        return { ok: false, reason: 'invalid_request', errors: ['expiresAt must be after now'] };
      }

      return mutate((state) => {
        const existingId = state.idempotencyIndex[idempotencyKey];
        if (existingId) {
          const existing = state.reservations[existingId];
          if (!existing) return noCommit({ ok: false, reason: 'store_unavailable', errors: ['idempotency index references a missing reservation'] });

          // A replay must only succeed for a still-active reservation whose
          // parameters match exactly and whose fence is not stale. Anything
          // else -- consumed, expired, or a mismatched replay -- is a typed
          // blocked result, never a silent success.
          if (existing.status === 'active' && isExpired(existing, effectiveNow)) {
            existing.status = 'expired';
            return { ok: false, reason: 'expired' };
          }
          if (existing.status === 'expired') return noCommit({ ok: false, reason: 'expired' });
          if (existing.status === 'consumed') return noCommit({ ok: false, reason: 'already_consumed' });
          // A released reservation is terminal: a reserve replay must never
          // reopen it, regardless of matching parameters or fence.
          if (existing.status === 'released') return noCommit({ ok: false, reason: 'already_released' });

          const matches = existing.amountBytes === amountBytes
            && existing.fenceGeneration === fenceGeneration
            && existing.poolId === poolId
            && existing.capacityLimitBytes === capacityLimitBytes;
          if (!matches) return noCommit({ ok: false, reason: 'idempotency_key_conflict' });
          if (existing.fenceGeneration < state.currentFence) return noCommit({ ok: false, reason: 'stale_fence', currentFence: state.currentFence });

          return noCommit({ ok: true, created: false, reservation: publicReservation(existing) });
        }

        if (fenceGeneration < state.currentFence) {
          return noCommit({ ok: false, reason: 'stale_fence', currentFence: state.currentFence });
        }

        // Prevent aggregate overcommit: every active reservation in this
        // capacity pool counts toward headroom regardless of which fence
        // generation created it, because a newer fence does not make an
        // older, still-consumable reservation's held bytes disappear from
        // capacity accounting. Active reserved bytes across all fence
        // generations are summed with overflow protection and checked
        // against the caller-supplied capacity limit before a new
        // reservation is made. All active reservations in a pool must also
        // agree on the same capacity limit -- a conflicting limit for the
        // same pool is rejected rather than silently accepted, since two
        // different limits for one pool cannot both be honored.
        let activeReserved = 0;
        for (const record of Object.values(state.reservations)) {
          if (record.status !== 'active' || record.poolId !== poolId) continue;
          if (record.capacityLimitBytes !== capacityLimitBytes) {
            return noCommit({
              ok: false,
              reason: 'capacity_limit_conflict',
              errors: [`pool ${poolId} already has an active reservation recorded against a ${record.capacityLimitBytes}-byte capacity limit, which conflicts with the requested ${capacityLimitBytes}-byte limit`],
            });
          }
          const next = activeReserved + record.amountBytes;
          if (!Number.isSafeInteger(next)) {
            return noCommit({ ok: false, reason: 'capacity_exceeded', errors: ['active reservation total overflows a safe integer'] });
          }
          activeReserved = next;
        }
        const projected = activeReserved + amountBytes;
        if (!Number.isSafeInteger(projected) || projected > capacityLimitBytes) {
          return noCommit({
            ok: false,
            reason: 'capacity_exceeded',
            errors: [`reserving ${amountBytes} bytes would exceed the ${capacityLimitBytes}-byte capacity limit for pool ${poolId} (already reserved ${activeReserved} bytes across all active fence generations)`],
          });
        }

        const id = reservationId(idempotencyKey);
        const record = {
          reservationId: id,
          idempotencyKey,
          poolId,
          capacityLimitBytes,
          fenceGeneration,
          amountBytes,
          consumedBytes: 0,
          status: 'active',
          consumeIdempotencyKey: null,
          releaseIdempotencyKey: null,
          createdAt: effectiveNow,
          expiresAt: expiresIso,
          consumedAt: null,
          releasedAt: null,
        };
        state.reservations[id] = record;
        state.idempotencyIndex[idempotencyKey] = id;
        state.currentFence = Math.max(state.currentFence, fenceGeneration);
        return { ok: true, created: true, reservation: publicReservation(record) };
      });
    });
  }

  function consume({ reservationId: id, idempotencyKey, amountBytes, now } = {}) {
    return guarded(async () => {
      if (!isOpaqueId(id) || !isOpaqueId(idempotencyKey) || !isSafePositiveInt(amountBytes)) {
        return { ok: false, reason: 'invalid_request', errors: ['reservationId, idempotencyKey, and amountBytes are required and must be well-formed'] };
      }
      const resolvedNow = resolveNow(now, clock);
      if (!resolvedNow.ok) return { ok: false, reason: 'invalid_request', errors: ['now must be a valid UTC ISO-8601 timestamp'] };
      const effectiveNow = resolvedNow.value;

      return mutate((state) => {
        const record = state.reservations[id];
        if (!record) return noCommit({ ok: false, reason: 'not_found' });

        // A repeat consume with the same idempotency key replays the
        // original result only if it requests the same amount; a
        // same-key replay requesting a different amount is a typed
        // mismatch, never a silent reuse of the original receipt.
        if (record.status === 'consumed' && record.consumeIdempotencyKey === idempotencyKey) {
          if (record.consumedBytes !== amountBytes) {
            return noCommit({ ok: false, reason: 'consume_amount_mismatch', consumedBytes: record.consumedBytes });
          }
          return noCommit({ ok: true, replayed: true, reservation: publicReservation(record) });
        }
        if (record.status === 'consumed') return noCommit({ ok: false, reason: 'already_consumed' });
        // A released reservation is terminal: a consume attempt must never
        // reopen it and rewrite it to `consumed`, regardless of idempotency
        // key or requested amount.
        if (record.status === 'released') return noCommit({ ok: false, reason: 'already_released' });
        if (record.status === 'expired') return noCommit({ ok: false, reason: 'expired' });
        if (record.status === 'active' && isExpired(record, effectiveNow)) {
          // Commit the expiry transition rather than reporting `expired`
          // for a mutation that was never actually persisted.
          record.status = 'expired';
          return { ok: false, reason: 'expired' };
        }
        if (amountBytes > record.amountBytes) return noCommit({ ok: false, reason: 'drawdown_exceeds_reservation', reservationAmountBytes: record.amountBytes });

        record.consumedBytes = amountBytes;
        record.status = 'consumed';
        record.consumeIdempotencyKey = idempotencyKey;
        record.consumedAt = effectiveNow;
        return { ok: true, replayed: false, reservation: publicReservation(record) };
      });
    });
  }

  function release({ reservationId: id, idempotencyKey, now } = {}) {
    return guarded(async () => {
      if (!isOpaqueId(id) || !isOpaqueId(idempotencyKey)) {
        return { ok: false, reason: 'invalid_request', errors: ['reservationId and idempotencyKey are required and must be well-formed'] };
      }
      const resolvedNow = resolveNow(now, clock);
      if (!resolvedNow.ok) return { ok: false, reason: 'invalid_request', errors: ['now must be a valid UTC ISO-8601 timestamp'] };
      const effectiveNow = resolvedNow.value;

      return mutate((state) => {
        const record = state.reservations[id];
        if (!record) return noCommit({ ok: false, reason: 'not_found' });

        // A repeat release with the same idempotency key replays the
        // original result; a released reservation is terminal, so a
        // same-key replay is the only way a second release call can
        // succeed. A different key against an already-released
        // reservation is a typed conflict, never a silent reuse.
        if (record.status === 'released' && record.releaseIdempotencyKey === idempotencyKey) {
          return noCommit({ ok: true, replayed: true, reservation: publicReservation(record) });
        }
        if (record.status === 'released') return noCommit({ ok: false, reason: 'already_released' });
        if (record.status === 'consumed') return noCommit({ ok: false, reason: 'already_consumed' });
        if (record.status === 'expired') return noCommit({ ok: false, reason: 'expired' });
        if (record.status === 'active' && isExpired(record, effectiveNow)) {
          // Commit the expiry transition rather than reporting `expired`
          // for a mutation that was never actually persisted.
          record.status = 'expired';
          return { ok: false, reason: 'expired' };
        }

        // Freeing an active, unexpired reservation drops its status out of
        // `active`, so it stops counting toward reserve()'s aggregate
        // active-headroom sum for its pool immediately, with no
        // consumedBytes drawdown.
        record.status = 'released';
        record.releaseIdempotencyKey = idempotencyKey;
        record.releasedAt = effectiveNow;
        return { ok: true, replayed: false, reservation: publicReservation(record) };
      });
    });
  }

  function reap({ now } = {}) {
    return guarded(async () => {
      const resolvedNow = resolveNow(now, clock);
      if (!resolvedNow.ok) return { ok: false, reason: 'invalid_request', errors: ['now must be a valid UTC ISO-8601 timestamp'] };
      const effectiveNow = resolvedNow.value;

      return mutate((state) => {
        const expired = [];
        for (const record of Object.values(state.reservations)) {
          if (record.status === 'active' && isExpired(record, effectiveNow)) {
            record.status = 'expired';
            expired.push(record.reservationId);
          }
        }
        if (expired.length === 0) return noCommit({ ok: true, expired: [] });
        return { ok: true, expired };
      });
    });
  }

  function get(id) {
    return guarded(async () => {
      if (!isOpaqueId(id)) return { ok: false, reason: 'invalid_request', errors: ['reservationId must be an opaque identifier'] };
      const loaded = await backend.load();
      const normalized = loadAndUpgradeState(loaded);
      if (!normalized.ok) throw new Error(`invalid reservation-store state: ${normalized.errors.join('; ')}`);
      const record = normalized.state.reservations[id];
      if (!record) return { ok: false, reason: 'not_found' };
      return { ok: true, reservation: publicReservation(record) };
    });
  }

  return { reserve, consume, release, reap, get };
}

function createMemoryReservationBackend() {
  let state = emptyState();
  return {
    async load() {
      // Yield a microtask so two logically concurrent callers can both read
      // the pre-mutation state before either commits, exercising the same
      // race a real out-of-process backend would face.
      await Promise.resolve();
      return clone(state);
    },
    async save(next, expectedRevision) {
      await Promise.resolve();
      if (state.revision !== expectedRevision) throw createReservationConflictError();
      state = clone(next);
    },
  };
}

function createMemoryReservationStore(options = {}) {
  return createReservationStore({ ...options, backend: createMemoryReservationBackend() });
}

// Proves a backend actually implements the atomic compare-and-set (or
// equivalent serialization) this store depends on for no-double-spend: a
// second save() against a precondition its own first save() already
// invalidated must be rejected with a reservationConflict error, not
// silently accepted as a last-writer-wins overwrite. This is a mechanical
// property of a *fresh* backend, not a business-semantics check, so it
// validates against the current schema directly rather than through
// loadAndUpgradeState's legacy-store business rules (a fresh backend has no
// legacy store to upgrade from).
async function checkReservationStoreConformance(createBackend) {
  if (typeof createBackend !== 'function') return { ok: false, errors: ['createBackend must be a factory function returning a fresh backend'] };
  const backend = createBackend();
  if (!backend || typeof backend.load !== 'function' || typeof backend.save !== 'function') {
    return { ok: false, errors: ['backend must implement load() and save()'] };
  }
  const base = await backend.load();
  const baseValidation = validateState(base);
  if (!baseValidation.ok) return { ok: false, errors: [`backend.load() must return a valid empty state: ${baseValidation.errors.join('; ')}`] };

  const first = clone(base);
  first.revision = base.revision + 1;
  const second = clone(base);
  second.revision = base.revision + 1;

  await backend.save(first, base.revision);

  let rejected = false;
  try {
    await backend.save(second, base.revision);
  } catch (error) {
    rejected = Boolean(error && error.reservationConflict);
  }

  const errors = [];
  if (!rejected) {
    errors.push('backend.save() accepted a write against a precondition its own prior save() already invalidated; a conforming backend must implement atomic compare-and-set (or equivalent serialization) and reject a stale precondition with a reservationConflict error');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  RESERVATION_STORE_SCHEMA_VERSION,
  RESERVATION_STORE_SCHEMA_VERSION_V1,
  RESERVATION_STATES,
  emptyState,
  validateState,
  createReservationConflictError,
  createReservationStore,
  createMemoryReservationBackend,
  createMemoryReservationStore,
  checkReservationStoreConformance,
};
