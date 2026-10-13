import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './components/button.jsx';
import { Card, CardContent } from './components/card.jsx';
import { TimelineChart } from './components/timeline.jsx';
import { Diagram } from './components/diagram.jsx';
import { LESSONS, CHAPTERS, ACTION_DEFS, TIMELINE_HEADINGS, STEPS } from './lessons.js';
import { getJSON, postJSON, downloadBlob } from './api.js';

const byId = Object.fromEntries(LESSONS.map((l) => [l.id, l]));
const catalogIndex = Object.fromEntries(LESSONS.map((l, i) => [l.id, i]));
const LESSON_IDS = new Set(LESSONS.map((l) => l.id));

function shortPod(v) {
  if (!v) return '?';
  const parts = String(v).split('-');
  return `…${parts[parts.length - 1]}`;
}

function storedLesson() {
  try {
    const v = localStorage.getItem('scaling-lab.lesson');
    if (v && LESSON_IDS.has(v)) return v;
  } catch { /* private mode */ }
  return LESSONS[0].id;
}

export default function App() {
  const [selectedId, setSelectedId] = useState(storedLesson);
  const [state, setState] = useState(null);
  const [cluster, setCluster] = useState(null);
  const [flow, setFlow] = useState({ active: null, migration: null, history: [] });
  const [runDetail, setRunDetail] = useState(null);
  const [runCluster, setRunCluster] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [grafana, setGrafana] = useState(null);
  const [monitorView, setMonitorView] = useState('');
  const [mode, setMode] = useState('graceful');
  const [capWork, setCapWork] = useState('cheap');
  const [capP95, setCapP95] = useState(500);
  const [capErr, setCapErr] = useState(5);
  const [hpaPredict, setHpaPredict] = useState(4);
  const [capMix, setCapMix] = useState('balanced');
  const [capMin, setCapMin] = useState(2);
  const [capMax, setCapMax] = useState(5);
  const [capCpu, setCapCpu] = useState(60);
  const [capRationale, setCapRationale] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [guess, setGuess] = useState(null);
  const [quizPick, setQuizPick] = useState(null);
  const [predReason, setPredReason] = useState('');
  const [expObs, setExpObs] = useState('');
  const [expEv, setExpEv] = useState('');
  const [expInterp, setExpInterp] = useState('');
  const [expNext, setExpNext] = useState('');
  const [modelText, setModelText] = useState('');
  const hydratedAttempt = useRef(null);
  const [evidence, setEvidence] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [switchTarget, setSwitchTarget] = useState(null);

  const lesson = byId[selectedId] || LESSONS[0];
  const active = flow.active || null;
  const isActiveLesson = Boolean(active && active.lesson === lesson.id);
  const activeRunId = isActiveLesson ? active.runId : null;
  const activeRun = useMemo(
    () => (state?.runs || []).find((r) => r.id === activeRunId) || null,
    [state, activeRunId],
  );

  const select = useCallback((id) => {
    if (!LESSON_IDS.has(id)) return;
    setSelectedId(id);
    try { localStorage.setItem('scaling-lab.lesson', id); } catch { /* ignore */ }
    setRunDetail(null);
    setRunCluster(null);
    setTimeline(null);
    setEvidence(null);
    setGuess(null);
    setQuizPick(null);
    setPredReason('');
    setExpObs('');
    setExpEv('');
    setExpInterp('');
    setExpNext('');
    setModelText('');
    hydratedAttempt.current = null;
    setSwitchTarget(null);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [s, c, f] = await Promise.all([
        getJSON('/api/state'),
        getJSON('/api/cluster').catch(() => null),
        getJSON('/api/lesson').catch(() => null),
      ]);
      setState(s);
      if (c) setCluster(c);
      if (f) setFlow({ active: f.active || null, migration: f.migration || null, history: f.history || [] });
    } catch (e) {
      setNotice(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 4000);
    return () => clearInterval(t);
  }, [refreshAll]);

  useEffect(() => setMonitorView(''), [activeRunId]);

  useEffect(() => {
    if (!activeRunId) {
      setRunDetail(null);
      setRunCluster(null);
      setTimeline(null);
      setGrafana(null);
      setEvidence(null);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const [d, rc, tl, g, ev] = await Promise.all([
          getJSON(`/api/runs/${activeRunId}`).catch(() => null),
          getJSON(`/api/runs/${activeRunId}/cluster`).catch(() => null),
          getJSON(`/api/runs/${activeRunId}/timeline`).catch(() => null),
          getJSON(`/api/grafana?run=${activeRunId}${monitorView ? `&view=${monitorView}` : ''}`).catch(() => null),
          getJSON(`/api/evidence?run=${activeRunId}`).catch(() => null),
        ]);
        if (stop) return;
        if (d) setRunDetail(d);
        if (rc) setRunCluster(rc);
        if (tl) setTimeline(tl);
        if (g) setGrafana(g);
        if (ev) setEvidence(ev);
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [activeRunId, monitorView]);

  // Hydrate once per attempt, rather than on every poll (which would erase
  // edits in progress). Refresh/restart restores submitted learner work.
  useEffect(() => {
    if (!activeRunId || !runDetail || runDetail.id !== activeRunId) return;
    const key = `${activeRunId}:${runDetail.attempt?.id || 'initial'}`;
    if (hydratedAttempt.current === key) return;
    hydratedAttempt.current = key;
    setGuess(runDetail.prediction?.answer || null);
    setPredReason(runDetail.prediction?.reasoning || '');
    setExpObs(runDetail.explanation?.observation || '');
    setExpEv(runDetail.explanation?.evidence || '');
    setExpInterp(runDetail.explanation?.interpretation || '');
    setExpNext(runDetail.explanation?.nextAction || '');
    setModelText(runDetail.modelExplanation || '');
  }, [activeRunId, runDetail]);

  const startLesson = async (id) => {
    setBusy('Starting lesson…');
    setNotice('');
    try {
      const out = await postJSON('/api/lesson/start', { lesson: id });
      setNotice(`Starting ${id}: preparing environment (${out.run}).`);
    } catch (e) {
      setNotice(`Start failed: ${e.message}`);
    } finally {
      setBusy('');
      refreshAll();
    }
  };

  const endLesson = async () => {
    setBusy('Ending lesson…');
    try {
      await postJSON('/api/lesson/end', {});
      setNotice('Ending: traffic stops, evidence saves, the environment is removed.');
    } catch (e) {
      setNotice(`End failed: ${e.message}`);
    } finally {
      setBusy('');
      refreshAll();
    }
  };

  const confirmSwitch = async () => {
    if (!switchTarget) return;
    setBusy('Switching lessons…');
    try {
      await postJSON('/api/lesson/end', {});
      for (let i = 0; i < 90; i++) {
        await new Promise((x) => setTimeout(x, 2000));
        const f = await getJSON('/api/lesson').catch(() => null);
        if (f) setFlow({ active: f.active || null, migration: f.migration || null, history: f.history || [] });
        if (!f?.active) break;
      }
      // Open the destination preview. Never auto-start: the learner presses
      // Start lesson explicitly.
      select(switchTarget);
      setNotice('Previous environment ended with evidence saved. Press Start lesson when ready — nothing is provisioned yet.');
    } catch (e) {
      setNotice(`Switch failed: ${e.message}`);
    } finally {
      setBusy('');
      setSwitchTarget(null);
      refreshAll();
    }
  };

  const runScenario = async () => {
    if (!activeRunId) {
      setNotice('Start the lesson first — previewing never provisions.');
      return;
    }
    setBusy('Collecting evidence…');
    try {
      const body = { id: lesson.id, mode };
      if (lesson.id === 'capacity') {
        body.options = {
          work: capWork,
          sloP95Ms: Math.min(10000, Math.max(50, Number(capP95) || 500)),
          sloErrorPct: Math.min(50, Math.max(0, Number(capErr) || 0)),
        };
      }
      if (lesson.id === 'hpareact') {
        body.options = { predictDesired: Math.min(8, Math.max(2, Number(hpaPredict) || 4)) };
      }
      if (lesson.id === 'capstone') {
        body.options = {
          sloP95Ms: Math.min(5000, Math.max(100, Number(capP95) || 800)),
          sloErrorPct: Math.min(20, Math.max(0, Number(capErr) || 0)),
          mix: ['balanced', 'cpu-heavy', 'io-heavy'].includes(capMix) ? capMix : 'balanced',
          minReplicas: Math.min(5, Math.max(1, Math.round(Number(capMin)) || 2)),
          maxReplicas: Math.min(8, Math.max(1, Math.round(Number(capMax)) || 5)),
          cpuTarget: Math.min(90, Math.max(30, Math.round(Number(capCpu)) || 60)),
          rationale: String(capRationale || '').slice(0, 500),
        };
      }
      await postJSON(`/api/runs/${activeRunId}/run`, body);
      setNotice('Scenario running…');
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action) => {
    if (!activeRunId) {
      setNotice('Start the lesson first.');
      return;
    }
    setBusy(`Running ${action}…`);
    try {
      const payload = { action };
      if (action === 'start-long') payload.mode = mode;
      const out = await postJSON(`/api/runs/${activeRunId}/actions`, payload);
      setNotice(`${action}: ${JSON.stringify(out).slice(0, 160)}`);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy('');
      refreshAll();
    }
  };

  const downloadEvidence = async (id) => {
    try {
      const data = await getJSON(id ? `/api/evidence?run=${id}` : '/api/evidence');
      downloadBlob(`scaling-lab-evidence-${id || 'legacy'}-${Date.now()}.json`, data);
    } catch (e) {
      setNotice(e.message);
    }
  };

  const refreshRunDetail = async () => {
    if (!activeRunId) return;
    try {
      const d = await getJSON(`/api/runs/${activeRunId}`).catch(() => null);
      if (d) {
        setRunDetail(d);
        if (d.prediction?.answer) setGuess(d.prediction.answer);
      }
    } catch { /* keep last */ }
  };

  const prepareNextAttempt = async () => {
    try {
      await postJSON('/api/attempt', { run: activeRunId });
      await refreshRunDetail();
      setNotice('New attempt prepared. Record your next prediction before running. Previous results remain in the evidence export.');
    } catch (e) { setNotice(e.message); }
  };

  const predict = async (g) => {
    try {
      const out = await postJSON('/api/predict', { guess: g, reasoning: predReason, lesson: lesson.id, run: activeRunId || undefined });
      setGuess(g);
      setNotice(out.prior === false ? 'Recorded after the experiment — kept with the attempt, not labeled a prior prediction.' : 'Predicted. Observe, then reveal the model explanation.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const skipPrediction = async () => {
    try {
      await postJSON('/api/predict', { skip: true, reasoning: predReason, lesson: lesson.id, run: activeRunId || undefined });
      setGuess(null);
      setNotice('Prediction skipped — recorded as skipped for this attempt.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const reveal = async () => {
    try {
      const out = await postJSON('/api/reveal', { lesson: lesson.id, run: activeRunId || undefined });
      setModelText(out.explanation);
      setNotice('Model explanation shown. It does not complete Explain — submit your own explanation below.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const submitExplanation = async () => {
    if (!activeRunId) {
      setNotice('Start the lesson first.');
      return;
    }
    try {
      await postJSON('/api/explain', { run: activeRunId, observation: expObs, evidence: expEv, interpretation: expInterp, nextAction: expNext });
      setNotice('Explanation submitted. Compare it with the model explanation in self-review.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const skipExplanation = async () => {
    if (!activeRunId) {
      setNotice('Start the lesson first.');
      return;
    }
    try {
      await postJSON('/api/explain', { run: activeRunId, skip: true });
      setNotice('Explanation skipped — recorded as skipped for this attempt.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const completeSelfReview = async () => {
    if (!activeRunId) {
      setNotice('Start the lesson first.');
      return;
    }
    try {
      const out = await postJSON('/api/self-review', { run: activeRunId });
      setModelText(out.modelExplanation || '');
      setNotice('Self-review recorded. Revising keeps your initial response.');
      refreshRunDetail();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const loadAction = async (action, profile) => {
    if (!activeRunId) {
      setNotice('Start the lesson first.');
      return;
    }
    try {
      const fallback = lesson.id === 'autoscale' || lesson.id === 'hpareact' ? 'steady' : lesson.id === 'capacity' ? (capWork === 'expensive' ? 'expensive' : 'cheap') : 'steady';
      await postJSON(`/api/runs/${activeRunId}/load`, { action, profile: profile || fallback, durationMs: 180000 });
      setNotice(`Load ${action}.`);
    } catch (e) {
      setNotice(e.message);
    }
  };

  const migrate = async (action, id) => {
    setBusy(`${action === 'resume' ? 'Resuming' : 'Ending'} ${id}…`);
    try {
      const out = await postJSON('/api/lesson/migrate', { action, id });
      setNotice(action === 'resume' ? `Resumed ${out.resumed} as the single active lesson.` : `Ended ${out.ended}; evidence retained.`);
    } catch (e) {
      setNotice(`Migration failed: ${e.message}`);
    } finally {
      setBusy('');
      refreshAll();
    }
  };

  const pods = runCluster?.connected ? runCluster.pods : cluster?.pods || [];
  const endpoints = runCluster?.connected ? runCluster.endpoints : cluster?.endpoints || [];
  const stats = runDetail?.statusStats || null;
  const appliedMode = activeRun?.mode || runDetail?.events?.findLast((event) => event.type === 'app-signal' && event.data?.mode)?.data.mode;
  const events = runDetail?.events || [];
  const points = (timeline?.points || []).slice(-180);
  const failures = (timeline?.milestones || []).filter((m) => m.kind === 'failure');
  const checks = evidence?.result?.checks || null;
  const verdict = evidence?.result?.status || activeRun?.resultStatus || null;
  const history = flow.history || [];
  const runUnavailable = Boolean(busy || !activeRun || activeRun.status !== 'ready' || activeRun.actionRunning || activeRun.scenarioRunning);
  const defs = ACTION_DEFS[lesson.id] || [];
  // Progress states stay distinct: the experiment verdict never depends on
  // the prediction, revealing the model answer never completes Explain, and
  // a submission is never labeled mastered/correct/graded.
  const prediction = runDetail?.prediction || null;
  const explanation = runDetail?.explanation || null;
  const selfReview = runDetail?.selfReview || null;
  const modelRevealed = Boolean(runDetail?.modelRevealed);
  const predLabel = !prediction ? 'not recorded'
    : prediction.status === 'skipped' ? `skipped ${new Date(prediction.at).toLocaleTimeString()}`
    : `recorded ${new Date(prediction.at).toLocaleTimeString()} · ${prediction.prior ? 'prior prediction' : 'recorded after observation — not a prior prediction'}`;
  const explLabel = !explanation ? 'not submitted'
    : explanation.status === 'skipped' ? `skipped ${new Date(explanation.at).toLocaleTimeString()}`
    : `submitted ${new Date(explanation.at).toLocaleTimeString()}${explanation.revision > 1 ? ` · revision ${explanation.revision} (initial preserved)` : ''}`;
  const done = {
    baseline: activeRun?.status === 'ready',
    predict: Boolean(prediction),
    act: Boolean(activeRun?.scenario || (activeRun?.actions || 0) > 0 || (activeRun?.load?.total || 0) > 0),
    observe: Boolean(runDetail?.observed),
    explain: Boolean(explanation),
    checks: Boolean(activeRun?.resultStatus),
  };
  const nextLesson = lesson.next ? byId[lesson.next] : null;
  const showPractice = isActiveLesson && active.status === 'ready';
  const showStatus = isActiveLesson && active.status !== 'ready';

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/10 bg-[#112a22] text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div className="flex items-center gap-2 text-sm font-bold tracking-widest">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-lime-300 text-green-900">↗</span>
          SCALING LAB <span className="ml-3 hidden text-xs font-normal tracking-normal text-white/45 md:inline">Interactive systems lab</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-white/60">
          <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${cluster?.connected ? 'bg-emerald-400' : 'bg-slate-400'}`} />{cluster?.connected ? 'Cluster connected' : 'Connecting…'}</span>
          <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-slate-400'}`} />{active ? `Lesson active: ${byId[active.lesson]?.title || active.lesson}` : 'No active lesson'}</span>
          <button className="rounded-md border border-white/15 px-2.5 py-1.5 transition-colors hover:bg-white/10" onClick={() => setSidebarOpen((v) => !v)} aria-expanded={sidebarOpen}>
            {sidebarOpen ? 'Hide lessons' : 'Show lessons'}
          </button>
          <a className="underline" href="/worksheet">Worksheet</a>
        </div>
        </div>
      </header>

      <div className={`mx-auto grid max-w-7xl gap-4 p-4 ${sidebarOpen ? 'lg:grid-cols-[240px_minmax(0,1fr)_340px]' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
        {sidebarOpen && (
        <aside className="min-w-0 space-y-3">
          <p className="font-mono text-[10px] tracking-widest text-muted-foreground">LEARNING PATH / {String(LESSONS.length).padStart(2, '0')}</p>
          {CHAPTERS.map((ch) => (
            <div key={ch.id} className="space-y-1">
              <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{ch.title}</p>
              {ch.lessons.map((id) => {
                const l = byId[id];
                if (!l) return null;
                const n = String((catalogIndex[id] ?? 0) + 1).padStart(2, '0');
                const isSel = id === selectedId;
                const isLive = active?.lesson === id;
                return (
                  <button
                    key={id}
                    onClick={() => select(id)}
                    aria-current={isSel ? 'page' : undefined}
                    className={`flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm ${isSel ? 'border-primary bg-secondary font-semibold' : 'bg-background hover:bg-muted'}`}
                  >
                    <span className="font-mono text-xs text-muted-foreground">{n}</span>
                    <span className="min-w-0 flex-1">{l.title}</span>
                    {isLive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="Active lesson" />}
                  </button>
                );
              })}
            </div>
          ))}
          <Card><CardContent><p className="text-xs text-muted-foreground">One lesson at a time. Selecting a lesson only previews it — <strong>Start lesson</strong> provisions its isolated environment on <code>kind-scaling-lab</code>.</p></CardContent></Card>
        </aside>
        )}

        <section className="min-w-0 space-y-4">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground">LESSON {String((catalogIndex[lesson.id] ?? 0) + 1).padStart(2, '0')} / {String(LESSONS.length).padStart(2, '0')} · {lesson.time}</p>
            <h1 className="text-3xl font-semibold tracking-tight">{lesson.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{lesson.intro}</p>
          </div>

          <Card><CardContent className="space-y-1">
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground">THE IDEA</p>
            <p className="text-sm">{lesson.concept}</p>
          </CardContent></Card>

          <Diagram lessonId={lesson.id} />

          {flow.migration && (
          <Card><CardContent className="space-y-3">
            <h3 className="text-sm font-semibold">Inherited environments need a choice</h3>
            <p className="text-sm text-muted-foreground">A previous version left {flow.migration.runs.length} environments behind. Nothing is deleted silently: resume the last one, or end each explicitly (evidence is saved first).</p>
            {flow.migration.runs.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <span className="font-mono text-xs">{r.id}</span>
                <span className="text-muted-foreground">{byId[r.lesson]?.title || r.lesson} · {r.status}</span>
                <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => migrate('resume', r.id)}>Resume</Button>
                <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => migrate('end', r.id)}>End + save evidence</Button>
              </div>
            ))}
            {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
          </CardContent></Card>
          )}

          {!isActiveLesson && (
          <Card><CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Preview — nothing is provisioned yet</h3>
              <span className="font-mono text-[10px] text-muted-foreground">00 / PREVIEW</span>
            </div>
            <p className="text-sm"><strong>Objective:</strong> {lesson.objective}</p>
            <p className="text-sm text-muted-foreground"><strong>Prerequisite:</strong> {lesson.prereq}</p>
            <p className="text-sm text-muted-foreground"><strong>Coming in with:</strong> {lesson.prevQ}</p>
            <p className="text-sm text-muted-foreground">{lesson.task}</p>
            <div className="flex flex-wrap items-center gap-2">
              {!active && <Button disabled={Boolean(busy || flow.migration)} onClick={() => startLesson(lesson.id)}>{busy === 'Starting lesson…' ? 'Starting…' : 'Start lesson →'}</Button>}
              {active && <Button variant="outline" disabled={Boolean(busy)} onClick={() => setSwitchTarget(lesson.id)}>Switch from “{byId[active.lesson]?.title || active.lesson}”…</Button>}
              {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
            </div>
            {active && <p className="text-xs text-muted-foreground">“{byId[active.lesson]?.title || active.lesson}” currently holds the single environment ({active.status}). Switching asks first: traffic stops, results save, its environment is removed — cancel leaves everything untouched.</p>}
            {notice && <p className="rounded-md bg-muted p-2 text-xs">{notice}</p>}
          </CardContent></Card>
          )}

          {switchTarget && active && (
          <Card><CardContent className="space-y-3">
            <h3 className="text-sm font-semibold">End “{byId[active.lesson]?.title || active.lesson}” and open “{byId[switchTarget]?.title}”?</h3>
            <p className="text-sm text-muted-foreground">Ending stops traffic and cancels in-progress work safely, saves results, and deletes only <code>{active.runId ? `scaling-run-${active.runId}` : 'its environment'}</code>. The destination opens as a preview — it will <strong>not</strong> start automatically.</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy)} onClick={confirmSwitch}>{busy === 'Switching lessons…' ? 'Switching…' : 'End current + open preview'}</Button>
              <Button variant="outline" disabled={Boolean(busy)} onClick={() => setSwitchTarget(null)}>Cancel (leave everything untouched)</Button>
            </div>
          </CardContent></Card>
          )}

          {showStatus && (
          <Card><CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Lesson {active.status === 'failed' ? 'failed to start' : active.status === 'cleanup-failed' ? 'cleanup failed — allocation retained' : active.status === 'ending' ? 'ending…' : 'starting…'}</h3>
              <span className="font-mono text-[10px] text-muted-foreground">01 / LIFECYCLE</span>
            </div>
            <div className="space-y-1">
              {(active.stages || []).map((s, i) => (
                <p key={i} className="font-mono text-[11px] text-muted-foreground">{new Date(s.at).toLocaleTimeString()} <strong>{s.stage}</strong> {s.detail}</p>
              ))}
            </div>
            {active.error && <p className="rounded-md bg-red-50 p-2 text-xs text-red-700" role="alert">{active.error}</p>}
            <div className="flex flex-wrap gap-2">
              {(active.status === 'cleanup-failed') && <Button disabled={Boolean(busy)} onClick={endLesson}>Retry end</Button>}
              {(active.status === 'failed') && <Button disabled={Boolean(busy)} onClick={() => startLesson(active.lesson)}>Retry start</Button>}
              {(active.status === 'starting' || active.status === 'ending') && <Button variant="outline" disabled={Boolean(busy)} onClick={endLesson}>End now</Button>}
              {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
            </div>
            {notice && <p className="rounded-md bg-muted p-2 text-xs">{notice}</p>}
          </CardContent></Card>
          )}

          {showPractice && (
          <Card><CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Run the experiment</h3>
              <span className="font-mono text-[10px] text-muted-foreground">02 / OBSERVE</span>
            </div>
            <p className="text-sm text-muted-foreground">{lesson.task}</p>
            {lesson.id === 'capacity' && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-2 text-sm">
                <label className="flex items-center gap-2">Work
                  <select value={capWork} onChange={(e) => setCapWork(e.target.value)} className="rounded-md border p-1 text-sm">
                    <option value="cheap">Cheap (/fast)</option>
                    <option value="expensive">Expensive (/cpu 250ms)</option>
                  </select>
                </label>
              </div>
            )}
            {(lesson.id === 'capacity' || lesson.id === 'capstone') && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-2 text-sm">
                <label className="flex items-center gap-2">Objective p95 ≤
                  <input value={capP95} onChange={(e) => setCapP95(e.target.value)} inputMode="numeric" className="w-20 rounded-md border p-1 text-sm" aria-label="Objective p95 milliseconds" /> ms
                </label>
                <label className="flex items-center gap-2">errors ≤
                  <input value={capErr} onChange={(e) => setCapErr(e.target.value)} inputMode="decimal" className="w-16 rounded-md border p-1 text-sm" aria-label="Objective error percent" /> %
                </label>
                {lesson.id === 'capstone' && (
                <label className="flex items-center gap-2">Traffic mix
                  <select value={capMix} onChange={(e) => setCapMix(e.target.value)} className="rounded-md border p-1 text-sm">
                    <option value="balanced">Balanced (/fast)</option>
                    <option value="cpu-heavy">CPU-heavy</option>
                    <option value="io-heavy">I/O-heavy</option>
                  </select>
                </label>
                )}
                {lesson.id === 'capstone' && (
                <label className="flex items-center gap-2">Min replicas
                  <input value={capMin} onChange={(e) => setCapMin(e.target.value)} inputMode="numeric" min={1} max={5} className="w-16 rounded-md border p-1 text-sm" aria-label="Capstone minimum replicas" />
                </label>
                )}
                {lesson.id === 'capstone' && (
                <label className="flex items-center gap-2">Max replicas
                  <input value={capMax} onChange={(e) => setCapMax(e.target.value)} inputMode="numeric" min={1} max={8} className="w-16 rounded-md border p-1 text-sm" aria-label="Capstone maximum replicas" />
                </label>
                )}
                {lesson.id === 'capstone' && (
                <label className="flex items-center gap-2">CPU target
                  <input value={capCpu} onChange={(e) => setCapCpu(e.target.value)} inputMode="numeric" min={30} max={90} className="w-16 rounded-md border p-1 text-sm" aria-label="Capstone CPU target percent" /> %
                </label>
                )}
              </div>
            )}
            {lesson.id === 'capstone' && (
              <div className="rounded-md border bg-muted/40 p-2 text-sm">
                <label className="block">Rationale (required, ≤500 chars): why do these HPA bounds fit the objective?
                  <textarea value={capRationale} onChange={(e) => setCapRationale(e.target.value)} rows={2} maxLength={500} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm text-foreground" placeholder="e.g. min 2 holds warm headroom for the burst; max 5 caps laptop load; 60% leaves scale room." aria-label="Capstone rationale" />
                </label>
              </div>
            )}
            {lesson.id === 'shutdown' && (
              <label className="flex flex-wrap items-center gap-2 text-sm">Next request mode
                <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-md border p-1 text-sm">
                  <option value="graceful">Graceful</option>
                  <option value="abrupt">Abrupt (failure demonstration)</option>
                </select>
                {appliedMode && <span className="text-xs text-muted-foreground">Last applied: {appliedMode}</span>}
              </label>
            )}
            {lesson.id === 'hpareact' && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-2 text-sm">
                <label className="flex items-center gap-2">Predicted desired replicas
                  <input value={hpaPredict} onChange={(e) => setHpaPredict(e.target.value)} inputMode="numeric" className="w-16 rounded-md border p-1 text-sm" aria-label="Predicted desired replicas" />
                </label>
                <span className="text-xs text-muted-foreground">Formula: ceil(replicas × observed ÷ target), ±1 counts as agreement.</span>
              </div>
            )}
            <div className="space-y-2 rounded-md border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Attempt {runDetail?.attempt?.id || '1'} · {(runDetail?.attemptCount || 1) - 1} previous attempts retained</span>
                {runDetail?.observed && <Button variant="outline" size="sm" disabled={runUnavailable || activeRun?.load?.active || activeRun?.hasPendingLong} onClick={prepareNextAttempt}>Prepare next attempt</Button>}
              </div>
              <p className="text-sm"><strong>Predict first:</strong> {lesson.predict}</p>
              <div className="flex flex-wrap gap-2">
                {lesson.guesses.map(([v, label]) => (
                  <Button key={v} variant={guess === v || prediction?.answer === v ? 'default' : 'outline'} size="sm" onClick={() => predict(v)}>{label}</Button>
                ))}
                <Button variant="ghost" size="sm" onClick={skipPrediction}>Skip prediction</Button>
              </div>
              <label className="block text-xs text-muted-foreground">Reasoning (short, saved with this attempt)
                <textarea aria-label="Reasoning (short, saved with this attempt)" value={predReason} onChange={(e) => setPredReason(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm text-foreground" placeholder="What do you expect, and why?" />
              </label>
              <p className="text-xs text-muted-foreground">Prediction: {predLabel}. An incorrect prediction never fails the experiment.</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {STEPS.map((s) => (
                <span key={s} className={`rounded-full border px-2 py-1 font-mono text-[10px] ${done[s] ? 'border-green-600 bg-green-50 text-green-800' : 'text-muted-foreground'}`}>{s}</span>
              ))}
              <span className={`rounded-full border px-2 py-1 font-mono text-[10px] ${selfReview?.done ? 'border-green-600 bg-green-50 text-green-800' : 'text-muted-foreground'}`} title="Self-review is done only after you submit or skip your explanation">self-review{selfReview?.done ? ' ✓' : ''}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={runUnavailable && !busy} onClick={runScenario}>Run + verify →</Button>
              <Button variant="outline" disabled={Boolean(busy)} onClick={endLesson}>End lesson</Button>
              {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
            </div>
            {defs.length > 0 && (
              <div className="space-y-2 border-t pt-2">
                <h4 className="text-sm font-semibold">Guided actions</h4>
                <p className="text-xs text-muted-foreground">Small steps you can run and inspect before the one-click verifier.</p>
                <div className="flex flex-wrap gap-2">
                  {defs.map(([v, label]) => (
                    <Button key={v} variant="outline" size="sm" disabled={runUnavailable || (v === 'terminate-serving' ? !activeRun?.hasPendingLong : activeRun?.hasPendingLong)} onClick={() => runAction(v)}>{busy === `Running ${v}…` ? `${label}…` : label}</Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2 border-t pt-2">
              <p className="font-mono text-[11px] text-muted-foreground">
                {activeRun ? `environment scaling-run-${activeRun.id} · ${activeRun.status} · ${pods.filter((p) => p.ready && !p.terminating).length} Ready pods` : 'Environment ready.'}
              </p>
              {activeRun?.appUrl && (
                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold">Browser access</h4>
                    <a href={activeRun.appUrl} target="_blank" rel="noreferrer" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">Open app ↗</a>
                  </div>
                  <a href={activeRun.appUrl} target="_blank" rel="noreferrer" className="block break-all font-mono text-[11px] text-muted-foreground underline">{window.location.origin}{activeRun.appUrl}</a>
                  <p className="break-all text-[11px] text-muted-foreground">Routes to <code className="text-foreground">{activeRun.namespace}</code> · edge → app</p>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <a className="underline" href={`/app/${activeRun.id}/slow?ms=8000`} target="_blank" rel="noreferrer">8s request ↗</a>
                    <a className="underline" href={`/app/${activeRun.id}/stream`} target="_blank" rel="noreferrer">Stream ↗</a>
                    <a className="underline" href={`/app/${activeRun.id}/metrics`} target="_blank" rel="noreferrer">Metrics ↗</a>
                    <a className="underline" href={`/app/${activeRun.id}/health/ready`} target="_blank" rel="noreferrer">Readiness ↗</a>
                  </div>
                  <p className="text-[11px] text-muted-foreground">These links send requests to this lesson. No terminal setup needed.</p>
                </div>
              )}
              <p className="text-xs text-green-700">
                One lesson at a time · {(activeRun?.resources?.appReplicas ?? 2)} app pods (100m CPU / 64Mi each) + 1 edge pod in this environment.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => downloadEvidence(activeRunId)}>Download evidence</Button>
              </div>
            </div>
            {(lesson.id === 'prometheus' || lesson.id === 'autoscale' || lesson.id === 'capacity' || lesson.id === 'hpareact' || lesson.id === 'resources' || lesson.id === 'signals' || lesson.id === 'downstream' || lesson.id === 'gateway') && (
              <div className="space-y-2 border-t pt-2">
                <h4 className="text-sm font-semibold">Manual traffic</h4>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={runUnavailable || activeRun?.hasPendingLong || activeRun?.load?.active} onClick={() => loadAction('start')}>Start</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !activeRun?.load?.active} onClick={() => loadAction('increase')}>Increase</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !activeRun?.load?.active} onClick={() => loadAction('decrease')}>Decrease</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !activeRun?.load?.active} onClick={() => loadAction('stop')}>Stop</Button>
                </div>
                <p className="text-xs text-muted-foreground">{activeRun?.load?.active ? `${activeRun.load.profile} · target ${activeRun.load.targetRps} req/s · total ${activeRun.load.total}` : 'Manual load idle.'}</p>
              </div>
            )}
            {notice && <p className="rounded-md bg-muted p-2 text-xs">{notice}</p>}
          </CardContent></Card>
          )}

          {showPractice && (
          <Card><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Verification</h3>
              <span className="font-mono text-[10px] text-muted-foreground">03 / CHECK</span>
            </div>
            {!verdict ? <p className="text-sm text-muted-foreground">Run the experiment to see evidence and checks.</p> : (
              <div>
                <p className="text-sm font-semibold uppercase">{verdict}</p>
                {checks?.map((c, i) => (
                  <p key={i} className="text-sm"><b className={c.pass ? 'text-green-700' : 'text-red-700'}>{c.pass ? '✓' : '✕'}</b> {c.label}</p>
                ))}
                <details className="mt-2 text-xs"><summary className="cursor-pointer">Show raw evidence</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">{JSON.stringify(evidence?.result?.evidence || {}, null, 2)}</pre>
                </details>
              </div>
            )}
          </CardContent></Card>
          )}

          {showPractice && (
          <Card><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Explain with evidence</h3>
              <span className="font-mono text-[10px] text-muted-foreground">04 / EXPLAIN</span>
            </div>
            <p className="text-xs text-muted-foreground">Saved with this attempt, included in evidence export and History. A submission is your work — it is never auto-graded or labeled mastered/correct.</p>
            <label className="block text-sm">Observation
              <textarea aria-label="Observation" value={expObs} onChange={(e) => setExpObs(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm" placeholder="What changed, and when?" />
            </label>
            <label className="block text-sm">Cited evidence (metric, phase, or event)
              <textarea aria-label="Cited evidence (metric, phase, or event)" value={expEv} onChange={(e) => setExpEv(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm" placeholder="Which timeline point, check, or event supports it?" />
            </label>
            <label className="block text-sm">Interpretation
              <textarea aria-label="Interpretation" value={expInterp} onChange={(e) => setExpInterp(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm" placeholder="Why does the evidence mean that?" />
            </label>
            <label className="block text-sm">Proposed next action
              <textarea aria-label="Proposed next action" value={expNext} onChange={(e) => setExpNext(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded-md border bg-card p-1.5 text-sm" placeholder="What would you measure or change next?" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={submitExplanation}>Submit explanation</Button>
              <Button variant="ghost" size="sm" onClick={skipExplanation}>Skip explanation</Button>
              <Button variant="outline" size="sm" onClick={reveal}>Reveal model explanation</Button>
            </div>
            <p className="text-xs text-muted-foreground">Explanation: {explLabel}. Revealing the model answer does not submit yours.</p>
            {(modelText || modelRevealed) && (
              <div className="space-y-1 rounded-md border bg-muted/40 p-2">
                <p className="text-xs font-semibold">Model explanation (reference, not a grade)</p>
                <p className="text-sm">{modelText || runDetail?.modelExplanation || ''}</p>
              </div>
            )}
            {explanation && (
              <div className="space-y-1 rounded-md border p-2">
                <p className="text-xs font-semibold">Self-review — compare your explanation against these criteria, then mark done</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">
                  {(runDetail?.rubric || []).map((c, i) => <li key={i}>{c}</li>)}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={completeSelfReview}>Mark self-review done</Button>
                  {selfReview?.done && <span className="text-xs text-green-700">Self-review done {new Date(selfReview.at).toLocaleTimeString()}. Revising above keeps your initial response.</span>}
                </div>
              </div>
            )}
            <div className="space-y-2 border-t pt-2">
              <p className="text-sm font-semibold">Check your understanding</p>
              <p className="text-sm">{lesson.quiz}</p>
            <div className="flex flex-wrap gap-2">
              {lesson.answers.map((a, i) => (
                <Button key={i} variant={quizPick === i ? (i === lesson.correct ? 'default' : 'outline') : 'outline'} size="sm" onClick={() => setQuizPick(i)}>{a}</Button>
              ))}
            </div>
            {quizPick != null && <p className="text-xs text-muted-foreground">{quizPick === lesson.correct ? 'Correct. ' : 'Try again. '}{lesson.why}</p>}
            </div>
          </CardContent></Card>
          )}

          <Card><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Learning path</h3>
              <span className="font-mono text-[10px] text-muted-foreground">05 / PATH</span>
            </div>
            <p className="text-sm"><strong>Take away:</strong> {lesson.takeaway}</p>
            {nextLesson
              ? <p className="text-sm text-muted-foreground"><strong>Next:</strong> {nextLesson.title} — <button className="underline" onClick={() => select(nextLesson.id)}>open its preview →</button></p>
              : <p className="text-sm text-muted-foreground"><strong>Next:</strong> you completed the path — revisit any lesson or export evidence above.</p>}
            {lesson.reading && (
              <div className="space-y-1 border-t pt-2">
                <p className="text-sm"><a className="underline" href={lesson.reading.url} target="_blank" rel="noreferrer">{lesson.reading.title} ↗</a></p>
                <p className="text-sm"><strong>Reflect:</strong> {lesson.reflect}</p>
              </div>
            )}
          </CardContent></Card>

          <Card id="history"><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">History (read-only)</h3>
              <span className="font-mono text-[10px] text-muted-foreground">{history.length} saved</span>
            </div>
            {history.length ? (
              <div className="max-h-48 space-y-1 overflow-auto">
                {history.map((h) => (
                  <div key={h.run} className="space-y-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{h.run}</span>
                    <span className="text-muted-foreground">{byId[h.lesson]?.title || h.lesson}</span>
                    <span className={`font-semibold ${h.status === 'pass' ? 'text-green-700' : h.status === 'fail' ? 'text-red-700' : 'text-muted-foreground'}`}>{h.status}{h.ended && h.ended !== 'completed' ? ` · ${h.ended}` : ''}</span>
                    <span className="text-muted-foreground">
                      prediction {h.prediction ? `${h.prediction.status}${h.prediction.prior === false ? ' (after observation)' : ''}` : 'unavailable'}
                      {' · '}explanation {h.explanation ? h.explanation.status : 'unavailable'}
                      {' · '}self-review {h.selfReview?.done ? 'done' : 'unavailable'}
                    </span>
                    <button className="underline" onClick={() => downloadEvidence(h.run)}>Evidence</button>
                  </div>
                  {(h.prediction || h.explanation) && <details className="rounded border p-2">
                    <summary className="cursor-pointer">Read saved learning</summary>
                    {h.prediction && <p className="mt-2">Prediction: {h.prediction.answer || h.prediction.status} — {h.prediction.reasoning}</p>}
                    {h.explanation?.status === 'submitted' && <div className="mt-2 space-y-1 whitespace-pre-wrap">
                      <p><strong>Observation:</strong> {h.explanation.observation}</p>
                      <p><strong>Evidence:</strong> {h.explanation.evidence}</p>
                      <p><strong>Interpretation:</strong> {h.explanation.interpretation}</p>
                      <p><strong>Next action:</strong> {h.explanation.nextAction}</p>
                    </div>}
                  </details>}
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-muted-foreground">Ended lessons keep readable results and downloadable evidence here, even after restart. Viewing history never provisions anything.</p>}
          </CardContent></Card>
        </section>

        <aside className="min-w-0 space-y-3">
          <Card className="border-0 bg-transparent shadow-none"><CardContent className="space-y-2 px-0">
            <h3 className="text-sm font-semibold">Live observation {activeRun?.load?.active ? '· LIVE' : '· IDLE'}</h3>
            {grafana?.available ? (
              <div className="space-y-2">
                <a className="text-xs underline" href={grafana.runUrl || grafana.dashboardUrl} target="_blank" rel="noreferrer">Open dashboard for this lesson ↗</a>
                {grafana.views && <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">Show
                  <select aria-label="Monitoring view" value={monitorView || grafana.view} onChange={(e) => setMonitorView(e.target.value)} className="max-w-full rounded-md border bg-card p-1.5 text-xs text-foreground">
                    {grafana.views.map((view) => <option key={view.id} value={view.id}>{view.label}</option>)}
                  </select>
                </label>}
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Monitoring integration is unavailable on this server (no <code>/api/grafana</code>). Use the manual path:</p>
                <pre className="overflow-auto rounded bg-muted p-2 font-mono text-[10px]">make grafana-up{'\n'}make grafana-ui  # http://127.0.0.1:3003</pre>
                <p className="text-xs text-muted-foreground">Login <code>admin</code> / <code>scaling-lab</code>, open “Scaling Lab · HTTP and pod lifecycle”.</p>
              </div>
            )}
            {grafana?.embedUrl && activeRunId && (
              <iframe title={`Grafana ${grafana.viewLabel || 'HTTP response metrics'} for selected lesson`} src={`${grafana.embedUrl}${grafana.embedUrl.includes('?') ? '&' : '?'}from=now-15m&to=now&refresh=5s`} className="h-64 w-full rounded border" loading="lazy" />
            )}
            {grafana?.available && activeRunId && <p className="text-[11px] leading-relaxed text-muted-foreground">
              {grafana.view === 'activity' ? 'Shows active requests, including long requests before they finish. Metrics update about every 5 seconds.' : grafana.view === 'responses' ? 'Shows completed responses on current pods. Counters reset when pods restart; a short response can finish between scrapes.' : 'Shows completed responses per second. An idle lesson has a zero rate; long requests appear after they finish.'}
              {' '}Interrupted responses and exact shutdown timing appear in the experiment trace.
            </p>}
            <div className="space-y-2 rounded-md border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold">Dashboard client outcomes</h4>
                <span className="font-mono text-[10px] text-muted-foreground">{stats?.total || 0} recorded</span>
              </div>
              {stats?.total ? <>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <p className="rounded bg-secondary px-2 py-1.5">Completed 2xx <strong className="float-right">{stats.ok2xx}</strong></p>
                  <p className="rounded bg-muted px-2 py-1.5">HTTP 4xx / 5xx <strong className="float-right">{stats.http4xx} / {stats.http5xx}</strong></p>
                  <p className={`rounded px-2 py-1.5 ${stats.interrupted ? 'bg-red-50 text-red-700' : 'bg-muted'}`}>Interrupted body <strong className="float-right">{stats.interrupted}</strong></p>
                  <p className={`rounded px-2 py-1.5 ${stats.transport ? 'bg-red-50 text-red-700' : 'bg-muted'}`}>No HTTP response <strong className="float-right">{stats.transport}</strong></p>
                </div>
                {(stats.recentErrors || []).slice(0, 3).map((outcome, i) => <p key={i} className="text-[11px] leading-relaxed text-red-700">
                  {outcome.status != null ? `HTTP ${outcome.status} headers` : 'No HTTP headers'} · {outcome.complete === false ? 'response interrupted' : 'HTTP error'}{outcome.error ? ` · ${outcome.error}` : ''}
                </p>)}
                {stats.interrupted > 0 && <p className="text-[11px] leading-relaxed text-muted-foreground">HTTP 200 headers can arrive before the response body is interrupted. An interrupted 200 is a failed request, not a completed success or an HTTP 500.</p>}
              </> : <p className="text-[11px] text-muted-foreground">Run a guided action to record client outcomes. Browser requests appear in Grafana.</p>}
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">APPLICATION PODS</p>
            {pods.length ? pods.map((p) => (
              <div key={p.name} className="font-mono text-[11px]" title={p.name}>{shortPod(p.name)} · {p.terminating ? 'terminating' : p.ready ? 'ready' : 'not ready'}</div>
            )) : <p className="text-xs text-muted-foreground">No application pods</p>}
          </CardContent></Card>

          <Card><CardContent className="space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">SERVICE ENDPOINTS</p>
            {endpoints.length ? endpoints.map((e, i) => (
              <div key={i} className="font-mono text-[11px]">{shortPod(e.pod)} · {e.terminating ? 'terminating' : e.ready ? 'ready' : 'not ready'}</div>
            )) : <p className="text-xs text-muted-foreground">—</p>}
          </CardContent></Card>

          <Card><CardContent className="space-y-2">
            <p className="font-mono text-[10px] text-muted-foreground">{TIMELINE_HEADINGS[lesson.id]}</p>
            <TimelineChart points={points} lesson={lesson.id} failures={failures} />
            <div className="max-h-48 space-y-1 overflow-auto">
              {events.slice(-30).reverse().map((ev, i) => (
                <p key={i} className="font-mono text-[10px] text-muted-foreground">
                  {new Date(ev.at).toLocaleTimeString()} <strong>{ev.type}</strong>{' '}
                  {['slow-end', 'stream-end', 'request'].includes(ev.type)
                    ? `${ev.data?.complete === false || ev.data?.ok === false ? 'Failed / interrupted' : 'Completed'}${ev.data?.status != null ? ` · HTTP ${ev.data.status}` : ''}${ev.data?.error ? ` · ${ev.data.error}` : ''} · ${shortPod(ev.data?.pod)}`
                    : ev.data?.pod ? shortPod(ev.data.pod) : ev.data?.text || ''}
                </p>
              ))}
            </div>
          </CardContent></Card>
        </aside>
      </div>
    </div>
  );
}
