# Active Assistant methodology

Active Assistant is a decision-support method. It turns bounded, eligible
evidence into an inspectable candidate suggestion; it does not diagnose a
person, infer intent, or take action on their behalf.

## Three semantic layers

The method keeps three layers separate:

1. **Domain ontology** — `ONTOLOGY.md` is the canonical model of projects,
   notes, people, decisions, and their relationships.
2. **Decision ledger** — records which bounded evidence was eligible, the
   decision made, and the resulting typed outcome. It is not an ontology and
   does not redefine domain entities.
3. **Intervention and evaluation vocabulary** — a light, versioned use of
   BCIO and BCTTv1 labels an intervention and its evaluation. It references
   ontology entities through an adapter; it never creates a second Project or
   personal-knowledge model.

COM-B and Behaviour Change Wheel labels are optional annotations only. They
are permitted when a concrete target behaviour is explicit or
human-confirmed. Passive activity is not evidence of capability, opportunity,
motivation, avoidance, or intent.

## Analysis terms

| Term | What it does | Status and boundary |
| --- | --- | --- |
| **Recurrence Clustering** | Deterministically groups recurring, related evidence into a candidate theme before ranking. | A ranking input, not a claim about a person's priorities or psychological state. Cluster quality must be evaluated against declared comparators. |
| **Ripeness Scoring** | Deterministically ranks eligible clusters using observed recurrence, burst shape, and available supporting material. | The current prototype uses corpus filtering, term frequency, inverse-document-frequency weighting, recurrence, same-period burst, and support counts. Its configured gates and weights are implementation parameters, not universal defaults. |
| **Support Retrieval** | Deterministically finds bounded source material that can support a candidate. | Missing support excludes a candidate from grounded synthesis; retrieval does not establish truth or authority. |
| **Completion-Stage Heuristic** | The experimental name for the current standalone `gapStatement` logic. It may surface a possible completion-stage question. | It is not “Gap Analysis,” does not determine that something is unfinished, and remains experimental until it beats predeclared recurrence-only, size/days, and random comparators on held-out evaluation and earns a net-positive blinded human comparison without a safety regression. |
| **Inactivity Signal** | The backtest-only `goneQuiet` score, which can surface a reversible review question. | It is a hypothesis, not evidence of abandonment, low value, or a lifecycle change. No universal inactivity threshold is asserted. |
| **Live Edge** | An explicit human-confirmed statement of the last accepted project state and next unresolved move. | It is continuity state, not a score. Automation may display or request confirmation, but may not create or advance it from recency, embeddings, fragments, or inactivity. |

## What is computed and what is judged

The evidence pipeline is deterministic where it can be: it applies eligibility
and privacy rules, performs recurrence clustering, scores and retrieves support,
freezes the admitted input set, and records typed outcomes. A model may render
a bounded candidate from that projection, but it does not choose the evidence,
invent a domain mapping, infer motives, or write project or Live Edge state.
Post-render semantic policy checks reject unsupported claims and unresolved
references.

The **JITAI** framework supplies the decision architecture: decision point,
tailoring variables, intervention options, decision rule, and proximal outcome.
It is not evidence that a prompt works. “No message” is a first-class
intervention option when the eligible evidence does not support a useful,
safe suggestion.

BCIO and BCTTv1 supply a compact, versioned vocabulary for describing the
intervention and evaluation; they do not select a nudge or classify a person.
Any local usefulness claim requires the declared evaluation, including human
review, rather than a framework label.

## Public contract and private prototype

This repository publishes reusable contracts, generic algorithms, synthetic
fixtures, and public-safe method documentation. Deployments retain their source
adapters, local configuration, evidence, receipts, outputs, and calibration
choices privately. Documentation therefore describes algorithmic inputs and
boundaries without presenting deployment-specific thresholds, examples, or
evaluation results as general defaults.

See [the Ripeness pipeline](ripeness-pipeline.md) for the deterministic
pipeline boundary.
