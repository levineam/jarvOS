'use strict';

const {
  applyThreePackagePlan,
} = require('../../routing/src/three-package-router');
const {
  detectTrigger,
} = require('../../routing/src/keyword-capture-router');

const HIGH_CONFIDENCE = 0.8;
const MEDIUM_CONFIDENCE = 0.5;

function normalizeClassification(classification = {}) {
  const salienceClass = String(classification.salienceClass || 'nothing').trim() || 'nothing';
  const rawConfidence = Number(classification.confidence);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
  return {
    ...classification,
    salienceClass,
    confidence,
  };
}

function normalizeInput(input = {}) {
  const classification = normalizeClassification(
    input.classification || input.classifierOutput || input.salience || {},
  );
  const text = String(input.text || input.content || input.body || '').trim();
  const trigger = input.trigger || detectTrigger({ ...input, text });

  return {
    ...input,
    text,
    date: input.date,
    trigger,
    classification,
  };
}

function destinationsFromRouting(routing) {
  const destinations = ['journal'];
  if (routing?.note) destinations.push('notes');
  if (routing?.memory) destinations.push('memory');
  return destinations;
}

function buildCaptureEvent(capture, trigger) {
  const { classification } = capture;
  const captureEvent = {
    trigger,
    text: capture.text,
    title: capture.title,
    content: capture.content,
    frontmatter: capture.frontmatter,
    date: capture.date,
    substantive: capture.substantive,
    createNote: capture.createNote,
    createDurableNote: capture.createDurableNote,
    durable: capture.durable,
    durableNote: capture.durableNote,
    standaloneNote: capture.standaloneNote,
  };

  if (classification.salienceClass !== 'nothing' && classification.confidence >= HIGH_CONFIDENCE) {
    captureEvent.salienceClass = classification.salienceClass;
    captureEvent.confidence = classification.confidence;
  }

  return captureEvent;
}

const CAPTURE_SKILLS = [
  {
    id: 'journal-entry',
    description: 'Write idea-class captures into the journal package.',
    matches(capture) {
      if (capture.trigger === 'idea') return true;
      return capture.classification.salienceClass === 'idea'
        && capture.classification.confidence >= HIGH_CONFIDENCE;
    },
    invoke(capture, options = {}) {
      const routing = applyThreePackagePlan(buildCaptureEvent(capture, 'idea'), options);
      const createsNote = Boolean(routing?.note);
      return {
        captured: true,
        skillId: createsNote ? 'note-creation' : 'journal-entry',
        path: capture.trigger ? 'keyword_trigger' : 'salience_high',
        trigger: capture.trigger || null,
        salienceClass: capture.classification.salienceClass,
        confidence: capture.classification.confidence,
        destinations: destinationsFromRouting(routing),
        title: routing.plan?.noteTitle || routing.note?.title || null,
        routing,
      };
    },
  },
  {
    id: 'note-creation',
    description: 'Create durable notes through the configured storage adapter.',
    matches(capture) {
      if (capture.trigger === 'note') return true;
      return capture.classification.salienceClass !== 'nothing'
        && capture.classification.salienceClass !== 'idea'
        && capture.classification.confidence >= HIGH_CONFIDENCE;
    },
    invoke(capture, options = {}) {
      const routing = applyThreePackagePlan(buildCaptureEvent(capture, 'note'), options);
      return {
        captured: true,
        skillId: 'note-creation',
        path: capture.trigger ? 'keyword_trigger' : 'salience_high',
        trigger: capture.trigger || null,
        salienceClass: capture.classification.salienceClass,
        confidence: capture.classification.confidence,
        destinations: destinationsFromRouting(routing),
        title: routing.plan?.noteTitle || routing.note?.title || null,
        routing,
      };
    },
  },
];

function noCaptureResult(capture, path = 'no_capture') {
  return {
    captured: false,
    skillId: null,
    path,
    trigger: capture.trigger || null,
    salienceClass: capture.classification.salienceClass,
    confidence: capture.classification.confidence,
    destinations: [],
    title: null,
  };
}

function ignoredPathForCapture(capture) {
  const confidence = capture.classification?.confidence;
  if (
    typeof confidence === 'number'
    && confidence >= MEDIUM_CONFIDENCE
    && confidence < HIGH_CONFIDENCE
  ) {
    return 'salience_medium_ignored';
  }
  return 'no_capture';
}

function dispatchCapture(input = {}, options = {}) {
  const capture = normalizeInput(input);

  if (!capture.text) {
    return noCaptureResult(capture, 'empty_input');
  }

  const skill = CAPTURE_SKILLS.find((candidate) => candidate.matches(capture));
  if (!skill) {
    return noCaptureResult(capture, ignoredPathForCapture(capture));
  }

  return skill.invoke(capture, options);
}

module.exports = {
  CAPTURE_SKILLS,
  HIGH_CONFIDENCE,
  MEDIUM_CONFIDENCE,
  dispatchCapture,
  ignoredPathForCapture,
  normalizeClassification,
  normalizeInput,
};
