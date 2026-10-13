import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blankLearning, normalizeLearning, buildArchive } from './runs.mjs';
import { createHistory } from './timeline.mjs';

// An environment may contain several experiments. Each experiment keeps its
// own learning activity and result; the namespace/run ID is not an attempt ID.
export function currentAttempt(run) {
  if (!run.attempt) run.attempt = {
    id: `${run.id}-${(run.attempts?.length || 0) + 1}`,
    createdAt: new Date().toISOString(), startedAt: run.experimentAt || null,
    completedAt: null,
  };
  return run.attempt;
}

export function prepareAttempt(run) {
  const previous = currentAttempt(run);
  if (previous.startedAt || run.learning?.prediction || run.learning?.explanation) {
    run.attempts ||= [];
    run.attempts.push(structuredClone({
      ...previous, learning: normalizeLearning(run.learning),
      result: run.result || null, error: run.error || null,
      events: run.events || [], timeline: run.timeline,
    }));
    run.attempt = null;
    run.learning = blankLearning();
    run.result = null;
    run.error = null;
    run.experimentAt = null;
    run.events = [];
    run.timeline = createHistory();
    run.actions = 0;
    run.rev = (run.rev || 0) + 1;
  }
  return currentAttempt(run);
}

export function startAttempt(run) {
  if (currentAttempt(run).startedAt) prepareAttempt(run);
  const at = new Date().toISOString();
  currentAttempt(run).startedAt = at;
  run.experimentAt = at;
}

// Serialize atomic snapshots per environment. A successful learning response
// means its snapshot reached disk; interrupted writes cannot corrupt the last
// acknowledged record. The snapshot is captured before joining the queue.
export function savePractice(run, directory) {
  currentAttempt(run);
  const snapshot = structuredClone({ version: 1, ...buildArchive(run), experimentAt: run.experimentAt || null });
  const pending = (run.practiceSave || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true });
    const target = join(directory, `practice-${run.id}.json`);
    await writeFile(`${target}.tmp`, JSON.stringify(snapshot));
    await rename(`${target}.tmp`, target);
  });
  run.practiceSave = pending;
  return pending;
}

export async function restorePractice(run, directory) {
  let saved;
  try { saved = JSON.parse(await readFile(join(directory, `practice-${run.id}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`Learning recovery failed for ${run.id}: ${error.message}`);
  }
  if (saved.version !== 1 || saved.run !== run.id || saved.lesson !== run.lesson) {
    throw new Error(`Learning recovery identity/version mismatch for ${run.id}.`);
  }
  run.learning = normalizeLearning(saved.learning);
  run.attempt = saved.attempt || null;
  run.attempts = Array.isArray(saved.attempts) ? saved.attempts : [];
  run.result = saved.result || null;
  run.experimentAt = saved.experimentAt || null;
  run.events = Array.isArray(saved.events) ? saved.events : [];
  if (saved.timeline) run.timeline = saved.timeline;
  // Work is never resumed automatically. A started attempt without a result
  // is retained as interrupted evidence and can be followed by a new attempt.
  if (run.attempt?.startedAt && !run.result) run.attempt.interrupted = true;
  return true;
}
