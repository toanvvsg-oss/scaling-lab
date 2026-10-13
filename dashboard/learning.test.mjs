import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentAttempt, prepareAttempt, startAttempt, savePractice, restorePractice } from './learning.mjs';
import { blankLearning, buildArchive } from './runs.mjs';
import { createHistory } from './timeline.mjs';

const runFor = () => ({ id: 'abcdef12', lesson: 'capacity', ns: 'scaling-run-abcdef12', status: 'ready',
  learning: blankLearning(), events: [], timeline: createHistory(), result: null });

test('reruns preserve results and learning under distinct attempt IDs', () => {
  const run = runFor();
  currentAttempt(run);
  run.learning.prediction = { status: 'recorded', answer: 'up' };
  startAttempt(run);
  run.result = { status: 'fail', evidence: { capacityRps: 5 } };
  run.learning.explanation = { status: 'submitted', observation: 'initial failure' };
  run.learning.selfReview = { done: true };
  run.learning.modelRevealed = { at: new Date().toISOString() };
  prepareAttempt(run);
  assert.equal(run.attempt.id, 'abcdef12-2');
  assert.equal(run.learning.prediction, null);
  assert.equal(run.learning.explanation, null);
  assert.equal(run.learning.selfReview, null);
  assert.equal(run.experimentAt, null);
  run.learning.prediction = { answer: 'same', prior: true };
  startAttempt(run);
  run.result = { status: 'pass' };
  const report = buildArchive(run);
  assert.equal(report.attempts[0].result.status, 'fail');
  assert.equal(report.attempts[0].learning.explanation.observation, 'initial failure');
  assert.equal(report.learning.prediction.answer, 'same');
  assert.equal(report.result.status, 'pass');
});

test('atomic practice snapshots restore active learning and results across registry rebuilds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learning-save-'));
  const run = runFor();
  startAttempt(run);
  run.learning.prediction = { answer: 'up', reasoning: 'before restart' };
  const first = savePractice(run, directory);
  run.learning.explanation = { status: 'submitted', observation: 'saved observation' };
  run.result = { status: 'pass' };
  const second = savePractice(run, directory);
  await Promise.all([first, second]);
  const recovered = runFor();
  assert.equal(await restorePractice(recovered, directory), true);
  assert.equal(recovered.learning.prediction.reasoning, 'before restart');
  assert.equal(recovered.learning.explanation.observation, 'saved observation');
  assert.equal(recovered.result.status, 'pass');
  assert.equal(recovered.attempt.id, run.attempt.id);
  assert.ok(JSON.parse(await readFile(join(directory, 'practice-abcdef12.json'))));
});

test('interrupted attempts retain evidence and mismatched/corrupt saves are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learning-recovery-'));
  const run = runFor();
  startAttempt(run);
  await savePractice(run, directory);
  const recovered = runFor();
  await restorePractice(recovered, directory);
  assert.equal(recovered.attempt.interrupted, true);
  assert.equal(recovered.result, null);
  await writeFile(join(directory, 'practice-abcdef12.json'), JSON.stringify({ version: 1, run: run.id, lesson: 'shutdown' }));
  await assert.rejects(restorePractice(runFor(), directory), /identity/);
  await writeFile(join(directory, 'practice-abcdef12.json'), '{');
  await assert.rejects(restorePractice(runFor(), directory), /recovery failed/);
});
