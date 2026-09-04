'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createMemoryReservationStore,
  createReservationStore,
  createMemoryReservationBackend,
  checkReservationStoreConformance,
  emptyState,
  RESERVATION_STATES,
} = require('../src/reservation-store');

function countingBackend(backend) {
  const calls = { save: 0 };
  return {
    calls,
    load: (...args) => backend.load(...args),
    save: (...args) => { calls.save += 1; return backend.save(...args); },
  };
}

function req(overrides = {}) {
  return {
    idempotencyKey: 'reserve:incident-001',
    poolId: 'pool:incident-001',
    capacityLimitBytes: 2000000000,
    amountBytes: 900000000,
    fenceGeneration: 1,
    expiresAt: '2026-09-03T13:00:00.000Z',
    now: '2026-09-03T12:03:00.000Z',
    ...overrides,
  };
}

test('reserve creates a reservation with a typed active state', async () => {
  const store = createMemoryReservationStore();
  const result = await store.reserve(req());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reservation.status, 'active');
  assert.ok(RESERVATION_STATES.includes(result.reservation.status));
  assert.equal(result.reservation.amountBytes, 900000000);
  assert.equal(result.reservation.poolId, 'pool:incident-001');
});

test('reserve is idempotent for a repeated idempotencyKey with matching parameters', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req());
  const second = await store.reserve(req());
  assert.equal(first.reservation.reservationId, second.reservation.reservationId);
  assert.equal(second.created, false);
});

test('a different idempotencyKey with a stale fence generation is rejected', async () => {
  const store = createMemoryReservationStore();
  await store.reserve(req({ fenceGeneration: 5 }));
  const stale = await store.reserve(req({ idempotencyKey: 'reserve:incident-002', fenceGeneration: 2 }));
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_fence');
});

test('concurrent reserve calls for the same idempotencyKey cannot double-spend', async () => {
  const store = createMemoryReservationStore();
  const [a, b] = await Promise.all([store.reserve(req()), store.reserve(req())]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.reservation.reservationId, b.reservation.reservationId);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
});

test('idempotent replay against a still-active reservation with mismatched parameters is rejected', async () => {
  const store = createMemoryReservationStore();
  await store.reserve(req());
  const mismatched = await store.reserve(req({ amountBytes: 1 }));
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'idempotency_key_conflict');
});

test('reserve rejects a reservation that would overcommit the pool capacity limit', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req({ idempotencyKey: 'reserve:a', amountBytes: 1200000000 }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await store.reserve(req({ idempotencyKey: 'reserve:b', amountBytes: 900000000 }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'capacity_exceeded');
});

test('a reservation at a newer fence cannot overcommit a pool still holding an older fence\'s active reservation', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req({ idempotencyKey: 'reserve:fence-1', fenceGeneration: 1, amountBytes: 1200000000 }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await store.reserve(req({ idempotencyKey: 'reserve:fence-2', fenceGeneration: 2, amountBytes: 900000000 }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'capacity_exceeded');
});

test('reserve rejects a request whose capacityLimitBytes conflicts with an active reservation already recorded for the pool', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req({ idempotencyKey: 'reserve:a', capacityLimitBytes: 2000000000, amountBytes: 100 }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await store.reserve(req({ idempotencyKey: 'reserve:b', capacityLimitBytes: 1000000000, amountBytes: 100 }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'capacity_limit_conflict');
});

test('reserve permits two distinct reservations that together stay within the pool limit', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req({ idempotencyKey: 'reserve:a', amountBytes: 900000000 }));
  const second = await store.reserve(req({ idempotencyKey: 'reserve:b', amountBytes: 900000000 }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.reservation.reservationId, second.reservation.reservationId);
});

test('reserve rejects a request missing poolId or capacityLimitBytes', async () => {
  const store = createMemoryReservationStore();
  const { poolId, ...withoutPool } = req();
  const result = await store.reserve(withoutPool);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
});

test('reserve rejects a zoneless now rather than writing an invalid clock string', async () => {
  const store = createMemoryReservationStore();
  const result = await store.reserve(req({ now: '2026-09-03T12:03:00' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
});

test('reserve rejects an injected clock producing a zoneless timestamp, before any state mutation', async () => {
  const backend = countingBackend(createMemoryReservationBackend());
  const store = createReservationStore({ backend, clock: () => 'not-a-timestamp' });
  const result = await store.reserve(req({ now: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
  assert.equal(backend.calls.save, 0);
});

test('consume rejects an injected clock producing a zoneless timestamp, before any state mutation', async () => {
  const backend = countingBackend(createMemoryReservationBackend());
  const store = createReservationStore({ backend, clock: () => 'not-a-timestamp' });
  const validNowStore = createReservationStore({ backend, clock: () => '2026-09-03T12:03:00.000Z' });
  const { reservation } = await validNowStore.reserve(req({ now: undefined }));
  backend.calls.save = 0;

  const result = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
  assert.equal(backend.calls.save, 0);

  const fetched = await validNowStore.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'active');
});

test('reap rejects an injected clock producing a zoneless timestamp, before any state mutation', async () => {
  const backend = countingBackend(createMemoryReservationBackend());
  const store = createReservationStore({ backend, clock: () => 'not-a-timestamp' });
  const validNowStore = createReservationStore({ backend, clock: () => '2026-09-03T12:03:00.000Z' });
  const { reservation } = await validNowStore.reserve(req({ now: undefined, expiresAt: '2026-09-03T12:04:00.000Z' }));
  backend.calls.save = 0;

  const result = await store.reap({ now: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
  assert.equal(backend.calls.save, 0);

  const fetched = await validNowStore.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'active');
});

test('consume draws down a reservation and cannot exceed it', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const over = await store.consume({
    reservationId: reservation.reservationId,
    idempotencyKey: 'consume:over',
    amountBytes: reservation.amountBytes + 1,
    now: req().now,
  });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'drawdown_exceeds_reservation');

  const ok = await store.consume({
    reservationId: reservation.reservationId,
    idempotencyKey: 'consume:once',
    amountBytes: reservation.amountBytes,
    now: req().now,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reservation.status, 'consumed');
});

test('consumption is one-time: a second distinct consume call is rejected', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  const again = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:again', amountBytes: 1, now: req().now });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_consumed');
});

test('consume is idempotent for a repeated idempotencyKey with a matching amount', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const first = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  const second = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
});

test('a same-key consume replay requesting a different amount is rejected', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const first = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  assert.equal(first.ok, true);
  const mismatched = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: 1, now: req().now });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'consume_amount_mismatch');
});

test('typed expiry rejects consumption of an expired reservation, and reap is idempotent for a reservation nobody consumed', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req({ idempotencyKey: 'reserve:untouched', expiresAt: '2026-09-03T12:04:00.000Z' }));

  const reap1 = await store.reap({ now: '2026-09-03T12:05:00.000Z' });
  assert.equal(reap1.ok, true);
  assert.deepEqual(reap1.expired, [reservation.reservationId]);

  const reap2 = await store.reap({ now: '2026-09-03T12:06:00.000Z' });
  assert.equal(reap2.ok, true);
  assert.deepEqual(reap2.expired, []);

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'expired');
});

test('a consume attempt against an expired reservation persists the expiry, so a later reap reports nothing new', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req({ idempotencyKey: 'reserve:consumed-late', expiresAt: '2026-09-03T12:04:00.000Z' }));
  const expiredConsume = await store.consume({
    reservationId: reservation.reservationId,
    idempotencyKey: 'consume:late',
    amountBytes: reservation.amountBytes,
    now: '2026-09-03T12:05:00.000Z',
  });
  assert.equal(expiredConsume.ok, false);
  assert.equal(expiredConsume.reason, 'expired');

  const reap = await store.reap({ now: '2026-09-03T12:06:00.000Z' });
  assert.equal(reap.ok, true);
  assert.deepEqual(reap.expired, []);

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'expired');
});

test('consume against an expired reservation actually persists the expiry transition', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req({ expiresAt: '2026-09-03T12:04:00.000Z' }));
  await store.consume({
    reservationId: reservation.reservationId,
    idempotencyKey: 'consume:late',
    amountBytes: reservation.amountBytes,
    now: '2026-09-03T12:05:00.000Z',
  });
  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'expired');
});

test('idempotent reserve replay against an already-consumed reservation is rejected', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  const replay = await store.reserve(req());
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'already_consumed');
});

test('idempotent reserve replay against an expired reservation is rejected', async () => {
  const store = createMemoryReservationStore();
  await store.reserve(req({ expiresAt: '2026-09-03T12:04:00.000Z' }));
  // The replay request's own expiresAt must still be valid relative to its
  // own now; it is not used to re-derive the existing reservation's expiry
  // (its original expiresAt of 12:04 is what makes it expired by 12:05).
  const replay = await store.reserve(req({ now: '2026-09-03T12:05:00.000Z' }));
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'expired');
});

test('release frees an active reservation with zero consumed bytes', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const result = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.replayed, false);
  assert.equal(result.reservation.status, 'released');
  assert.equal(result.reservation.consumedBytes, 0);

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'released');
  assert.equal(fetched.reservation.consumedBytes, 0);
});

test('release is idempotent for a repeated idempotencyKey', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const first = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  const second = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.reservation.status, 'released');
});

test('a release replay with a different idempotencyKey against an already-released reservation is rejected without mutation', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  const different = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:different', now: req().now });
  assert.equal(different.ok, false);
  assert.equal(different.reason, 'already_released');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'released');
});

test('idempotent reserve replay against a released reservation is rejected as terminal, never reopened', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  const replay = await store.reserve(req());
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'already_released');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'released');
});

test('release rejects a consumed reservation without mutation', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  const result = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already_consumed');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'consumed');
});

test('release rejects an expired reservation and persists the expiry transition', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req({ expiresAt: '2026-09-03T12:04:00.000Z' }));
  const result = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: '2026-09-03T12:05:00.000Z' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'expired');
});

test('release rejects a missing, invalid, or malformed request without mutation', async () => {
  const store = createMemoryReservationStore();
  const missing = await store.release({ reservationId: 'reservation_does_not_exist', idempotencyKey: 'release:once', now: req().now });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_found');

  const invalid = await store.release({ reservationId: 'not an opaque id!', idempotencyKey: 'release:once', now: req().now });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_request');

  const { reservation } = await store.reserve(req());
  const malformedClock = await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: '2026-09-03T12:03:00' });
  assert.equal(malformedClock.ok, false);
  assert.equal(malformedClock.reason, 'invalid_request');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'active');
});

test('release frees a reservation from aggregate active headroom so a new reservation can reuse it', async () => {
  const store = createMemoryReservationStore();
  const first = await store.reserve(req({ idempotencyKey: 'reserve:a', amountBytes: 1200000000 }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const blocked = await store.reserve(req({ idempotencyKey: 'reserve:b', amountBytes: 900000000 }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'capacity_exceeded');

  const released = await store.release({ reservationId: first.reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  assert.equal(released.ok, true, JSON.stringify(released));

  const second = await store.reserve(req({ idempotencyKey: 'reserve:b', amountBytes: 900000000 }));
  assert.equal(second.ok, true, JSON.stringify(second));
});

test('concurrent release calls for the same reservation and idempotencyKey cannot double-mutate', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const [a, b] = await Promise.all([
    store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now }),
    store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1);

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.reservation.status, 'released');
});

test('consume rejects a released reservation without mutation', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  await store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now });
  const result = await store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already_released');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'released');
  assert.equal(fetched.reservation.consumedBytes, 0);
});

test('a release racing a consume for the same reservation lets only one transition win, and the loser is rejected as already_released', async () => {
  const store = createMemoryReservationStore();
  const { reservation } = await store.reserve(req());
  const [released, consumed] = await Promise.all([
    store.release({ reservationId: reservation.reservationId, idempotencyKey: 'release:once', now: req().now }),
    store.consume({ reservationId: reservation.reservationId, idempotencyKey: 'consume:once', amountBytes: reservation.amountBytes, now: req().now }),
  ]);
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(consumed.ok, false, JSON.stringify(consumed));
  assert.equal(consumed.reason, 'already_released');

  const fetched = await store.get(reservation.reservationId);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.reservation.status, 'released');
  assert.equal(fetched.reservation.consumedBytes, 0);
});

test('get validates its identifier', async () => {
  const store = createMemoryReservationStore();
  const result = await store.get('not an opaque id!');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
});

test('get reports not_found for a missing reservation', async () => {
  const store = createMemoryReservationStore();
  const result = await store.get('reservation_does_not_exist');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('fail-closed recovery: a backend that cannot load denies rather than proceeds', async () => {
  const backend = {
    load() { throw new Error('backend unavailable'); },
    save() { throw new Error('backend unavailable'); },
  };
  const store = createReservationStore({ backend });
  const result = await store.reserve(req());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'store_unavailable');
});

test('fail-closed recovery covers get, consume, release, and reap as well as reserve', async () => {
  const backend = {
    load() { throw new Error('backend unavailable'); },
    save() { throw new Error('backend unavailable'); },
  };
  const store = createReservationStore({ backend });
  const getResult = await store.get('reservation_abc');
  const consumeResult = await store.consume({ reservationId: 'reservation_abc', idempotencyKey: 'consume:x', amountBytes: 1 });
  const releaseResult = await store.release({ reservationId: 'reservation_abc', idempotencyKey: 'release:x' });
  const reapResult = await store.reap({});
  assert.equal(getResult.ok, false);
  assert.equal(getResult.reason, 'store_unavailable');
  assert.equal(consumeResult.ok, false);
  assert.equal(consumeResult.reason, 'store_unavailable');
  assert.equal(releaseResult.ok, false);
  assert.equal(releaseResult.reason, 'store_unavailable');
  assert.equal(reapResult.ok, false);
  assert.equal(reapResult.reason, 'store_unavailable');
});

test('a backend that never resolves compare-and-set returns store_contention rather than throwing', async () => {
  const backend = {
    async load() { return emptyState(); },
    async save() {
      const error = new Error('always stale');
      error.reservationConflict = true;
      throw error;
    },
  };
  const store = createReservationStore({ backend });
  const result = await store.reserve(req());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'store_contention');
});

test('reserve rejects invalid input rather than silently defaulting', async () => {
  const store = createMemoryReservationStore();
  const result = await store.reserve(req({ amountBytes: -1 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_request');
});

test('conformance check passes the reference memory backend', async () => {
  const { createMemoryReservationBackend } = require('../src/reservation-store');
  const result = await checkReservationStoreConformance(createMemoryReservationBackend);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('conformance check fails a backend lacking atomic compare-and-set, not a malformed schema', async () => {
  function createRacyBackend() {
    // Starts from a genuinely valid empty state; save() ignores
    // expectedRevision entirely and always accepts the write, so
    // conformance must fail specifically because compare-and-set is
    // absent, not because the initial state is malformed.
    let state = emptyState();
    return {
      async load() { return JSON.parse(JSON.stringify(state)); },
      async save(next) { state = JSON.parse(JSON.stringify(next)); },
    };
  }
  const result = await checkReservationStoreConformance(createRacyBackend);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => /compare-and-set/i.test(e)));
});
