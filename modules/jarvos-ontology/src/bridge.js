/**
 * bridge.js — Ontology → Paperclip goal/project bridge.
 *
 * Maps ontology Goals (G1, G2…) to Paperclip Goals and
 * ontology Projects (PJ1, PJ2…) to Paperclip Projects.
 *
 * Idempotent upsert: reads bridge-state.json for ID mapping,
 * creates/updates Paperclip entities, writes mapping back.
 *
 * Ontology = meaning truth (status, purpose, links).
 * Paperclip = execution truth (issues, runs, billing).
 * This bridge syncs meaning → execution. Not the reverse.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { loadOntology, getGoals, getProjects } from './reader.js';

// ─── Status mapping ────────────────────────────────────────────────────────

const GOAL_STATUS_MAP = {
  'active':           'active',
  'achieved':         'achieved',
  'cancelled':        'cancelled',
  'stopped':          'paused',
  'someday/long-term':'planned',
  'ongoing':          'active',
};

const PROJECT_STATUS_MAP = {
  'active':           'in_progress',
  'achieved':         'done',
  'cancelled':        'cancelled',
  'stopped':          'paused',
  'someday/long-term':'backlog',
  'ongoing':          'in_progress',
};

function mapGoalStatus(ontologyStatus) {
  if (!ontologyStatus) return 'planned';
  const key = ontologyStatus.toLowerCase().trim();
  return GOAL_STATUS_MAP[key] || 'planned';
}

function mapProjectStatus(ontologyStatus) {
  if (!ontologyStatus) return 'backlog';
  const key = ontologyStatus.toLowerCase().trim();
  return PROJECT_STATUS_MAP[key] || 'backlog';
}

// ─── Bridge state persistence ──────────────────────────────────────────────

const EMPTY_STATE = {
  goalMap: {},        // ontologyId → paperclipUUID
  projectMap: {},     // ontologyId → paperclipUUID
  lastSyncAt: null,
  syncLog: [],        // last N sync events for auditability
};

export function loadBridgeState(stateDir) {
  const filePath = join(stateDir, 'bridge-state.json');
  if (!existsSync(filePath)) return { ...EMPTY_STATE, syncLog: [] };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      goalMap: raw.goalMap || {},
      projectMap: raw.projectMap || {},
      lastSyncAt: raw.lastSyncAt || null,
      syncLog: raw.syncLog || [],
    };
  } catch {
    return { ...EMPTY_STATE, syncLog: [] };
  }
}

export function saveBridgeState(stateDir, state) {
  const filePath = join(stateDir, 'bridge-state.json');
  // Keep only last 50 log entries
  const trimmedState = {
    ...state,
    syncLog: (state.syncLog || []).slice(-50),
  };
  writeFileSync(filePath, JSON.stringify(trimmedState, null, 2) + '\n');
}

// ─── Paperclip API helpers ─────────────────────────────────────────────────

async function paperclipFetch(baseUrl, apiKey, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Paperclip API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function listGoals(baseUrl, apiKey, companyId) {
  return paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/goals`);
}

async function createGoal(baseUrl, apiKey, companyId, data) {
  return paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/goals`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async function updateGoal(baseUrl, apiKey, goalId, data) {
  return paperclipFetch(baseUrl, apiKey, `/api/goals/${goalId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

async function listProjects(baseUrl, apiKey, companyId) {
  return paperclipFetch(baseUrl, apiKey, `/api/companies/${companyId}/projects`);
}

async function updateProject(baseUrl, apiKey, projectId, data) {
  return paperclipFetch(baseUrl, apiKey, `/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ─── Core sync logic ───────────────────────────────────────────────────────

/**
 * Resolve the ontology goal → Paperclip goal mapping.
 * Returns per-goal action: create, update, skip, or error.
 */
function planGoalSync(ontologyGoals, paperclipGoals, bridgeState) {
  const plan = [];
  const pcGoalById = new Map(paperclipGoals.map(g => [g.id, g]));
  const pcGoalByTitle = new Map(paperclipGoals.map(g => [g.title.toLowerCase(), g]));

  for (const oGoal of ontologyGoals) {
    const mappedId = bridgeState.goalMap[oGoal.id];
    const targetStatus = mapGoalStatus(oGoal.metadata?.status);

    // Case 1: Already mapped
    if (mappedId) {
      const pcGoal = pcGoalById.get(mappedId);
      if (!pcGoal) {
        // Mapped ID no longer exists in Paperclip — stale mapping
        plan.push({
          action: 'error',
          ontologyId: oGoal.id,
          reason: `Mapped Paperclip goal ${mappedId} not found (deleted?). Manual intervention needed.`,
          staleMapping: mappedId,
        });
        continue;
      }

      // Check if update needed
      const needsUpdate =
        pcGoal.title !== oGoal.name ||
        pcGoal.status !== targetStatus;

      if (needsUpdate) {
        plan.push({
          action: 'update',
          ontologyId: oGoal.id,
          paperclipId: mappedId,
          updates: {
            title: oGoal.name,
            status: targetStatus,
          },
          reason: `Ontology title/status changed`,
        });
      } else {
        plan.push({
          action: 'skip',
          ontologyId: oGoal.id,
          paperclipId: mappedId,
          reason: 'Already in sync',
        });
      }
      continue;
    }

    // Case 2: No mapping — try title match (fuzzy seed)
    const titleMatch = pcGoalByTitle.get(oGoal.name.toLowerCase());
    if (titleMatch) {
      plan.push({
        action: 'adopt',
        ontologyId: oGoal.id,
        paperclipId: titleMatch.id,
        updates: { status: targetStatus },
        reason: `Title match found — adopting existing Paperclip goal`,
      });
      continue;
    }

    // Case 3: No mapping, no match — create
    plan.push({
      action: 'create',
      ontologyId: oGoal.id,
      data: {
        title: oGoal.name,
        description: oGoal.metadata?.quote || null,
        level: 'team',
        status: targetStatus,
      },
      reason: 'New ontology goal — creating in Paperclip',
    });
  }

  return plan;
}

/**
 * Resolve the ontology project → Paperclip project goal linkage.
 * Only updates goal linkage on existing Paperclip projects.
 * Does NOT create Paperclip projects (projects are execution entities).
 */
function planProjectGoalSync(ontologyProjects, paperclipProjects, bridgeState) {
  const plan = [];
  const pcProjectByName = new Map(
    paperclipProjects.map(p => [p.name.toLowerCase(), p])
  );

  for (const oProject of ontologyProjects) {
    const mappedId = bridgeState.projectMap[oProject.id];
    const pcProject = mappedId
      ? paperclipProjects.find(p => p.id === mappedId)
      : null;

    // Try name-based match if no mapping
    const nameMatch = !pcProject
      ? pcProjectByName.get(oProject.name.toLowerCase())
      : null;

    const targetProject = pcProject || nameMatch;

    if (!targetProject) {
      plan.push({
        action: 'skip',
        ontologyId: oProject.id,
        reason: `No matching Paperclip project found for "${oProject.name}". Projects are created in Paperclip, not synced from ontology.`,
      });
      continue;
    }

    // Resolve which goal(s) this project should link to
    const servedGoalIds = [];
    for (const link of (oProject.links || [])) {
      if (link.type === 'serves' && link.targetId && bridgeState.goalMap[link.targetId]) {
        servedGoalIds.push(bridgeState.goalMap[link.targetId]);
      }
    }

    // Check if goal linkage needs updating
    const currentGoalIds = targetProject.goalIds || (targetProject.goalId ? [targetProject.goalId] : []);
    const needsGoalUpdate =
      servedGoalIds.length > 0 &&
      JSON.stringify([...servedGoalIds].sort()) !== JSON.stringify([...currentGoalIds].sort());

    if (needsGoalUpdate) {
      plan.push({
        action: 'update-goals',
        ontologyId: oProject.id,
        paperclipId: targetProject.id,
        goalIds: servedGoalIds,
        reason: `Updating project goal linkage from ontology serves-links`,
        adoptMapping: !mappedId,
      });
    } else {
      plan.push({
        action: 'skip',
        ontologyId: oProject.id,
        paperclipId: targetProject.id,
        reason: mappedId ? 'Goal linkage in sync' : `No goal linkage change needed`,
        adoptMapping: !mappedId && !!targetProject,
      });
    }
  }

  return plan;
}

/**
 * Execute the full ontology → Paperclip sync.
 *
 * @param {object} config
 * @param {string} config.ontologyDir - Path to ontology/ directory
 * @param {string} config.stateDir - Path to dir containing bridge-state.json
 * @param {string} config.paperclipUrl - Paperclip API base URL
 * @param {string} config.paperclipApiKey - API key
 * @param {string} config.companyId - Paperclip company ID
 * @param {string} [config.companyGoalId] - Paperclip company-level goal ID (parent for new team goals)
 * @param {boolean} [config.dryRun=false] - If true, plan but don't execute
 * @returns {object} Sync result with actions taken
 */
export async function syncOntologyToPaperclip(config) {
  const {
    ontologyDir,
    stateDir,
    paperclipUrl,
    paperclipApiKey,
    companyId,
    companyGoalId,
    dryRun = false,
  } = config;

  const ontology = loadOntology(ontologyDir);
  const ontologyGoals = getGoals(ontology);
  const ontologyProjects = getProjects(ontology);
  const state = loadBridgeState(stateDir);

  // Fetch current Paperclip state
  const pcGoals = await listGoals(paperclipUrl, paperclipApiKey, companyId);
  const pcProjects = await listProjects(paperclipUrl, paperclipApiKey, companyId);

  // Plan goal sync
  const goalPlan = planGoalSync(ontologyGoals, pcGoals, state);

  // Execute goal sync
  const goalResults = [];
  for (const step of goalPlan) {
    if (dryRun) {
      goalResults.push({ ...step, executed: false });
      continue;
    }

    try {
      switch (step.action) {
        case 'create': {
          const created = await createGoal(paperclipUrl, paperclipApiKey, companyId, {
            ...step.data,
            parentId: companyGoalId || undefined,
          });
          state.goalMap[step.ontologyId] = created.id;
          goalResults.push({ ...step, executed: true, paperclipId: created.id });
          break;
        }
        case 'update': {
          await updateGoal(paperclipUrl, paperclipApiKey, step.paperclipId, step.updates);
          goalResults.push({ ...step, executed: true });
          break;
        }
        case 'adopt': {
          state.goalMap[step.ontologyId] = step.paperclipId;
          if (step.updates) {
            await updateGoal(paperclipUrl, paperclipApiKey, step.paperclipId, step.updates);
          }
          goalResults.push({ ...step, executed: true });
          break;
        }
        case 'error': {
          goalResults.push({ ...step, executed: false });
          break;
        }
        default: {
          goalResults.push({ ...step, executed: false });
        }
      }
    } catch (err) {
      goalResults.push({
        ...step,
        executed: false,
        error: err.message,
      });
    }
  }

  // Plan and execute project goal linkage sync
  const projectPlan = planProjectGoalSync(ontologyProjects, pcProjects, state);
  const projectResults = [];

  for (const step of projectPlan) {
    if (dryRun) {
      projectResults.push({ ...step, executed: false });
      continue;
    }

    try {
      switch (step.action) {
        case 'update-goals': {
          await updateProject(paperclipUrl, paperclipApiKey, step.paperclipId, {
            goalIds: step.goalIds,
          });
          if (step.adoptMapping) {
            state.projectMap[step.ontologyId] = step.paperclipId;
          }
          projectResults.push({ ...step, executed: true });
          break;
        }
        case 'skip': {
          if (step.adoptMapping && step.paperclipId) {
            state.projectMap[step.ontologyId] = step.paperclipId;
          }
          projectResults.push({ ...step, executed: false });
          break;
        }
        default: {
          projectResults.push({ ...step, executed: false });
        }
      }
    } catch (err) {
      projectResults.push({
        ...step,
        executed: false,
        error: err.message,
      });
    }
  }

  // Update sync timestamp and log
  const syncEvent = {
    at: new Date().toISOString(),
    dryRun,
    goalsPlanned: goalPlan.length,
    goalsExecuted: goalResults.filter(r => r.executed).length,
    projectsPlanned: projectPlan.length,
    projectsExecuted: projectResults.filter(r => r.executed).length,
    errors: [
      ...goalResults.filter(r => r.error || r.action === 'error'),
      ...projectResults.filter(r => r.error),
    ].map(r => ({ ontologyId: r.ontologyId, error: r.error || r.reason })),
  };

  if (!dryRun) {
    state.lastSyncAt = syncEvent.at;
    state.syncLog = [...(state.syncLog || []), syncEvent];
    saveBridgeState(stateDir, state);
  }

  return {
    dryRun,
    goals: goalResults,
    projects: projectResults,
    state: {
      goalMap: state.goalMap,
      projectMap: state.projectMap,
      lastSyncAt: state.lastSyncAt,
    },
    syncEvent,
  };
}

// ─── Exported for testing ──────────────────────────────────────────────────

export {
  mapGoalStatus,
  mapProjectStatus,
  planGoalSync,
  planProjectGoalSync,
  GOAL_STATUS_MAP,
  PROJECT_STATUS_MAP,
};
