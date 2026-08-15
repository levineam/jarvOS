'use strict';

/**
 * Read-only doctor for the public shared-skill distribution surface.
 * Never enables harnesses, never writes skill bodies, never invokes models.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  loadConfig,
  SUPPORTED_HARNESSES,
  expandHome,
} = require('./config');
const {
  CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  validatePublicCatalog,
  validateLocalOverlay,
  composeEffectiveCatalog,
  redactEffectiveCatalog,
} = require('./catalog');
const { planSchedulerUnits } = require('./scheduler');
const { MODULE_ROOT } = require('./operator');

function check(id, ok, message, detail = null) {
  return { id, ok: Boolean(ok), message, detail };
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: null, error: null };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { exists: true, value: null, error: 'not a regular file' };
    }
    if ((stat.mode & 0o022) !== 0) {
      return { exists: true, value: null, error: 'group/world writable' };
    }
    return { exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { exists: true, value: null, error: error.message };
  }
}

function asPublicCatalog(value) {
  if (!value) return { schemaVersion: CATALOG_SCHEMA_VERSION, entries: [] };
  if (!value.schemaVersion) {
    return { schemaVersion: CATALOG_SCHEMA_VERSION, entries: Array.isArray(value.entries) ? value.entries : [] };
  }
  return value;
}

function asOverlay(value) {
  if (!value) return { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] };
  if (!value.schemaVersion) {
    return { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: Array.isArray(value.entries) ? value.entries : [] };
  }
  return value;
}

function doctorSharedSkills(options = {}) {
  const loaded = loadConfig(options.configPath);
  // This command is an inspection surface. It must report an absent or
  // incomplete control plane, never create one as a side effect.
  const resolved = loaded.resolved;
  const checks = [];

  checks.push(check(
    'config-schema',
    loaded.config.schemaVersion === 'jarvos.shared-skill-config/v1',
    'shared-skill config schema is supported',
    loaded.path,
  ));

  checks.push(check(
    'control-root',
    fs.existsSync(resolved.controlRoot),
    'control root exists and is owner-safe',
    resolved.controlRoot,
  ));

  const publicRaw = readJsonSafe(resolved.publicCatalogPath);
  const publicCatalog = asPublicCatalog(publicRaw.value);
  const publicValidated = validatePublicCatalog(publicCatalog);
  checks.push(check(
    'public-catalog',
    publicValidated.status === 'valid',
    publicValidated.status === 'valid' ? 'public catalog validates' : `public catalog ${publicValidated.status}`,
    publicValidated.reason || (publicRaw.error || null),
  ));

  const overlayRaw = resolved.localOverlayPath
    ? readJsonSafe(resolved.localOverlayPath)
    : { exists: false, value: null, error: null };
  const localOverlay = asOverlay(overlayRaw.value);
  const overlayValidated = validateLocalOverlay(localOverlay);
  checks.push(check(
    'local-overlay',
    overlayValidated.status === 'valid' || overlayValidated.status === 'absent',
    (overlayValidated.status === 'valid' || overlayValidated.status === 'absent')
      ? (overlayRaw.exists ? 'local overlay validates' : 'local overlay optional/absent')
      : `local overlay ${overlayValidated.status}`,
    overlayValidated.reason || overlayRaw.error || null,
  ));

  const composed = composeEffectiveCatalog({ publicCatalog, localOverlay });
  checks.push(check(
    'effective-catalog',
    composed.status === 'valid',
    composed.status === 'valid'
      ? `effective catalog ok (${composed.catalog.entries.length} entries)`
      : `effective catalog ${composed.status}`,
    composed.reason || null,
  ));

  for (const harness of SUPPORTED_HARNESSES) {
    const entry = resolved.allHarnesses.find((item) => item.id === harness);
    const adapterPath = path.resolve(MODULE_ROOT, '..', '..', 'runtimes', harness, 'adapter.json');
    let adapterOk = false;
    let tier = null;
    if (fs.existsSync(adapterPath)) {
      try {
        const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
        const projection = adapter.skillProjection || null;
        adapterOk = Boolean(
          projection
          && projection.version === 'jarvos-skill-projection-adapter/v1'
          && projection.renderer === 'raw-skill-bundle'
          && ['exact-path', 'interactive-smoke'].includes(projection.verificationTier),
        );
        tier = projection?.verificationTier || null;
      } catch {
        adapterOk = false;
      }
    }
    checks.push(check(
      `adapter-${harness}`,
      adapterOk,
      adapterOk
        ? `${harness} skillProjection declared (${tier}; enabled=${entry?.enabled !== false})`
        : `${harness} skillProjection missing or invalid`,
      entry ? entry.root : null,
    ));
  }

  const publicEntries = publicCatalog.entries.length;
  const localEntries = localOverlay.entries.length;
  if (publicEntries > 0) {
    checks.push(check(
      'public-source-root',
      Boolean(resolved.publicSourceRoot && fs.existsSync(resolved.publicSourceRoot)),
      resolved.publicSourceRoot
        ? (fs.existsSync(resolved.publicSourceRoot) ? 'publicSourceRoot exists' : 'publicSourceRoot missing on disk')
        : 'publicSourceRoot required because public catalog has entries',
      resolved.publicSourceRoot,
    ));
  } else {
    checks.push(check(
      'public-source-root',
      true,
      'publicSourceRoot not required (empty public catalog)',
      resolved.publicSourceRoot,
    ));
  }

  if (localEntries > 0) {
    checks.push(check(
      'local-source-root',
      Boolean(resolved.localSourceRoot && fs.existsSync(resolved.localSourceRoot)),
      resolved.localSourceRoot
        ? (fs.existsSync(resolved.localSourceRoot) ? 'localSourceRoot exists' : 'localSourceRoot missing on disk')
        : 'localSourceRoot required because local overlay has entries',
      resolved.localSourceRoot,
    ));
  } else {
    checks.push(check(
      'local-source-root',
      true,
      'localSourceRoot not required (no local overlay entries)',
      resolved.localSourceRoot,
    ));
  }

  let schedulerPlan = null;
  try {
    schedulerPlan = planSchedulerUnits({
      moduleRoot: MODULE_ROOT,
      configPath: loaded.path,
      unitName: loaded.config.scheduler.unitName,
      intervalMinutes: loaded.config.scheduler.intervalMinutes,
      write: false,
      platform: options.platform,
      home: options.home || expandHome('~'),
    });
    checks.push(check(
      'scheduler-plan',
      schedulerPlan && schedulerPlan.artifacts.length > 0 && schedulerPlan.enabled === false,
      `scheduler plan ready (${schedulerPlan.platform}; write=false; enabled=false)`,
      schedulerPlan.unitName,
    ));
  } catch (error) {
    checks.push(check(
      'scheduler-plan',
      false,
      `scheduler plan failed: ${error.message}`,
      null,
    ));
  }

  checks.push(check(
    'live-gates',
    loaded.config.scheduler.enabled !== true,
    loaded.config.scheduler.enabled
      ? 'scheduler.enabled is true — owner must confirm before treating as live'
      : 'scheduler.enabled is false (safe default)',
    null,
  ));

  // Autonomous inventory is opt-in; doctor only reports readiness, never enables it.
  const inventoryEnabled = loaded.config.inventory?.enabled === true;
  const registeredRootCount = Array.isArray(loaded.config.inventory?.registeredRoots)
    ? loaded.config.inventory.registeredRoots.length
    : 0;
  checks.push(check(
    'inventory-autonomy',
    !inventoryEnabled || registeredRootCount > 0,
    inventoryEnabled
      ? `inventory.enabled with ${registeredRootCount} registered root(s); autonomous-repair is the scheduler backstop`
      : 'inventory.enabled is false (safe default; events/scheduler remain inert)',
    null,
  ));
  if (schedulerPlan) {
    const usesAutonomous = schedulerPlan.scheduledCommand === 'autonomous-repair';
    checks.push(check(
      'scheduler-command',
      usesAutonomous,
      'scheduler units target autonomous-repair (complete generation + mutation denial)',
      schedulerPlan.unitName,
    ));
  }

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    surface: 'shared-skills',
    configPath: loaded.path,
    controlRoot: resolved.controlRoot,
    checks,
    redacted: composed.status === 'valid' ? redactEffectiveCatalog(composed) : null,
    scheduler: schedulerPlan ? {
      platform: schedulerPlan.platform,
      unitName: schedulerPlan.unitName,
      intervalMinutes: schedulerPlan.intervalMinutes,
      enabled: false,
      artifactCount: schedulerPlan.artifacts.length,
    } : null,
    inventory: {
      enabled: inventoryEnabled,
      registeredRootCount,
    },
    next: ok
      ? 'Run isolated dogfood, then owner live-preflight checklist before enabling any harness gate.'
      : 'Resolve failing checks before share/apply. Do not enable live gates.',
  };
}

module.exports = {
  doctorSharedSkills,
};
