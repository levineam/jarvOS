'use strict';

// Three explicit ports carry every host- and provider-specific detail out of
// this package. Each exchanges only the typed, public records defined in
// observation.js, catalog.js, reclaim.js, and reservation-store.js -- never a
// command, a private path, or a provider- or machine-specific identifier.
//
// `assertReservationPort` is used internally at the one real seam where this
// package accepts a caller-supplied port (`authorizeReclaimReservation`).
// `assertCapacityObservationPort` and `assertExternalReclaimPort` guard ports
// this package never calls itself -- a host adapter supplies observation and
// reclaim evidence as already-validated records -- so they exist for a host
// adapter to self-verify its own port implementation against this contract
// before wiring it up.

function assertPortShape(port, methods, label) {
  if (port === null || typeof port !== 'object') throw new Error(`${label} must be an object`);
  for (const method of methods) {
    if (typeof port[method] !== 'function') throw new Error(`${label} must implement ${method}()`);
  }
}

// CapacityObservationPort: observe(context) -> CapacityObservation
function assertCapacityObservationPort(port) {
  assertPortShape(port, ['observe'], 'capacity observation port');
}

// ExternalReclaimPort: proposeDryRun(request) -> ReclaimReceipt,
//                       execute(request) -> ReclaimReceipt
function assertExternalReclaimPort(port) {
  assertPortShape(port, ['proposeDryRun', 'execute'], 'external reclaim port');
}

// ReservationPersistencePort: reserve/consume/release/reap/get, matching the
// reservation-store.js contract. A conforming implementation must satisfy
// checkReservationStoreConformance from reservation-store.js.
function assertReservationPort(port) {
  assertPortShape(port, ['reserve', 'consume', 'release', 'reap', 'get'], 'reservation-persistence port');
}

module.exports = {
  assertCapacityObservationPort,
  assertExternalReclaimPort,
  assertReservationPort,
};
