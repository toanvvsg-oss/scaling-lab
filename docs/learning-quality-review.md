# Learning quality implementation review

Reviewed and corrected: 2026-10-14.
Scope: The uncommitted learning-quality implementation, compared with
[the improvement plan](learning-quality-plan.md).

## Findings and corrections

| Priority | Finding reproduced during review | Correction |
| --- | --- | --- |
| P1 | Rerunning replaced the previous result and prediction while retaining the old explanation and completed self-review. The next prediction was always classified as after observation. | Separate attempt IDs, retained result/learning snapshots, a Prepare next attempt action, and automatic separation on a scenario rerun. New attempts start with fresh learning progress. |
| P1 | Active predictions and explanations existed only in memory; namespace recovery after a restart created blank learning records. | Serialized atomic practice snapshots, awaited before acknowledging learning updates, with identity/version validation and startup recovery. Interrupted experiments keep their evidence without automatically resuming work. |
| P1 | Downstream grading passed without any dependency samples by treating app shedding as proof of dependency saturation. | Require dependency CPU evidence. Sample during the measured workload rather than after a separate request-attempt probe. Missing dependency evidence stays inconclusive. |
| P1 | Downstream grading accepted 360 offers with 359 drops and only one settled request, and described the experiment as generator-clean. | Require settled accounting, at least 200 started/settled requests in each comparison phase, zero dropped/missed offers, and measured attempts per call. Withhold policy conclusions on insufficient evidence. |
| P2 | The documented capstone CLI could not supply the newly required rationale. | The CLI supplies and exports an explicit baseline rationale; it can be overridden with `SCALING_LAB_CAPSTONE_RATIONALE`. Dashboard configuration still requires learner rationale. |
| P2 | Reloaded learning fields stayed empty even though the API held submitted work. History displayed only completion statuses. | Hydrate fields once per attempt, preserve drafts during polling, use stable accessible labels, and display the current saved learning record in History. Earlier attempts remain in the evidence export. |
| P2 | After eleven explanation submissions, the initial response was silently removed by the ten-entry revision limit. | Preserve the initial response plus the nine most recent revisions. A revision clears the previous self-review completion. |
| P2 | Learning mutation endpoints accepted updates to an ended lesson. | Ready/active-lesson guards reject writes to ended, failed, stopping, or inherited environments. History remains read-only. |

Additional content correction: the HPA explanation previously claimed missing
metrics were never treated as zero. The displayed lab observations must remain
unknown when absent, but the controller's conservative calculation does use a
zero assumption during scale-up. Corrected lesson, model-answer, and evidence
wording against the [official algorithm](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/#algorithm-details), checked 2026-10-14.
Pending-pod explanations now distinguish missing resources from impossible
placement constraints.

## Validation

- Before correction: `rtk npm test` passed 114 tests, despite the reproduced
  failures. `rtk npm run ui-build` passed. This demonstrated coverage gaps.
- After correction: `rtk npm test` passed 122 tests with no failures.
  Regressions cover distinct attempts, initial revisions, closed-record
  mutation, restart recovery, corrupted/mismatched files, downstream evidence
  gaps, and CLI option plumbing.
- `rtk npm run ui-build` passed for the updated React console.
- Browser regression command: `rtk proxy node scripts/ui-learning.mjs`.
  It uses an in-memory cluster and simulated results, never kubectl. It
  exercises saved-field hydration, draft preservation during polling, HTTP
  app restart, a second attempt, retained initial failure, History, and a
  narrow viewport. The final run passed; see the plan handoff for its artifact path.
- `rtk git diff --check` checks the working-tree changes for whitespace errors.

## Remaining acceptance and next work

Real downstream/capstone acceptance has not been claimed. The dedicated kind
cluster already contains the learner's `scaling-run-a6e9a212` autoscaling
environment. The review/fix work preserves it. Run scenario acceptance after
the learner ends that lesson through the normal lifecycle; do not create a
second dashboard environment or silently remove the existing namespace.

The new downstream checks deliberately return inconclusive if metrics or
drain observations are missing. A live run must confirm the laptop workload
produces enough dependency-side saturation and clean generator evidence.

The broader curriculum plan remains unfinished. In particular, annotated
pilot evidence visuals, independent challenge UI/variants, before/after
comparison presentation, human learner feedback, and expansion to the other
lessons still need their acceptance criteria satisfied. Existing handoff claims
that entire milestones are “done” must not substitute for those checks.

No changes were committed or pushed during this review/fix task.
