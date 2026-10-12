# ADR: Single active lesson lifecycle

Status: Accepted — user refinement 2026-10-12, replacing the multi-run learner
UX. Namespace isolation mechanics from `docs/adr-run-isolation.md` are
unchanged; only the allocation UX and server enforcement change.

Live basis: server Start/Ready/End flows plus cancellation, migration, and
prerequisite guidance are covered by `dashboard/server.test.mjs` against a
fake cluster; browser acceptance (`scripts/ui-accept.mjs`) drives the React
console against real kind.

## Problem

Seven concurrent run environments forced learners to manage infrastructure
(New run / All runs / slots) instead of learning systems. Concurrent runs
also multiplied laptop load and made "which environment am I driving?"
ambiguous across tabs.

## Decision

One active lesson at a time, server-enforced across tabs and requests:

- **Preview:** selecting a lesson shows story, objective, prerequisites and
  duration. Previewing never provisions anything.
- **Start:** explicit `POST /api/lesson/start` runs understandable stages —
  `check-prerequisites` (shared deps verified, else actionable `make`
  guidance and no provisioning), `prepare-environment` (isolated
  `scaling-run-<id>` namespace via the existing run machinery), `ready`.
  Normal start never recreates/deletes a cluster. GKE steps are never
  auto-provisioned.
- **Practice:** exactly one allocation exists while active. Duplicate starts
  and direct run creation get 409. Predict/act/observe/explain/verify and
  evidence work as before, scoped to the active environment.
- **Switch:** selecting another lesson with an allocation prompts to end the
  current one (names the lesson and price: traffic stops, results save,
  only the owned namespace is removed). Cancel leaves everything untouched;
  confirm ends, then opens the destination **preview** — never auto-start.
- **End:** `POST /api/lesson/end` requests cancellation (observed at phase
  boundaries and in every load loop), stops load/queue work, terminates
  guided long requests with a bounded wait, persists evidence (complete,
  incomplete, or cancelled — never fabricated), then deletes only the owned
  namespace. Cleanup failure retains the allocation with retry and blocks a
  second start; the UI must not navigate as if cleanup succeeded.
- **History:** ended lessons keep readable results and downloadable evidence
  after teardown and dashboard restart. Viewing history provisions nothing.
- **Migration:** if an older version left several owned namespaces, boot
  reports them and the UI offers an explicit per-run resume (last one only)
  or end-with-evidence choice. Nothing is deleted silently; normal new
  sessions never see this UI.
- **Refresh/restart:** reconnect to the existing allocation (stable lesson
  IDs survive catalog reordering); never create duplicates.

## Consequences

- `POST /api/runs` 409s while a lesson is active; run-scoped mutating
  routes address only the active run. Legacy CLI paths (`make verify`,
  `/api/run`) and archived evidence stay available.
- Cancellation is cooperative (phase boundaries, load-loop checks,
  abandon-race for read-only status waits); teardown always finalizes via
  namespace deletion even if a worker ignores cancellation.
- Tests and UI select lessons by stable ID, never by catalog index.
