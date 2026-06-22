'use strict';

const {
  IDEA,
  NOTE,
  detectTrigger,
  hasCaptureIntent,
  primaryText,
  stripLeadingKeyword,
} = require('../intent/keyword-capture-router');

const MEMORY = 'memory';
const WORK_INTAKE = 'work-intake';

const SALIENCE_TO_MEMORY_CLASS = {
  decision: 'decision',
  belief_change: 'fact',
  preference: 'preference',
  factual_learning: 'fact',
  lesson: 'lesson',
};

const MEMORY_CONFIDENCE_THRESHOLD = 0.8;
const HIGH_CONFIDENCE_THRESHOLD = MEMORY_CONFIDENCE_THRESHOLD;
const REVIEW_CONFIDENCE_MIN = 0.5;
const REVIEW_CONFIDENCE_MAX = MEMORY_CONFIDENCE_THRESHOLD;
const WORK_INTAKE_CONFIDENCE_THRESHOLD = 0.8;

const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const DECISIONS_HEADING = '## ✅ Decisions';
const REMEMBERED_HEADING = '## 🧠 Remembered';
const FLAGGED_HEADING = '## 📌 Flagged';

function inferTitle(capture = {}, fallbackPrefix = 'Captured Note', options = {}) {
  const explicit = String(capture.title || '').trim();
  if (explicit) return stripLeadingKeyword(explicit);

  const text = primaryText(capture)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';

  if (text) {
    // Concept-first: drop the capture trigger phrase, then take the first clause
    // (not the raw first 80 chars) so titles read like durable handles, not
    // chat fragments. The async Ollama upgrade happens in the grooming pass.
    const stripped = stripLeadingKeyword(text) || text;
    const clause = stripped.split(/(?<=[.!?])\s|;\s|—\s| - /)[0] || stripped;
    const title = clause.replace(/\s+/g, ' ').trim().replace(/[.,;:!?。]+$/, '');
    if (title.length > 80) return `${title.slice(0, 80).replace(/\s+\S*$/, '')}…`;
    return title || text.slice(0, 80).trim().replace(/[.。!?]+$/, '');
  }

  const now = typeof options.now === 'function' ? options.now() : new Date();
  return `${fallbackPrefix} ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
}

function ideaJournalLine(capture = {}, noteTitle = '') {
  const title = String(capture.title || '').trim();
  const summary = primaryText(capture);

  if (noteTitle) {
    const details = summary && summary !== noteTitle ? ` — ${summary}` : '';
    return `- [[${noteTitle}]]${details}`;
  }

  if (title && summary && title !== summary) {
    return `- ${title} — ${summary}`;
  }
  return `- ${summary || title || 'Untitled idea'}`;
}

function buildNoteContent(capture = {}, route = NOTE) {
  const text = primaryText(capture);
  if (text) return text;
  if (route === IDEA) return 'Captured from idea routing.';
  return 'Captured note.';
}

function isSubstantiveIdea(capture = {}) {
  if (typeof capture.substantive === 'boolean') return capture.substantive;

  const text = primaryText(capture);
  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (String(capture.title || '').trim()) return true;
  if (nonEmptyLines.length >= 2) return true;
  if (text.length >= 140) return true;
  if (/\b(?:because|connects?|relates?|depends on|similar to|linked to|searchable)\b/i.test(text)) return true;
  return false;
}

function buildKeywordRoutingPlan(capture = {}, options = {}) {
  const detectedTrigger = detectTrigger(capture);
  const captureIntent = hasCaptureIntent(capture);
  const date = String(capture.date || '').trim() || undefined;

  if (!captureIntent) {
    return {
      route: null,
      detectedTrigger,
      defaultedToNoteBias: false,
      ignored: true,
      date,
      journalSection: null,
      journalLine: null,
      createNote: false,
      noteTitle: '',
      noteContent: '',
      noteFrontmatter: null,
    };
  }

  const route = detectedTrigger || NOTE;

  if (route === IDEA) {
    const createNote = isSubstantiveIdea(capture);
    const noteTitle = createNote ? inferTitle(capture, 'Captured Idea', options) : '';
    return {
      route,
      detectedTrigger,
      defaultedToNoteBias: !detectedTrigger,
      ignored: false,
      date,
      journalSection: IDEAS_HEADING,
      journalLine: ideaJournalLine(capture, noteTitle),
      createNote,
      noteTitle,
      noteContent: createNote ? buildNoteContent(capture, IDEA) : '',
      noteFrontmatter: createNote ? {
        type: 'draft',
        source: 'idea-capture',
        trigger: IDEA,
        created_from: date ? `journal/${date}` : 'journal',
      } : null,
    };
  }

  const noteTitle = inferTitle(capture, 'Captured Note', options);
  return {
    route: NOTE,
    detectedTrigger,
    defaultedToNoteBias: !detectedTrigger,
    ignored: false,
    date,
    journalSection: NOTES_HEADING,
    journalLine: `- [[${noteTitle}]]`,
    createNote: true,
    noteTitle,
    noteContent: buildNoteContent(capture, NOTE),
    noteFrontmatter: {
      type: 'draft',
      source: detectedTrigger ? 'note-capture' : 'default-note-bias',
      trigger: detectedTrigger || NOTE,
      created_from: date ? `journal/${date}` : 'journal',
    },
  };
}

function shouldFlagForReview({ keywordPlan, capture, salienceClass, confidence }) {
  if (!keywordPlan.ignored) return false;
  if (typeof confidence !== 'number') return false;
  if (confidence < REVIEW_CONFIDENCE_MIN || confidence >= REVIEW_CONFIDENCE_MAX) return false;

  const text = primaryText(capture);
  if (text.length < 20) return false;

  const signals = Array.isArray(capture.signals) ? capture.signals : [];
  if (signals.some((signal) => ['casual', 'question_only', 'too_short'].includes(signal))) {
    return false;
  }

  return salienceClass === 'nothing' || Boolean(salienceClass);
}

function buildJournalAction(plan) {
  if (plan.ignored || !plan.journalSection || !plan.journalLine) return null;
  return {
    kind: 'journal',
    adapter: 'journal',
    operation: 'appendLineToJournalSection',
    input: {
      heading: plan.journalSection,
      line: plan.journalLine,
      date: plan.date,
    },
  };
}

function buildNoteAction(plan, capture = {}) {
  if (plan.ignored || !plan.createNote) return null;
  return {
    kind: 'note',
    adapter: 'notes',
    operation: 'writeNote',
    input: {
      title: plan.noteTitle,
      content: plan.noteContent,
      frontmatter: {
        ...(capture.frontmatter || {}),
        ...(plan.noteFrontmatter || {}),
      },
    },
  };
}

function buildMemoryAction(memoryParams) {
  if (!memoryParams) return null;
  return {
    kind: MEMORY,
    adapter: MEMORY,
    operation: 'writeMemoryRecord',
    input: memoryParams,
  };
}

function workIntakeTitle(capture = {}) {
  return inferTitle(capture, 'Tracked Work');
}

function buildWorkIntakePlan(capture = {}, { salienceClass, confidence } = {}) {
  const explicit = Boolean(capture.workIntake || capture.routeToWork || capture.createIssue);
  const commitment = salienceClass === 'commitment'
    && typeof confidence === 'number'
    && confidence >= WORK_INTAKE_CONFIDENCE_THRESHOLD;

  if (!explicit && !commitment) return null;

  const text = primaryText(capture);
  const title = String(capture.issueTitle || capture.workTitle || capture.title || workIntakeTitle(capture)).trim();
  return {
    kind: WORK_INTAKE,
    adapter: 'paperclip',
    operation: 'ensureTrackedWork',
    input: {
      title,
      description: String(capture.issueDescription || capture.workDescription || text || title).trim(),
      source: capture.date ? `journal/${capture.date}` : 'ambient-capture',
      priority: capture.priority || 'medium',
      status: capture.status || 'todo',
      salienceClass,
      confidence,
    },
  };
}

function buildSkillInvocation(skillId, action, input, reason) {
  return {
    skillId,
    contract: skillId,
    reason,
    input,
    actionPlan: Array.isArray(action) ? action : (action ? [action] : []),
  };
}

function buildSkillInvocations(plan) {
  if (plan.ignored) return [];

  const invocations = [];
  const actionsByKind = new Map(plan.actions.map((action) => [action.kind, action]));

  if (plan.route === IDEA && actionsByKind.has('journal')) {
    invocations.push(buildSkillInvocation(
      'journal-entry',
      actionsByKind.get('journal'),
      { text: primaryText(plan.capture), trigger: IDEA, date: plan.date },
      'Idea routing writes a journal entry without creating a durable note.',
    ));
  }

  if (plan.route === NOTE && actionsByKind.has('note')) {
    invocations.push(buildSkillInvocation(
      'note-creation',
      [actionsByKind.get('note'), actionsByKind.get('journal')].filter(Boolean),
      {
        text: primaryText(plan.capture),
        title: plan.noteTitle,
        trigger: plan.detectedTrigger || NOTE,
        salienceClass: plan.salienceClass || undefined,
        confidence: plan.confidence ?? undefined,
        date: plan.date,
        frontmatter: plan.noteFrontmatter || undefined,
      },
      'Note routing creates a durable note and links it from the journal.',
    ));
  }

  if (plan.route === 'flagged' && actionsByKind.has('journal')) {
    invocations.push(buildSkillInvocation(
      'idea-parking',
      actionsByKind.get('journal'),
      {
        text: primaryText(plan.capture),
        salienceClass: plan.salienceClass || undefined,
        confidence: plan.confidence ?? undefined,
        date: plan.date,
      },
      'Medium-confidence capture candidates are parked for review.',
    ));
  }

  if (actionsByKind.has(MEMORY)) {
    invocations.push(buildSkillInvocation(
      'memory-promotion',
      actionsByKind.get(MEMORY),
      plan.memoryParams,
      'High-confidence durable salience is eligible for memory promotion.',
    ));
  }

  if (actionsByKind.has(WORK_INTAKE)) {
    invocations.push(buildSkillInvocation(
      'work-intake',
      actionsByKind.get(WORK_INTAKE),
      plan.workIntake.input,
      'Commitment or explicit work intake should be tracked through the configured work system.',
    ));
  }

  return invocations;
}

function buildThreePackagePlan(capture = {}, options = {}) {
  const keywordPlan = buildKeywordRoutingPlan(capture, options);

  const salienceClass = capture.salienceClass || null;
  const confidence = typeof capture.confidence === 'number' ? capture.confidence : null;
  const memoryClass = salienceClass ? SALIENCE_TO_MEMORY_CLASS[salienceClass] : null;

  const salienceOverridesIgnored = Boolean(
    salienceClass
    && salienceClass !== 'nothing'
    && confidence !== null
    && confidence >= HIGH_CONFIDENCE_THRESHOLD,
  );

  if (keywordPlan.ignored && salienceOverridesIgnored) {
    const text = primaryText(capture);
    const title = String(capture.title || text.split(/\r?\n/)[0] || '').slice(0, 80).trim();
    keywordPlan.ignored = false;
    keywordPlan.defaultedToNoteBias = true;

    if (salienceClass === IDEA) {
      keywordPlan.route = IDEA;
      keywordPlan.journalSection = IDEAS_HEADING;
      keywordPlan.journalLine = title && text && title !== text ? `- ${title} — ${text}` : `- ${text || title}`;
      keywordPlan.createNote = false;
      keywordPlan.noteTitle = '';
      keywordPlan.noteContent = '';
      keywordPlan.noteFrontmatter = null;
    } else {
      keywordPlan.route = NOTE;
      keywordPlan.journalSection = salienceClass === 'decision' ? DECISIONS_HEADING : NOTES_HEADING;
      keywordPlan.journalLine = title ? `- [[${title}]]` : `- ${text.slice(0, 120)}`;
      keywordPlan.createNote = true;
      keywordPlan.noteTitle = title || inferTitle(capture, `Captured ${salienceClass}`, options);
      keywordPlan.noteContent = text;
      keywordPlan.noteFrontmatter = {
        type: 'draft',
        source: 'salience-capture',
        salience_class: salienceClass,
        confidence,
        created_from: capture.date ? `journal/${capture.date}` : 'journal',
      };
    }
  } else if (shouldFlagForReview({ keywordPlan, capture, salienceClass, confidence })) {
    const text = primaryText(capture);
    keywordPlan.ignored = false;
    keywordPlan.route = 'flagged';
    keywordPlan.defaultedToNoteBias = false;
    keywordPlan.flaggedForReview = true;
    keywordPlan.journalSection = FLAGGED_HEADING;
    keywordPlan.journalLine = `- ${text}`;
    keywordPlan.createNote = false;
    keywordPlan.noteTitle = '';
    keywordPlan.noteContent = '';
    keywordPlan.noteFrontmatter = null;
  }

  if (keywordPlan.ignored && (capture.workIntake || capture.routeToWork || capture.createIssue)) {
    keywordPlan.ignored = false;
    keywordPlan.route = WORK_INTAKE;
    keywordPlan.defaultedToNoteBias = false;
    keywordPlan.journalSection = null;
    keywordPlan.journalLine = null;
    keywordPlan.createNote = false;
    keywordPlan.noteTitle = '';
    keywordPlan.noteContent = '';
    keywordPlan.noteFrontmatter = null;
  }

  const shouldRouteToMemory = Boolean(
    memoryClass
    && confidence !== null
    && confidence >= MEMORY_CONFIDENCE_THRESHOLD
    && !keywordPlan.ignored,
  );

  const memoryParams = shouldRouteToMemory ? {
    class: memoryClass,
    content: capture.title || primaryText(capture).slice(0, 200),
    rationale: capture.rationale || undefined,
    source: capture.date ? `journal/${capture.date}` : 'journal',
    confidence,
  } : null;

  const plan = {
    version: 'ambient-routing-plan/v1',
    ...keywordPlan,
    capture: { ...capture },
    routeToMemory: shouldRouteToMemory,
    memoryClass,
    memoryParams,
    memoryDedup: null,
    salienceClass,
    confidence,
    cram: {
      pipeline: ['capture', 'journal', 'note', 'memory', 'work-intake'],
      principle: 'Capture first, then promote through explicit adapter-backed actions.',
    },
    workIntake: null,
    actions: [],
    skillInvocations: [],
  };

  const actions = [
    buildJournalAction(plan),
    buildNoteAction(plan, capture),
    buildMemoryAction(memoryParams),
  ].filter(Boolean);

  const workIntake = buildWorkIntakePlan(capture, { salienceClass, confidence });
  if (workIntake && !plan.ignored) {
    plan.workIntake = workIntake;
    actions.push(workIntake);
  }

  plan.actions = actions;
  plan.skillInvocations = buildSkillInvocations(plan);

  return plan;
}

function previewRouting(capture = {}, options = {}) {
  const plan = buildThreePackagePlan(capture, options);
  return {
    wouldCapture: !plan.ignored,
    journal: !plan.ignored && Boolean(plan.actions.some((action) => action.kind === 'journal')),
    notes: plan.createNote,
    memory: plan.routeToMemory,
    workIntake: Boolean(plan.workIntake),
    salienceClass: plan.salienceClass,
    memoryClass: plan.memoryClass,
    confidence: plan.confidence,
    trigger: plan.detectedTrigger,
    dedup: plan.memoryDedup,
    skillInvocations: plan.skillInvocations.map((invocation) => invocation.skillId),
  };
}

module.exports = {
  IDEA,
  NOTE,
  MEMORY,
  WORK_INTAKE,
  SALIENCE_TO_MEMORY_CLASS,
  MEMORY_CONFIDENCE_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  REVIEW_CONFIDENCE_MIN,
  REVIEW_CONFIDENCE_MAX,
  WORK_INTAKE_CONFIDENCE_THRESHOLD,
  IDEAS_HEADING,
  NOTES_HEADING,
  DECISIONS_HEADING,
  REMEMBERED_HEADING,
  FLAGGED_HEADING,
  buildKeywordRoutingPlan,
  buildNoteContent,
  buildRoutingPlan: buildKeywordRoutingPlan,
  buildThreePackagePlan,
  buildWorkIntakePlan,
  ideaJournalLine,
  inferTitle,
  isSubstantiveIdea,
  previewRouting,
  shouldFlagForReview,
};
