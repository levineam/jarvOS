'use strict';

const crypto = require('crypto');

// This is intentionally an unstable 0.x contract. Producers must retain their
// detailed diagnostics privately and send this module only reviewed semantics.
const OPERATOR_NOTIFICATION_SCHEMA_VERSION = 'jarvos-operator-notification/v1';
const NO_REPLY = 'NO_REPLY';
const AUDIENCES = new Set(['operator']);
const SEVERITIES = new Set(['info', 'warning', 'error', 'security']);
const AUTOMATION_OUTCOMES = new Set(['none', 'safe-hold', 'repaired', 'resolved', 'failed']);
const FRESHNESS_STATES = new Set(['current', 'stale', 'unknown']);
const ACTIONS = new Set(['none', 'review-release', 'choose-recovery', 'follow-recovery', 'review-safety-hold', 'choose-skill-option', 'choose-skill-options', 'review-decisions']);
const NEXT_STATES = new Set(['none', 'continue-monitoring', 'wait-for-fresh-observation', 'resume-after-review', 'await-owner-decision']);
const EVENT_CODES = new Set([
  'release-state', 'safety-hold', 'recovery-failed', 'repair-complete', 'resolution-complete',
  'skill-owner-decision', 'skill-decision-summary', 'skill-owner-decision-batch',
]);
const EVENT_FIELDS = new Set([
  'schemaVersion', 'code', 'audience', 'severity', 'automationOutcome',
  'actionRequired', 'action', 'nextState', 'eventReference', 'dedupeKey',
  'observedAt', 'freshness', 'privateDetailReference', 'release',
  'skillName', 'reasonCode', 'options', 'decisionReference', 'revision',
  'optionSetVersion', 'deliveryAttemptId', 'deliveryAttemptKind', 'itemCount', 'resolvedCount',
  'affectedHarnesses', 'preservedState', 'decisions', 'chunkIndex', 'chunkCount', 'failureCause',
]);

const SKILL_REASON_CODES = new Set([
  'needs_owner_input', 'semantic_collision', 'ambiguous_identity',
  'capability_unsupported', 'source_absent',
  'privacy_restricted', 'trust_class_insufficient', 'unsafe_source',
]);
const SKILL_OPTIONS = new Set(['share', 'keep-local', 'exclude', 'details']);
const SKILL_DECISION_FIELDS = ['skillName', 'reasonCode', 'options', 'decisionReference', 'revision', 'optionSetVersion', 'deliveryAttemptId', 'deliveryAttemptKind', 'affectedHarnesses', 'preservedState'];
const SKILL_SUMMARY_FIELDS = ['itemCount', 'resolvedCount'];
// One message names at most this many decisions. With stored skill ids of at
// most 64 characters, a full batch stays within a single chat message.
const SKILL_DECISION_BATCH_LIMIT = 4;
// The bound above limits one message, never one occurrence: every unresolved
// decision is named in the same occurrence, split across as many bounded
// messages as that takes. There is deliberately no aggregate ceiling on the
// chunk count, because any such ceiling would refuse a pending population the
// inventory can represent and leave those decisions unnamed. What is checked
// here is that the pair is a well-formed position: a positive safe integer
// count and an index inside it. Whether the positions of one occurrence form a
// complete 1..count sequence is a property of the set, not of one message, so
// the transport layer that assembles the occurrence checks it.
const SKILL_BATCH_FIELDS = ['decisions', 'chunkIndex', 'chunkCount'];
const SKILL_BATCH_ITEM_FIELDS = new Set(['skillName', 'reasonCode', 'options', 'decisionReference', 'revision', 'affectedHarnesses', 'preservedState']);
// The skill fields each skill event may carry; any other skill field is
// reported against the event kind it belongs to.
const SKILL_EVENT_FIELDS = {
  'skill-owner-decision': new Set(SKILL_DECISION_FIELDS),
  'skill-decision-summary': new Set(SKILL_SUMMARY_FIELDS),
  'skill-owner-decision-batch': new Set([...SKILL_BATCH_FIELDS, 'optionSetVersion']),
};
const SKILL_FIELD_OWNERS = [
  [SKILL_DECISION_FIELDS, 'individual skill decisions'],
  [SKILL_SUMMARY_FIELDS, 'skill decision summaries'],
  [SKILL_BATCH_FIELDS, 'skill decision batches'],
];

const ACTION_TEXT = {
  'review-release': 'Review the proposed release before it can publish.',
  'choose-recovery': 'Choose how jarvOS should proceed.',
  'follow-recovery': 'Follow the recovery step above; jarvOS cannot clear this by itself.',
  'review-safety-hold': 'Review the held change and choose whether to continue.',
  'choose-skill-option': 'Choose one of the listed options for this skill.',
  'choose-skill-options': 'Choose one listed option for each skill, naming the skill in your reply.',
  'review-decisions': 'Review the pending skill decisions in jarvOS shared skills.',
};
const NEXT_TEXT = {
  'continue-monitoring': 'jarvOS will continue monitoring safely.',
  'wait-for-fresh-observation': 'jarvOS will keep monitoring for a fresh observation.',
  'resume-after-review': 'after your review, jarvOS will continue the release process.',
  'await-owner-decision': 'jarvOS will leave the skill unchanged until you choose an option.',
};

const SKILL_REASON_TEXT = {
  needs_owner_input: 'it needs your approval before jarvOS can share it',
  semantic_collision: 'its name conflicts with another skill',
  ambiguous_identity: 'jarvOS found more than one possible source for it',
  capability_unsupported: 'its capabilities do not match every target harness',
  source_absent: 'its source is no longer available',
  privacy_restricted: 'it appears to contain private information, such as a credential',
  trust_class_insufficient: 'it includes scripts, but its folder is trusted only for instructions',
  unsafe_source: 'jarvOS could not confirm that its files are safe to share',
};

const SKILL_OPTION_TEXT = {
  share: 'Reply “share” to copy it to compatible AI tools',
  'keep-local': 'reply “keep local” to leave it where it is',
  exclude: 'reply “exclude” to stop offering it',
  details: 'reply “details” to review more information without changing anything',
};

const HARNESS_TEXT = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes', openclaw: 'OpenClaw' };

const PRESERVED_STATE_TEXT = {
  unchanged: 'Nothing changed: the skill and every AI tool were left exactly as they were.',
  'shared-copies-kept': 'Nothing was removed: the copies it already shared stay in place.',
};

const SKILL_RECOVERY_TEXT = {
  needs_owner_input: 'decide whether this skill may be shared',
  semantic_collision: 'rename one of the conflicting skills, or keep this one local',
  ambiguous_identity: 'keep a single copy of the skill, or keep it local',
  capability_unsupported: 'update the skill so every tool supports it, or keep it local',
  source_absent: 'restore the skill folder, or tell jarvOS to stop offering it',
  privacy_restricted: 'remove the private information from the skill, or keep it local',
  trust_class_insufficient: 'remove its scripts, or move it to a folder trusted for scripts; otherwise keep it local',
  unsafe_source: 'review the skill’s files and remove anything unsafe, or keep it local',
};

// A reviewed recovery for each known scheduled-repair failure: the subsystem,
// the plain cause, what was preserved, and the exact recovery. Only these
// allowlisted causes may be named; paths, errors, and diagnostics never are.
//
// A reminder failure happens after the shared skill sync of the same run, so
// compatible skills may already have been updated. These texts therefore claim
// only what the failure itself proves: the decision and reminder ledger was
// left as it was, and the sync result that already completed still stands.
// Only the sync lock gate, which fails before any skill work begins, may still
// say that nothing at all changed.
const PRESERVED_DECISION_LEDGER_TEXT = 'Your skill decisions and reminders were left exactly as they were. Any shared skill sync that already finished in this run still stands; jarvOS did not undo it.';
const FAILURE_CAUSE_TEXT = {
  'decision-lock-gate': `jarvOS could not record skill decision reminders because an interrupted jarvOS process left the decision ledger lock gate behind. ${PRESERVED_DECISION_LEDGER_TEXT} To recover, confirm no jarvOS process is running, then remove the leftover folder named “owner-decisions.json.lock.gate” beside the jarvOS skill decisions file; the next hourly run retries automatically.`,
  'skill-sync-lock-gate': 'jarvOS could not run shared skill sync because an interrupted jarvOS process left the shared skill lock gate behind. It stopped before doing any skill work, so no skill, AI tool, or decision was changed. To recover, confirm no jarvOS process is running, then remove the leftover folder named “.shared-skill-cli.lock.gate” in the jarvOS skills control folder; the next hourly run retries automatically.',
  'decision-ledger-busy': `jarvOS could not record skill decision reminders because another jarvOS process held the decision ledger for too long. ${PRESERVED_DECISION_LEDGER_TEXT} To recover, let any running jarvOS skill command finish, or stop one that is stuck; the next hourly run retries automatically.`,
  'decision-ledger-unreadable': `jarvOS could not use the skill decisions file because it is unreadable, malformed, or not private to you. It did not overwrite that file. ${PRESERVED_DECISION_LEDGER_TEXT} To recover, make the jarvOS skill decisions file a regular file readable only by you with valid contents, restoring it from a backup if needed; the next hourly run retries automatically.`,
  'reminder-occurrence-rejected': `jarvOS could not record skill decision reminders because the scheduler occurrence it was given is invalid, in the future, or a custom name past its limit. ${PRESERVED_DECISION_LEDGER_TEXT} To recover, let jarvOS use its default hourly occurrence, or pass --occurrence as a name followed by the current UTC hour, such as “hour-2026-08-16T16”.`,
  'decision-claim-failed': `jarvOS could not record skill decision reminders. ${PRESERVED_DECISION_LEDGER_TEXT} To recover, run “jarvos-skills doctor-shared” and review the local status; the next hourly run retries automatically.`,
};

const SKILL_REMINDER_TEXT = 'jarvOS will remind you every hour until you choose; ignoring this message does not pause reminders. Reply “acknowledge” to pause them, “defer until” with a date and time to pause them until then, or “resume” to restart them.';

// In a batch every reply names its skill, so each choice belongs to exactly
// one skill and a bare option word matches none of them.
const SKILL_REPLY_TEXT = { share: 'share', 'keep-local': 'keep local', exclude: 'exclude', details: 'details' };
const SKILL_REPLY_MEANING = {
  share: '“share” copies the skill to compatible AI tools',
  'keep-local': '“keep local” leaves it where it is',
  exclude: '“exclude” stops offering it',
  details: '“details” shows more information without changing anything',
};
const SKILL_BATCH_REMINDER_TEXT = 'jarvOS will remind you every hour until each skill is decided; ignoring this message does not pause reminders. To pause reminders for one skill, reply “acknowledge” with its name, or “defer” with its name and “until” a date and time; reply “resume” with its name to restart them.';
const SKILL_BATCH_NEXT_TEXT = 'jarvOS will leave each skill unchanged until you choose one of its options.';

// Every unresolved decision belongs to the same scheduler occurrence, but no
// single message may grow without bound. Split one occurrence's decisions into
// the fewest bounded chunks and balance them, so each chunk still names two to
// SKILL_DECISION_BATCH_LIMIT decisions and no tail chunk is left holding one.
// The split is a pure function of the ordered list, so the same occurrence
// always produces the same chunk boundaries.
function chunkSkillDecisions(items, limit = SKILL_DECISION_BATCH_LIMIT) {
  const list = Array.isArray(items) ? items : [];
  const bound = Number.isInteger(limit) && limit > 0 ? limit : SKILL_DECISION_BATCH_LIMIT;
  if (list.length === 0) return [];
  const count = Math.ceil(list.length / bound);
  const base = Math.floor(list.length / count);
  const extra = list.length % count;
  const chunks = [];
  let index = 0;
  for (let chunk = 0; chunk < count; chunk += 1) {
    const size = base + (chunk < extra ? 1 : 0);
    chunks.push(list.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function listText(items, conjunction = 'and') {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items.at(-1)}`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticVersion(value) {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isBoundedIdentifier(value, { min = 1, max = 120 } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && /^[a-z][a-z0-9-]*$/.test(value);
}

function isOpaqueReference(value) {
  // A base64url token of this length has enough entropy to be non-guessable
  // when minted by the owner-authorized context. Its contents are never shown
  // other than as the correlation reference for an action-required message.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
}

function isIsoTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateRelease(release, errors) {
  if (!isObject(release)) {
    errors.push('release must be an object');
    return;
  }
  const allowed = new Set(['publishedVersion', 'approvalReadyVersion', 'futureVersion']);
  for (const key of Object.keys(release)) if (!allowed.has(key)) errors.push(`release has unknown field: ${key}`);
  for (const field of ['publishedVersion', 'approvalReadyVersion', 'futureVersion']) {
    if (!isSemanticVersion(release[field])) errors.push(`release.${field} must be a semantic version`);
  }
}

// The redacted facts of one decision, whether it is sent alone or in a batch.
function validateDecisionFacts(facts, errors, label, { maxNameLength = 80 } = {}) {
  if (!isBoundedIdentifier(facts.skillName, { max: maxNameLength })) errors.push(`${label}.skillName is invalid`);
  if (!SKILL_REASON_CODES.has(facts.reasonCode)) errors.push(`${label}.reasonCode is invalid`);
  if (!isOpaqueReference(facts.decisionReference)) errors.push(`${label}.decisionReference is invalid`);
  if (!Number.isInteger(facts.revision) || facts.revision < 1 || facts.revision > 1000000) errors.push(`${label}.revision is invalid`);
  if (facts.affectedHarnesses !== undefined && (!Array.isArray(facts.affectedHarnesses)
    || facts.affectedHarnesses.length > Object.keys(HARNESS_TEXT).length
    || facts.affectedHarnesses.some((harness) => typeof harness !== 'string' || !Object.hasOwn(HARNESS_TEXT, harness))
    || new Set(facts.affectedHarnesses).size !== facts.affectedHarnesses.length)) {
    errors.push(`${label}.affectedHarnesses is invalid`);
  }
  if (facts.preservedState !== undefined && (typeof facts.preservedState !== 'string' || !Object.hasOwn(PRESERVED_STATE_TEXT, facts.preservedState))) {
    errors.push(`${label}.preservedState is invalid`);
  }
  if (!Array.isArray(facts.options) || facts.options.length < 1 || facts.options.length > 4) {
    errors.push(`${label}.options must contain one to four choices`);
  } else {
    const choices = facts.options;
    if (choices.some((option) => typeof option !== 'string')
      || new Set(choices).size !== choices.length
      || choices.some((option) => !SKILL_OPTIONS.has(option))) {
      errors.push(`${label}.options contains an unsupported or duplicate choice`);
    }
  }
}

function validateSkillDecision(event, errors) {
  validateDecisionFacts(event, errors, 'skill-owner-decision');
  if (event.eventReference !== event.decisionReference) errors.push('skill-owner-decision.eventReference must match decisionReference');
  if (typeof event.optionSetVersion !== 'string' || !/^v[0-9]+$/.test(event.optionSetVersion)) errors.push('skill-owner-decision.optionSetVersion is invalid');
  if (event.deliveryAttemptId !== undefined && !isOpaqueReference(event.deliveryAttemptId)) errors.push('skill-owner-decision.deliveryAttemptId is invalid');
  if (event.deliveryAttemptKind !== undefined && !['initial', 'fallback'].includes(event.deliveryAttemptKind)) errors.push('skill-owner-decision.deliveryAttemptKind is invalid');
  if ((event.deliveryAttemptId === undefined) !== (event.deliveryAttemptKind === undefined)) errors.push('skill-owner-decision delivery attempt fields must be provided together');
  if (event.action !== 'choose-skill-option' || event.nextState !== 'await-owner-decision' || event.actionRequired !== true) {
    errors.push('skill-owner-decision must require a skill option and await the owner decision');
  }
}

// A batch names each decision once with its own facts. It carries no delivery
// attempt, and its message reference is never a decision reference, so a
// reply correlated only to the message cannot resolve any decision. When one
// occurrence needs more than one bounded message, each message declares its
// own position, so a sender can ledger and correlate every chunk separately.
function validateSkillDecisionBatch(event, errors) {
  const label = 'skill-owner-decision-batch';
  if (typeof event.optionSetVersion !== 'string' || !/^v[0-9]+$/.test(event.optionSetVersion)) errors.push(`${label}.optionSetVersion is invalid`);
  if ((event.chunkIndex === undefined) !== (event.chunkCount === undefined)) {
    errors.push(`${label} chunk fields must be provided together`);
  } else if (event.chunkCount !== undefined) {
    if (!Number.isSafeInteger(event.chunkCount) || event.chunkCount < 1) errors.push(`${label}.chunkCount is invalid`);
    if (!Number.isSafeInteger(event.chunkIndex) || event.chunkIndex < 1 || event.chunkIndex > event.chunkCount) errors.push(`${label}.chunkIndex is invalid`);
  }
  const items = event.decisions;
  if (!Array.isArray(items) || items.length < 2 || items.length > SKILL_DECISION_BATCH_LIMIT) {
    errors.push(`${label}.decisions must contain two to ${SKILL_DECISION_BATCH_LIMIT} decisions`);
  } else {
    items.forEach((item, index) => {
      const itemLabel = `${label}.decisions[${index}]`;
      if (!isObject(item)) {
        errors.push(`${itemLabel} must be an object`);
        return;
      }
      for (const key of Object.keys(item)) if (!SKILL_BATCH_ITEM_FIELDS.has(key)) errors.push(`${itemLabel} has unknown field: ${key}`);
      validateDecisionFacts(item, errors, itemLabel, { maxNameLength: 64 });
      if (item.decisionReference === event.eventReference) errors.push(`${itemLabel}.decisionReference must differ from eventReference`);
    });
    const names = items.map((item) => item?.skillName);
    const references = items.map((item) => item?.decisionReference);
    if (new Set(names).size !== names.length) errors.push(`${label}.decisions must name each skill once`);
    if (new Set(references).size !== references.length) errors.push(`${label}.decisions must use distinct decision references`);
  }
  if (event.action !== 'choose-skill-options' || event.nextState !== 'await-owner-decision' || event.actionRequired !== true) {
    errors.push(`${label} must require a choice for each skill and await the owner decisions`);
  }
}

function validateSkillDecisionSummary(event, errors) {
  if (!Number.isInteger(event.itemCount) || event.itemCount < 1 || event.itemCount > 10000) errors.push('skill-decision-summary.itemCount is invalid');
  if (event.resolvedCount !== undefined && (!Number.isInteger(event.resolvedCount) || event.resolvedCount < 0 || event.resolvedCount > 10000)) {
    errors.push('skill-decision-summary.resolvedCount is invalid');
  }
  if (event.action !== 'review-decisions' || event.nextState !== 'await-owner-decision' || event.actionRequired !== true) {
    errors.push('skill-decision-summary must require decision review and await the owner');
  }
}

function validateOperatorNotificationEvent(event) {
  const errors = [];
  if (!isObject(event)) return { ok: false, errors: ['operator notification event must be an object'] };
  for (const key of Object.keys(event)) if (!EVENT_FIELDS.has(key)) errors.push(`operator notification event has unknown field: ${key}`);
  if (event.schemaVersion !== OPERATOR_NOTIFICATION_SCHEMA_VERSION) errors.push(`event.schemaVersion must be ${OPERATOR_NOTIFICATION_SCHEMA_VERSION}`);
  if (!isBoundedIdentifier(event.code)) errors.push('event.code must be a bounded stable identifier');
  if (isBoundedIdentifier(event.code) && !EVENT_CODES.has(event.code)) errors.push('event.code is not a supported operator notification code');
  if (!AUDIENCES.has(event.audience)) errors.push('event.audience must be operator');
  if (!SEVERITIES.has(event.severity)) errors.push('event.severity is invalid');
  if (!AUTOMATION_OUTCOMES.has(event.automationOutcome)) errors.push('event.automationOutcome is invalid');
  if (typeof event.actionRequired !== 'boolean') errors.push('event.actionRequired must be boolean');
  if (!ACTIONS.has(event.action)) errors.push('event.action is invalid');
  if (!NEXT_STATES.has(event.nextState)) errors.push('event.nextState is invalid');
  if (event.actionRequired && event.action === 'none') errors.push('action-required events need a reviewed action');
  if (!event.actionRequired && event.action !== 'none') errors.push('non-action events must use action none');
  if (!isOpaqueReference(event.eventReference)) errors.push('event.eventReference must be an opaque reference');
  if (!isBoundedIdentifier(event.dedupeKey, { max: 180 })) errors.push('event.dedupeKey must be a bounded stable identifier');
  if (!isIsoTime(event.observedAt)) errors.push('event.observedAt must be an ISO-8601 UTC timestamp');
  if (!FRESHNESS_STATES.has(event.freshness)) errors.push('event.freshness is invalid');
  if (event.privateDetailReference !== undefined && !isOpaqueReference(event.privateDetailReference)) errors.push('event.privateDetailReference must be an opaque reference');
  if (event.code === 'release-state') validateRelease(event.release, errors);
  if (event.code !== 'release-state' && event.release !== undefined) errors.push('release is only valid for release-state events');
  if (event.code === 'release-state' && event.freshness !== 'current' && event.actionRequired) errors.push('stale or unknown release evidence cannot request release review');
  if (event.code === 'skill-owner-decision') validateSkillDecision(event, errors);
  if (event.code === 'skill-decision-summary') validateSkillDecisionSummary(event, errors);
  if (event.code === 'skill-owner-decision-batch') validateSkillDecisionBatch(event, errors);
  if (event.failureCause !== undefined) {
    if (event.code !== 'recovery-failed') errors.push('failureCause is only valid for recovery-failed events');
    else if (typeof event.failureCause !== 'string' || !Object.hasOwn(FAILURE_CAUSE_TEXT, event.failureCause)) errors.push('event.failureCause is invalid');
    else if (event.action !== 'follow-recovery' || event.actionRequired !== true) errors.push('a named failure cause must require its recovery');
  } else if (event.action === 'follow-recovery') {
    errors.push('follow-recovery requires a named failure cause');
  }
  const scope = Object.hasOwn(SKILL_EVENT_FIELDS, event.code) ? SKILL_EVENT_FIELDS[event.code] : null;
  for (const [fields, owner] of SKILL_FIELD_OWNERS) {
    for (const field of fields) {
      if (event[field] !== undefined && !scope?.has(field)) errors.push(`${field} is only valid for ${scope ? owner : 'skill decision events'}`);
    }
  }
  return { ok: errors.length === 0, errors, value: event };
}

function assertOperatorNotificationEvent(event) {
  const validation = validateOperatorNotificationEvent(event);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  return event;
}

function notificationDedupeIdentity(event) {
  assertOperatorNotificationEvent(event);
  return crypto.createHash('sha256')
    .update(`${event.schemaVersion}\0${event.code}\0${event.dedupeKey}\0${event.actionRequired}\0${event.freshness}`)
    .digest('hex');
}

function releaseMessage(event) {
  const { publishedVersion, approvalReadyVersion, futureVersion } = event.release;
  if (event.freshness === 'current') {
    return `jarvOS ${publishedVersion} is currently published. A proposed ${approvalReadyVersion} release has passed checks and is ready for Andrew's review; nothing will publish automatically. The separate ${futureVersion} milestone remains future work.`;
  }
  const qualifier = event.freshness === 'stale' ? 'stale' : 'unconfirmed';
  return `jarvOS last observed ${publishedVersion} as published, but that observation is ${qualifier}. The proposed ${approvalReadyVersion} release needs a fresh check before it can be reviewed. The separate ${futureVersion} milestone remains future work.`;
}

function skillDecisionMessage(event) {
  const reason = SKILL_REASON_TEXT[event.reasonCode];
  const tools = event.affectedHarnesses?.length > 0
    ? ` with ${listText(event.affectedHarnesses.map((harness) => HARNESS_TEXT[harness]))}`
    : '';
  const preserved = PRESERVED_STATE_TEXT[event.preservedState || 'unchanged'];
  return `jarvOS found the ${event.skillName} skill but did not share it${tools} because ${reason}. ${preserved} To fix it, ${SKILL_RECOVERY_TEXT[event.reasonCode]}.`;
}

function skillDecisionSummaryMessage(event) {
  const count = `${event.itemCount} skill${event.itemCount === 1 ? '' : 's'}`;
  const resolved = event.resolvedCount > 0
    ? ` It also confirmed that ${event.resolvedCount} earlier item${event.resolvedCount === 1 ? '' : 's'} ${event.resolvedCount === 1 ? 'is' : 'are'} resolved.`
    : '';
  // A summary never names skills; it says where the named details live.
  return `jarvOS found ${count} that still need your decision. It left them unchanged.${resolved} Review the pending decisions in jarvOS shared skills; nothing will be shared automatically until you choose. To see each skill by name, the AI tools it affects, and its exact choices, ask jarvOS to list your pending skill decisions. jarvOS will remind you every hour until each one is decided; acknowledging or deferring a decision pauses its reminders.`;
}

function skillDecisionBatchMessage(event) {
  const items = event.decisions.map((item, index) => {
    const tools = item.affectedHarnesses?.length > 0
      ? ` with ${listText(item.affectedHarnesses.map((harness) => HARNESS_TEXT[harness]))}`
      : '';
    const preserved = PRESERVED_STATE_TEXT[item.preservedState || 'unchanged'];
    const replies = listText(item.options.map((option) => `“${SKILL_REPLY_TEXT[option]} ${item.skillName}”`), 'or');
    return `${index + 1}. ${item.skillName}: jarvOS did not share it${tools} because ${SKILL_REASON_TEXT[item.reasonCode]}. ${preserved} To fix it, ${SKILL_RECOVERY_TEXT[item.reasonCode]}. Reply ${replies}.`;
  });
  const offered = [...SKILL_OPTIONS].filter((option) => event.decisions.some((item) => item.options.includes(option)));
  const chunked = event.chunkCount > 1;
  const parts = [
    chunked
      ? `jarvOS has more skills waiting for your decision than fit in one message. This is message ${event.chunkIndex} of ${event.chunkCount}, and each of these ${event.decisions.length} skills needs its own decision.`
      : `jarvOS found ${event.decisions.length} skills it did not share, and each needs its own decision.`,
    ...items,
    `In these replies, ${listText(offered.map((option) => SKILL_REPLY_MEANING[option]))}.`,
    'Name the skill in every reply; a reply that does not name one of these skills changes nothing.',
  ];
  if (chunked) parts.push('The other messages in this reminder name the rest of your pending skill decisions.');
  return parts.join(' ');
}

function eventMessage(event) {
  if (event.code === 'release-state') return releaseMessage(event);
  if (event.code === 'skill-owner-decision') return skillDecisionMessage(event);
  if (event.code === 'skill-decision-summary') return skillDecisionSummaryMessage(event);
  if (event.code === 'skill-owner-decision-batch') return skillDecisionBatchMessage(event);
  if (event.code === 'safety-hold') return 'jarvOS paused an unsafe change and left the existing setup unchanged.';
  if (event.code === 'recovery-failed') {
    return event.failureCause ? FAILURE_CAUSE_TEXT[event.failureCause] : 'jarvOS could not complete a safe recovery and preserved the existing state.';
  }
  if (event.code === 'repair-complete') return 'jarvOS completed a safe repair.';
  if (event.code === 'resolution-complete') return 'jarvOS resolved the condition safely.';
  return null;
}

function renderMessage(event) {
  const parts = [eventMessage(event)];
  if (event.code === 'skill-owner-decision') {
    parts.push(`Choices: ${event.options.map((option) => SKILL_OPTION_TEXT[option]).join('; ')}.`);
    parts.push(SKILL_REMINDER_TEXT);
  }
  if (event.code === 'skill-owner-decision-batch') parts.push(SKILL_BATCH_REMINDER_TEXT);
  if (event.actionRequired) {
    const next = event.code === 'skill-owner-decision-batch' ? SKILL_BATCH_NEXT_TEXT : NEXT_TEXT[event.nextState];
    parts.push(`Action required: ${ACTION_TEXT[event.action]}`);
    parts.push(`Next: ${next || 'jarvOS will wait for your direction.'}`);
    parts.push(`Reference: ${event.eventReference}.`);
  } else {
    parts.push('No action is needed from you.');
    if (event.nextState !== 'none') parts.push(`Next: ${NEXT_TEXT[event.nextState]}`);
  }
  return parts.join(' ');
}

function evaluateOperatorNotification(event) {
  assertOperatorNotificationEvent(event);
  const direct = event.actionRequired;
  const message = renderMessage(event);
  if (direct) {
    return {
      disposition: 'direct-notification',
      output: message,
      statusMessage: null,
      dedupeIdentity: notificationDedupeIdentity(event),
    };
  }
  const durableStatus = event.automationOutcome === 'safe-hold'
    || (event.code === 'release-state' && event.freshness !== 'current');
  return {
    disposition: durableStatus ? 'durable-status' : 'quiet',
    output: NO_REPLY,
    statusMessage: durableStatus ? message : null,
    dedupeIdentity: notificationDedupeIdentity(event),
  };
}

function renderOperatorNotification(event) {
  return evaluateOperatorNotification(event).output;
}

module.exports = {
  ACTIONS,
  AUTOMATION_OUTCOMES,
  FRESHNESS_STATES,
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  SKILL_DECISION_BATCH_LIMIT,
  assertOperatorNotificationEvent,
  chunkSkillDecisions,
  evaluateOperatorNotification,
  notificationDedupeIdentity,
  renderOperatorNotification,
  validateOperatorNotificationEvent,
};
