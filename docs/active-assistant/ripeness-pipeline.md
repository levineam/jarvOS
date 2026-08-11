# Ripeness pipeline contract

The Ripeness pipeline creates a bounded, inspectable ranking input. It is not a
task generator, a personal-state classifier, or an authorization to change a
project.

## Pipeline

1. **Prepare eligible evidence.** Apply source, privacy, and format rules
   before analysis. Excluded evidence is not silently treated as a negative
   signal.
2. **Recurrence Cluster.** Deterministically group recurring, related material
   into candidate themes. Clustering precedes ranking so a theme is not reduced
   to one isolated term.
3. **Score ripeness.** Deterministically rank a cluster from its observed
   recurrence shape, burst shape, distinctiveness, and available supporting
   material. The current prototype's numeric gates and weighting are
   configuration-specific, unvalidated parameters rather than public defaults.
4. **Retrieve support.** Deterministically locate bounded supporting material.
   A candidate without support is omitted rather than filled with speculation.
5. **Freeze the projection.** Bind the eligible inputs and their versions for a
   single candidate evaluation. The model receives only this bounded projection.
6. **Render and validate.** A model may express a candidate in ordinary
   language. Deterministic policy validates the result for evidence traceability,
   unresolved references, and unsupported motive or capability claims.

## Outputs and limits

The deterministic output is a ranked set of supported candidate themes plus
their bounded provenance. A model-generated suggestion is a separate output and
must remain traceable to that set. It can be rejected, salvaged, or replaced by
an intentional no-message outcome.

The pipeline cannot establish that a theme is important, that work is complete,
or that inactivity means abandonment. Completion-Stage Heuristic and Inactivity
Signal remain separate experimental hypotheses; Live Edge remains explicit
human-confirmed state.

## Validation posture

The existing implementation motivates recurrence clustering, scoring, and
support retrieval, but it is not proof of universal effectiveness. Evaluation
must predeclare held-out metrics and comparators. Completion-Stage Heuristic
requires recurrence-only, size/days, and random comparators plus a blinded
human comparison before admission; no safety regression is acceptable.

Public documentation and contracts contain no deployment evidence, local paths,
receipts, or calibration values. Those are private operational concerns.
