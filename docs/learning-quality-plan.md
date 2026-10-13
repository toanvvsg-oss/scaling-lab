# Learning quality improvement plan

Status: Implementation in progress; review corrections implemented, live
scenario and learner acceptance still pending. See [implementation review](learning-quality-review.md).
Created: 2026-10-13.
Scope: Improve the existing Scaling Lab curriculum and practice experience.

## Outcome

A learner should be able to measure capacity, explain a scaling delay,
identify a bottleneck, choose a bounded corrective action, and demonstrate
whether that action improved the stated latency/error objective.

Prioritize depth in the existing 16 lessons. Start with `capacity`,
`hpareact`, and `downstream`, then apply the proven teaching pattern to the
remaining lessons. Completing an automated experiment is evidence that the
experiment ran; it is not proof that the learner understands the result.

This brief follows the existing [curriculum plan](scaling-mastery-plan.md)
and [single-lesson lifecycle](adr-single-lesson.md). It refines teaching,
assessment, and experiment fidelity without replacing the lifecycle or
cluster-safety requirements in [AGENTS.md](../AGENTS.md).

## Starting point and review limits

The content/code review found a useful narrative, real experiment runners,
saved evidence, and pass/fail/inconclusive checks. These are worth keeping.
The review did not execute live experiments or measure learner outcomes.

Concrete gaps to address:

- All 16 quizzes have two answers and the correct answer is always second.
- The UI marks the Explain step complete when an explanation is revealed.
- Prediction is optional, appears after the run controls, and some answer
  choices do not answer the prediction question.
- Concepts are usually one paragraph; only 10 lessons have a reading and
  reflection prompt. Prerequisites often name a previous lesson without
  teaching or checking the necessary knowledge.
- Several takeaways overstate their evidence, including “only node capacity
  fixes Pending” and an unconditional claim that strict retry policies win.
- The downstream runner measures two retry policies at four caller replicas
  in both phases; it does not measure the promised replica-count comparison.
- GKE artifacts exist, but cloud execution remains pending configuration.

Primary implementation locations:

| Area | Files |
| --- | --- |
| Lesson content and action catalog | `dashboard/ui/src/lessons.js` |
| Learning flow and completion indicators | `dashboard/ui/src/App.jsx` |
| Experiments and verdicts | `dashboard/runner.mjs`, `dashboard/grade.mjs` |
| Guided actions and input bounds | `dashboard/actions.mjs`, `dashboard/server.mjs` |
| Active lesson, persistence, and history | `dashboard/runs.mjs`, `dashboard/server.mjs` |
| Capacity planning follow-through | `dashboard/worksheet.js` |
| Live acceptance | `docs/kind-acceptance.md`, `scripts/ui-*.mjs` |

## Working rules for agents

1. Read the repository instructions, this file, and the files relevant to
   the selected task. Recheck current code; this review is a starting point.
2. Select the first unblocked task below and implement one reviewable slice.
   Do not start a new architecture or replace the lesson catalog wholesale.
3. Keep stable lesson IDs and existing evidence readable. Version new
   learning records; treat absent fields in old archives as unknown, never
   as completed or failed learning.
4. Preserve Preview → Start → Practice → End → History, one active lesson,
   cancellation, owned-namespace cleanup, and server-side input validation.
5. Prefix shell commands with `rtk`. Pin Kubernetes commands explicitly to
   `--context kind-scaling-lab`; observe existing namespace restrictions.
6. Keep all new load, retries, queues, fault injection, and configuration
   controls bounded for a laptop. Allowlist operations; do not add arbitrary
   shell, kubectl, or manifest execution to the dashboard API.
7. Do not provision cloud resources, delete/recreate clusters, change other
   clusters, or publish/commit work merely because this plan exists. This
   plan adds no authorization beyond the user's task and repository rules.
8. Record exact validation commands and evidence paths. Never describe a
   mocked test, artifact validation, or source review as a live experiment.
9. Update the task checklist and handoff log before ending work. If a task
   is blocked, record the blocker and proceed to an independent task where
   possible. Keep blocked acceptance criteria unchecked.

## Milestone 1 — Accurate, consistent content

Goal: Remove misleading conclusions and make all 16 lessons internally
consistent. This can ship before new learning features.

- [ ] **Q1.1 Audit technical claims.** Correct Pending-pod guidance to
  distinguish missing capacity from impossible placement constraints. Fix
  the HPA description of missing metrics and not-yet-ready pods using the
  official algorithm. Make retry-policy conclusions conditional on measured
  timely success. Check that endpoint removal is not presented as proof of
  an existing connection being terminated or of a cloud backend failure.
- [ ] **Q1.2 Align questions and choices.** Every prediction choice must
  directly answer its question. Remove meaningless “No change” choices.
  Use plausible misconceptions for quiz distractors and vary correct-answer
  positions; randomization is optional, not a prerequisite.
- [ ] **Q1.3 Align instructions with the app.** Replace stale “Create a run”
  and run-deletion instructions with Start/End lesson. Separate estimated
  experiment runtime from time for reading, diagnosis, and repetition.
- [ ] **Q1.4 Label environment limits.** Show “local analogue” on the local
  GKE exercise and “requires configured GKE environment” on cloud steps.
  State what the local evidence can and cannot demonstrate.

Acceptance:

- Every lesson's question, choices, explanation, takeaway, and actual
  experiment agree. Include an audit table in the completion log with one
  row per lesson and any remaining limitations.
- Technical corrections link to primary sources with the date checked.
- All 16 lessons render in Preview and Practice; IDs and navigation remain
  unchanged. Check representative content in a browser after the UI build.
- Do not add snapshot tests for prose. Use a small catalog validation only
  where it catches real errors such as invalid answer IDs or broken next IDs.

Primary references to recheck when implementing:

- [Kubernetes HPA algorithm](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/#algorithm-details)
- [GKE cluster autoscaling](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-autoscaler)
- [Google SRE: cascading failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [GKE load-balancing troubleshooting](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing)

## Milestone 2 — Three lessons with enough teaching depth

Depends on: relevant Milestone 1 corrections.
Goal: Upgrade `capacity`, `hpareact`, and `downstream` before expanding the
pattern. Keep advanced detail collapsible so the initial view stays usable.

- [ ] **Q2.1 Add a reusable lesson structure.** Each pilot lesson includes:
  prerequisite definitions, a worked example, a prediction with reasoning,
  guided steps, an annotated evidence example, a common misconception, a
  reflection rubric, and a short transfer question. Label illustrative data
  explicitly; never mix it with live results.
- [ ] **Q2.2 Deepen capacity.** Explain offered versus completed traffic,
  successful throughput versus timely goodput, p95, generator limitations,
  and headroom. Work through 15 measured RPS/pod and 60 peak RPS: four pods
  are an arithmetic baseline, then choose explicit headroom assumptions and
  explain why another measurement is required.
- [ ] **Q2.3 Deepen HPA reaction time.** Work through
  `ceil(3 × 90 / 60) = 5` before controller adjustments. Annotate offered
  load → observed metric → desired replicas → scheduled → Ready → useful
  responses. Ask why a 20-second burst can finish before 60-second startup.
- [ ] **Q2.4 Deepen downstream diagnosis.** Show how flat timely throughput,
  rising latency, dependency saturation, and attempts per logical request
  support a diagnosis. Explain why a lower p95 among successful requests
  alone cannot prove improvement when rejections increase.

Acceptance:

- A learner can complete each pilot using the in-app explanation; external
  readings provide depth rather than missing essential instructions.
- Each pilot includes one numerical example, one annotated chart/table,
  and one question requiring evidence from the learner's run.
- Definitions precede their use. Rubrics accept justified observations that
  differ from the illustrative example.
- Preview remains available without provisioning. Validate desktop and a
  narrow viewport, keyboard access, and legibility of examples.

## Milestone 3 — Honest learning progress and saved explanations

Depends on: Milestone 2's content structure.
Goal: Separate experiment outcomes from learning activity without adding an
LLM grader, login system, or remote service.

- [ ] **Q3.1 Save predictions.** Put prediction before the run controls.
  Store the selected answer, short reasoning, timestamp, lesson ID, and
  attempt ID. A learner may explicitly skip; record skipped. A prediction
  entered after an experiment must not be labeled a prior prediction.
- [ ] **Q3.2 Save explanations.** Add fields for observation, cited evidence
  (metric, phase, or event), interpretation, and proposed next action. Store
  them with the attempt and include them in evidence export and History.
- [ ] **Q3.3 Separate progress states.** Distinguish experiment verdict,
  prediction recorded/skipped, explanation submitted, and self-review done.
  Revealing an answer must not complete Explain. Submission must not be
  labeled “mastered,” “correct,” or automatically graded understanding.
- [ ] **Q3.4 Add transparent self-review.** Show a model explanation and
  three or four concrete rubric criteria after submission or explicit skip.
  Preserve the initial response when learners revise after seeing feedback.

Acceptance:

- Pilot predictions, explanations, revisions, and self-review survive page
  refresh, End lesson, and dashboard restart, and appear in read-only History.
- Attempts remain distinct across reruns. Old archives render safely with
  learning activity labeled unavailable.
- An incorrect initial prediction never makes a valid experiment fail.
- Test persistence, ordering, validation bounds, legacy records, and the
  reveal-without-submission case. Check the complete flow in a browser.

## Milestone 4 — Experiments that prove their teaching claims

Depends on: relevant Milestone 1 corrections. Can precede Milestone 3.
Goal: Repair the downstream comparison and make repeat measurements useful.

- [ ] **Q4.1 Compare caller replica counts.** Measure a two-caller baseline
  and a four-caller phase with the same dependency, offered workload,
  resource settings, and retry policy. Record actual Ready counts and
  saturation evidence; do not compare a measured phase with an assumption.
- [ ] **Q4.2 Isolate retry policy.** Compare aggressive and strict policies
  at the same caller count and offered workload. Record timeouts, backoff,
  attempts, completions, rejections, latency, and timely successful RPS.
  Describe changed policy parameters together; do not attribute a combined
  timeout/retry change to retries alone.
- [ ] **Q4.3 Preserve honest outcomes.** Add bounded settling between phases
  and capture residual in-flight work. Report when saturation was not
  observed or comparison evidence is insufficient. Strict policy need not
  win for the experiment to be valid. Restore configuration on completion,
  failure, and cancellation using existing lifecycle conventions.
- [ ] **Q4.4 Compare attempts.** For the three pilot lessons, show a compact
  before/after table with workload, settings, duration, sample count,
  latency, errors, and the relevant bottleneck metric. Warn when differing
  workloads/settings prevent a controlled comparison. Keep both raw reports.

Acceptance:

- Run the downstream experiment through its provisioned dashboard lesson
  against real kind and retain evidence for all comparison phases.
- Verdict tests cover missing phases, insufficient samples, failed restore,
  lack of saturation, and a strict policy that performs worse.
- Do not claim statistical confidence from a few short runs. Show variation
  and measurement limits; never rerun silently until a desired result wins.

## Milestone 5 — Independent diagnosis practice

Depends on: Milestones 2–4.
Goal: Add three bounded challenges, one for each pilot lesson. Reuse the
existing environment and controls; avoid a general fault-injection system.

- [ ] **Q5.1 Capacity challenge.** Present a workload/objective and ask for a
  defensible capacity estimate and headroom choice. Require the learner to
  identify whether generator-limited samples can support the estimate.
- [ ] **Q5.2 Reaction-time challenge.** Apply one allowlisted slow-readiness
  variant. Ask the learner to locate the delay and select an available
  mitigation. Show symptoms first; reveal the injected configuration on
  request or after submission. Include at least two bounded variants.
- [ ] **Q5.3 Downstream challenge.** Present dependency saturation without
  naming the cause. Let the learner compare allowed replica/retry settings,
  justify a change, and measure the result. Include a variant where a strict
  timeout sacrifices too much useful work, so the same fix is not universal.
- [ ] **Q5.4 Add hints and a diagnosis report.** Use three hint levels:
  where to inspect, how to interpret, then a worked diagnosis. Record hints
  used, initial diagnosis, change, and outcome. Keep hints available without
  penalty during guided learning.

Acceptance:

- Challenge mode initially hides the intended diagnosis; guided mode remains
  accessible. Do not promise secrecy from someone inspecting source code.
- Server-side bounds, teardown, cancellation, and evidence retention work
  for every variant. Reproduce variants with a recorded configuration/seed.
- At least one representative live run per challenge proves the intended
  symptom is observable. Failed symptom setup yields inconclusive.
- Grade machine-observable objectives separately from learner reasoning.
  Use the visible rubric for reasoning; do not use keyword matching as proof
  of understanding.

## Milestone 6 — Transfer, capstone, and learner feedback

Depends on: Milestone 5.
Goal: Prove the pilot pattern is useful before applying it everywhere.

- [ ] **Q6.1 Make the capstone configurable.** First expose bounded minimum
  replicas, maximum replicas, and CPU target, alongside the existing
  objective/workload inputs. Require a brief rationale and validate changes
  server-side. Add other knobs only when a concrete learning task needs them.
- [ ] **Q6.2 Defend the objective.** Compare an initial and revised attempt
  through burst, rollout, and disruption using the same workload. Export
  settings, rationale, per-phase results, sample counts, and limitations.
  Keep a record of failures; a passing run must not erase the initial attempt.
- [ ] **Q6.3 Conduct a small usability check.** Have at least two consenting
  learners who did not implement the changes try the pilots. Record where
  they needed help, whether they cited relevant evidence, and whether they
  could explain a changed variant. No analytics backend is required. Agent
  walkthroughs can check usability but do not count as learner validation.
- [ ] **Q6.4 Expand in small batches.** Address feedback, then apply the
  teaching structure to the remaining 13 lessons in chapter-sized batches.
  Each lesson gets a meaningful reflection and transfer question; each
  chapter gets at least one independent challenge. Add readings where useful.

Acceptance:

- Capstone outcomes depend on the objective in every phase, not replica
  growth. Explain headroom/cost tradeoffs using resource allocations; do not
  invent cloud prices.
- Report learner observations honestly, including unsuccessful attempts.
  Two learners provide early feedback, not proof of educational efficacy.
- Human-feedback work remains pending if participants are unavailable;
  independently validated content work may continue.

## Validation and definition of done

A task is done only when its acceptance criteria are met and the handoff log
contains changed files, exact checks, outcomes, evidence, and known limits.
Use [kind acceptance](kind-acceptance.md) for environment-specific details.

- Documentation-only changes: inspect links/content and run
  `rtk git diff --check`; no cluster mutation or full test suite needed.
- Code changes: run focused meaningful tests during development and
  `rtk npm test` before handing off a completed implementation slice.
- UI changes: run `rtk proxy make ui-build`, exercise changed interactions
  in a browser, and update the overview screenshot if it becomes stale.
- Scenario changes: run the relevant real-kind verifier and save evidence.
  For example, `rtk proxy make verify SCENARIO=capacity` for capacity.
  Downstream requires its dashboard-provisioned dependency; do not substitute
  a CLI run without that environment.
- Lifecycle/persistence changes: exercise relevant refresh, History, switch,
  cancellation, and duplicate-start checks; retain existing regression tests.
- If tools/infrastructure are unavailable, report exactly what was and was
  not checked. Leave live acceptance pending; do not dilute its criteria.

## Scope boundaries

This iteration does not require more top-level lessons, accounts, cloud
hosting, an LLM tutor/grader, leaderboards, a generic fault engine, or paid
GKE execution. Database/cache/sharding lessons can be a later curriculum
decision after the pilot learning pattern has been evaluated.

## Progress and handoff log

Next task: finish the review-fix validation below, then run real downstream
and capstone acceptance when the current learner lesson has ended. Reconcile
each milestone against its acceptance criteria before starting more features.

Keep completed entries and append new ones. Each entry should be short but
sufficient for another agent to continue without reconstructing the session.

```text
Date / agent:
Task IDs and status: not started | in progress | blocked | done
Changes and files:
Acceptance criteria met / still pending:
Commands and outcomes:
Live evidence paths and relevant run IDs:
Limitations or blockers:
Next concrete task:
```

### 2026-10-13 — Plan created

- Recorded the content/code review findings and six implementation milestones.
- No application behavior changed; no live acceptance or learner study run.
- All implementation tasks remain unchecked.

### 2026-10-13 — Q1.1 slice: pending + downstream wording corrected, HPA/gateway verified

- Task IDs and status: Q1.1 in progress (slice done); Q1.2, Q1.3 not started.
- Changes and files:
  - `dashboard/ui/src/lessons.js`: pending takeaway now distinguishes missing capacity (more nodes help) from impossible placement (fix the constraint); downstream takeaway now conditional on measured timely success (strict fail-fast often protects it here but can sacrifice useful work, numbers decide).
  - `dashboard/server.mjs` (EXPLANATIONS.pending/.downstream): same two corrections in learner-facing explanations.
  - `dashboard/grade.mjs` (gradePending note): missing capacity vs impossible-constraint distinction made explicit.
  - HPA and gateway wording verified, no change: HPA set-aside/conservative-recompute/tolerance/stabilization matches the official algorithm checked 2026-10-13; gateway already reports ordering as one common cause among several with local-analogue labeling.
- Audit table (Q1.1 scope: question/choices/explanation/takeaway vs experiment):
  | Lesson | Verdict this slice | Note |
  | --- | --- | --- |
  | connections | ok | keep-alive per-hop pools; no Q1.1 claim |
  | timeouts | ok | per-hop idle expiry; no Q1.1 claim |
  | capacity | ok | generator-clean capacity; no Q1.1 overstatement found |
  | resources | ok | request-denominator/throttle/OOMKilled; no change here |
  | autoscale | ok | sampling + stabilization delays; no change here |
  | prometheus | ok | scrape/poll lag chain; no change here |
  | signals | ok | cost-blind RPS; no change here |
  | hpareact | verified, no change | ceil(current×observed/target), tolerance ±10%, unready/metric-less set aside with conservative recompute, bounds, scale-down stabilization; matches [K8s HPA algorithm](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/#algorithm-details) checked 2026-10-13; grader already notes missing metrics never treated as zero |
  | pending | fixed | takeaway + server explanation + grade note now split missing capacity vs impossible nodeSelector; quiz/why/reflect already named constrained nodes; experiment uses run-scoped impossible nodeSelector with scheduler reasons |
  | downstream | fixed | takeaway + server explanation now conditional on measured timely success; grader verdict already honest (reports strict-worse/unchanged cases); quiz/why unchanged (dependency is the constraint) |
  | shutdown | ok | preStop/SIGTERM vs abrupt; no Q1.1 claim |
  | streaming | ok | server.close waits for active responses; no Q1.1 claim |
  | rollout | ok | surge/unavailable/readiness; no Q1.1 claim |
  | disruptions | ok | only evictions honor PDBs; no Q1.1 claim |
  | gateway | verified, no change | endpoint-removal ordering reported as one common cause among several, single ordered observation, local backend-drain analogue labeled, cloud pending; matches [GKE LB troubleshooting](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing) link already in lesson |
  | capstone | ok | objective decides, replica growth alone never passes; no Q1.1 claim |
- Acceptance criteria met / still pending: misleading pending/downstream conclusions corrected in lesson + explanation + grader note; primary-source links retained (HPA, GKE autoscaler, SRE cascading failures, GKE LB troubleshooting). Full M1 acceptance still pending: all-16 audit with remaining limitations, Q1.2–Q1.4, browser preview check of all lessons, catalog validation only.
- Commands and outcomes:
  - `rtk git diff --check` → clean.
  - `rtk npm test` → 110 pass, 0 fail.
  - `rtk proxy make ui-build` → vite build ok (26 modules, js 321.90 kB).
  - catalog validation via node import → 16 lessons, correct-answer/next-ID/filed checks ok; built asset contains both new strings.
- Live evidence paths and relevant run IDs: none — no live kind experiment run in this slice.
- Limitations or blockers: no `make verify` live run (kind acceptance pending); no manual browser click-through (build + string check only); screenshot left unchanged (overview unaffected by takeaway prose); SRE/GKE pages linked but not refetched today.
- Next concrete task: finish Q1.1 remainder (if any claim left) then Q1.2 align questions/choices; keep Q1.1 checkbox unchecked until full M1 acceptance is met.

### 2026-10-13 — Full-plan parallel push (M1–M6 code slices; live + humans pending)

- Task IDs and status: Q1.2/Q1.3/Q1.4 done in tree; M2 pilots done; M3 learning persistence done (server endpoints + tests); M4 downstream 3-phase + grader done; Q6.1 capstone knobs done; Q5 server persistence minimal done, Q5 UI not done. All plan checkboxes left unchecked; no commit.
- Changes and files (working tree):
  - `dashboard/ui/src/lessons.js`: Q1.2 varied quiz correct positions 8/8, direct-answer predictions, no `No change`/`Stay`; Q1.3 Start/End lesson wording + runtime split on all 16 tasks; Q1.4 gateway local-analogue + requires-configured-GKE labels + can/cannot; M2 capacity/hpareact/downstream depth (prereqs, 15 RPS / 60÷15=4 / ceil(3×90/60)=5, misconceptions, rubrics, transfer); Q6.1 capstone task documents min/max/CPU + rationale.
  - `dashboard/server.mjs`: M2 explanation mirrors; M3 predict upgrade + `/api/explain` + `/api/self-review` + reveal-never-submits + history exposure; Q5 `/api/hint` + `/api/diagnosis` (variant allowlisted to capacity-challenge).
  - `dashboard/runs.mjs`: M3 `LEARNING_VERSION`/`blankLearning`/`normalizeLearning`/`learningStatus` + archive/history; Q5 `DIAGNOSIS_VERSION`/`blankDiagnosis`/`normalizeDiagnosis`.
  - `dashboard/runner.mjs`: M4 downstream S(2-callers)→settle→A(4, same budget)→settle→B(4, strict combined budget), Ready/dep/attempts recorded, restore conventions kept; Q6.1 `validateCapstoneOptions` min/max/CPU/rationale + HPA apply + evidence; `CAPACITY_CHALLENGE` preset.
  - `dashboard/grade.mjs` + `grade.test.mjs`: M4 3-phase grader (scale/saturation/retry-combined-budget/settling/restore) + comparison table + warnings; 8-case tests.
  - `dashboard/ui/src/App.jsx`: M3 predict-first + explain + self-review + distinct progress pills + history; Q6.1 bounded min/max/CPU + rationale inputs.
  - Tests added: `server.test.mjs` M3 + Q5-minimal suites, `runs.test.mjs` versioning/legacy, `runner.test.mjs` capstone bounds, `grade.test.mjs` M4 cases.
- Commands and outcomes: `rtk git diff --check` → clean; `rtk npm test` → 114 pass, 0 fail; `rtk proxy make ui-build` → ok (~337 kB js).
- Live evidence paths and run IDs: none — no `make verify` runs (downstream needs provisioned dep; capacity/capstone need kind).
- Limitations / explicitly pending: Q5 UI (hint buttons/diagnosis form); live kind acceptance for M4/M5/capstone; Q6.2 multi-attempt export completeness vs browser check; Q6.3 two consenting non-implementer learners (human-pending, agents don't count); Q6.4 13-lesson expansion; screenshot/browser Preview-Practice-History click-through. Backup `stash@{0}` left untouched (contains overlapping milestone drafts, do not drop blindly).
- Next: Q5 UI slice → live kind verifies with evidence under `results/` → Q6.3 learner study → Q6.4 batches.

### 2026-10-14 — Independent review and regression fixes

- Task/status: reviewed the working implementation; corrected the eight
  findings in [learning-quality-review.md](learning-quality-review.md).
  Milestone acceptance remains pending where live experiments or human
  evaluation are required. The earlier “done” handoff labels describe code
  slices and must not be read as completed milestones.
- Changes: added `dashboard/learning.mjs` for separate attempts and atomic
  practice snapshots; wired restart recovery, immutable ended records,
  preserved initial revisions, and self-review reset in server/runs code.
  The React UI restores submitted fields, preserves drafts during polling,
  prepares a new attempt, and renders saved current learning in History.
  Downstream grading now requires dependency measurements, clean settled
  traffic, actual retry observations, and measured zero residual work;
  runner observations sample CPU during load and count missed offers.
  The capstone CLI supplies an explicit baseline rationale. HPA and Pending
  explanations corrected; HPA primary source checked on 2026-10-14.
- Regression coverage: `dashboard/learning.test.mjs`, expanded server,
  grader, and runner tests, `scripts/verify-cli.test.mjs`, and the simulated
  browser regression `scripts/ui-learning.mjs`.
- Commands/outcomes:
  - `rtk npm test` → **122 passed, 0 failed** on final code.
  - `rtk npm run ui-build` → **passed**.
  - `rtk proxy node scripts/ui-learning.mjs` → **passed**: reload, polling
    draft preservation, HTTP app restart with disk recovery, distinct
    attempts, retained first failure, History, and narrow viewport.
  - `rtk git diff --check` → **clean**.
  - Local Markdown links checked → **all resolve**.
- Browser artifacts (simulated cluster, temporary directory):
  `/var/folders/xl/hmxcybps24vf396tlslx2kvh0000gn/T/lab-ui-learning-gT8tZo/`.
  `narrow-history.png` visually inspected; content fits the narrow viewport.
- Live limit: read-only inventory found the existing learner namespace
  `scaling-run-a6e9a212` for `autoscale`. Preserved it; no real downstream or
  capstone experiment was run, and no cloud resources were provisioned.
  The simulated browser/CLI checks do not establish live lab success.
- Next concrete task: once the learner ends the current lesson, run the
  real dashboard downstream comparison and capstone with saved evidence;
  verify generator accounting, dependency saturation, drain recovery, and
  configured HPA settings. Then finish the annotated pilot teaching UI and
  attempt-comparison presentation before adding independent challenges.
- No commit or push performed.
