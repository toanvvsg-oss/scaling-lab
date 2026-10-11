import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from './components/button.jsx';
import { Card, CardContent } from './components/card.jsx';
import { TimelineChart } from './components/timeline.jsx';
import { Diagram } from './components/diagram.jsx';
import { RunsPanel } from './components/runs-panel.jsx';
import { LESSONS, ACTION_DEFS, TIMELINE_HEADINGS, STEPS } from './lessons.js';
import { getJSON, postJSON, downloadBlob } from './api.js';

function shortPod(v) {
  if (!v) return '?';
  const parts = String(v).split('-');
  return `…${parts[parts.length - 1]}`;
}

export default function App() {
  const [lessonIdx, setLessonIdx] = useState(0);
  const [state, setState] = useState(null);
  const [cluster, setCluster] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [runDetail, setRunDetail] = useState(null);
  const [runCluster, setRunCluster] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [grafana, setGrafana] = useState(null);
  const [monitorView, setMonitorView] = useState('');
  const [mode, setMode] = useState('graceful');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [guess, setGuess] = useState(null);
  const [quizPick, setQuizPick] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const lesson = LESSONS[lessonIdx];
  const lessonRuns = useMemo(() => (state?.runs || []).filter((r) => r.lesson === lesson.id), [state, lesson]);
  const active = useMemo(() => (state?.runs || []).find((r) => r.id === selectedRun) || null, [state, selectedRun]);

  const refreshState = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([getJSON('/api/state'), getJSON('/api/cluster').catch(() => null)]);
      setState(s);
      if (c) setCluster(c);
      const live = (s.runs || []).filter((r) => r.lesson === LESSONS[lessonIdx].id && (r.status === 'ready' || r.status === 'creating'));
      if (!selectedRun || !(s.runs || []).some((r) => r.id === selectedRun && r.lesson === LESSONS[lessonIdx].id && r.status !== 'deleted')) {
        if (live.length) setSelectedRun(live[live.length - 1].id);
        else setSelectedRun(null);
      }
    } catch (e) {
      setNotice(String(e.message || e));
    }
  }, [lessonIdx, selectedRun]);

  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, 2500);
    return () => clearInterval(t);
  }, [refreshState]);

  useEffect(() => setMonitorView(''), [selectedRun]);

  useEffect(() => {
    if (!selectedRun) {
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
          getJSON(`/api/runs/${selectedRun}`).catch(() => null),
          getJSON(`/api/runs/${selectedRun}/cluster`).catch(() => null),
          getJSON(`/api/runs/${selectedRun}/timeline`).catch(() => null),
          getJSON(`/api/grafana?run=${selectedRun}${monitorView ? `&view=${monitorView}` : ''}`).catch(() => null),
          getJSON(`/api/evidence?run=${selectedRun}`).catch(() => null),
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
  }, [selectedRun, monitorView]);

  const createRun = async () => {
    setBusy('Creating run…');
    try {
      const { id } = await postJSON('/api/runs', { lesson: lesson.id });
      setSelectedRun(id);
      for (let i = 0; i < 24; i++) {
        await new Promise((x) => setTimeout(x, 5000));
        const s = await getJSON('/api/state');
        setState(s);
        const r = (s.runs || []).find((x) => x.id === id);
        if (r?.status === 'ready') break;
        if (r && r.status !== 'creating') throw new Error(r.error || 'run failed');
      }
      setNotice(`Run ${id} ready.`);
    } catch (e) {
      setNotice(`Run creation failed: ${e.message}`);
    } finally {
      setBusy('');
      refreshState();
    }
  };

  const runScenario = async () => {
    if (!selectedRun) {
      await createRun();
      return;
    }
    setBusy('Collecting evidence…');
    try {
      await postJSON(`/api/runs/${selectedRun}/run`, { id: lesson.id, mode });
      setNotice('Scenario running…');
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action) => {
    if (!selectedRun) {
      setNotice('Create a run first.');
      return;
    }
    setBusy(`Running ${action}…`);
    try {
      const payload = { action };
      if (action === 'start-long') payload.mode = mode;
      const out = await postJSON(`/api/runs/${selectedRun}/actions`, payload);
      setNotice(`${action}: ${JSON.stringify(out).slice(0, 160)}`);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy('');
      refreshState();
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

  const predict = async (g) => {
    try {
      await postJSON('/api/predict', { guess: g, lesson: lesson.id, run: selectedRun || undefined });
      setGuess(g);
      setNotice('Predicted. Observe, then reveal.');
    } catch (e) {
      setNotice(e.message);
    }
  };

  const reveal = async () => {
    try {
      const out = await postJSON('/api/reveal', { lesson: lesson.id, run: selectedRun || undefined });
      setNotice(out.explanation);
    } catch (e) {
      setNotice(e.message);
    }
  };

  const loadAction = async (action, profile) => {
    if (!selectedRun) {
      setNotice('Create a run first.');
      return;
    }
    try {
      await postJSON(`/api/runs/${selectedRun}/load`, { action, profile: profile || 'steady', durationMs: 180000 });
      setNotice(`Load ${action}.`);
    } catch (e) {
      setNotice(e.message);
    }
  };

  const pods = runCluster?.connected ? runCluster.pods : cluster?.pods || [];
  const endpoints = runCluster?.connected ? runCluster.endpoints : cluster?.endpoints || [];
  const stats = runDetail?.statusStats || null;
  const appliedMode = active?.mode || runDetail?.events?.findLast((event) => event.type === 'app-signal' && event.data?.mode)?.data.mode;
  const events = runDetail?.events || [];
  const points = (timeline?.points || []).slice(-180);
  const failures = (timeline?.milestones || []).filter((m) => m.kind === 'failure');
  const checks = evidence?.result?.checks || null;
  const verdict = evidence?.result?.status || active?.resultStatus || null;
  const archived = state?.archivedRuns || [];
  const maxActiveRuns = state?.maxActiveRuns ?? 7;
  const atRunLimit = (state?.runs || []).filter((r) => !['deleted', 'failed'].includes(r.status)).length >= maxActiveRuns;
  const runUnavailable = Boolean(busy || !active || active.status !== 'ready' || active.actionRunning || active.scenarioRunning);
  const openRun = (run) => {
    const idx = LESSONS.findIndex((l) => l.id === run.lesson);
    if (idx < 0) return;
    setLessonIdx(idx);
    setSelectedRun(run.id);
    setRunDetail(null);
    setRunCluster(null);
    setTimeline(null);
    setEvidence(null);
    setGuess(null);
    setQuizPick(null);
  };
  const defs = ACTION_DEFS[lesson.id] || [];
  const done = {
    baseline: active?.status === 'ready',
    predict: Boolean(runDetail?.predicted),
    act: Boolean(active?.scenario || (active?.actions || 0) > 0 || (active?.load?.total || 0) > 0),
    observe: Boolean(runDetail?.observed),
    explain: Boolean(runDetail?.revealed),
    checks: Boolean(active?.resultStatus),
  };

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
          <button className="rounded-md border border-white/15 px-2.5 py-1.5 transition-colors hover:bg-white/10" onClick={() => setSidebarOpen((v) => !v)} aria-expanded={sidebarOpen}>
            {sidebarOpen ? 'Hide lessons' : 'Show lessons'}
          </button>
          <a className="underline" href="/worksheet">Worksheet</a>
        </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4">
        <RunsPanel runs={state?.runs || []} archived={archived} maxActiveRuns={maxActiveRuns} selectedRun={selectedRun} onOpen={openRun} onRefresh={refreshState} onDownload={downloadEvidence} />
      </div>

      <div className={`mx-auto grid max-w-7xl gap-4 p-4 ${sidebarOpen ? 'lg:grid-cols-[220px_minmax(0,1fr)_340px]' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
        {sidebarOpen && (
        <aside className="min-w-0 space-y-2">
          <p className="font-mono text-[10px] tracking-widest text-muted-foreground">LABS / 07</p>
          {LESSONS.map((l, i) => (
            <button
              key={l.id}
              onClick={() => { setLessonIdx(i); setSelectedRun(null); setRunDetail(null); setTimeline(null); setGuess(null); setQuizPick(null); }}
              className={`flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm ${i === lessonIdx ? 'border-primary bg-secondary font-semibold' : 'bg-background hover:bg-muted'}`}
            >
              <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>{l.title}
            </button>
          ))}
          <Card><CardContent><p className="text-xs text-muted-foreground">Each experiment runs in its own <code>scaling-run-&lt;id&gt;</code> namespace on <code>kind-scaling-lab</code>.</p></CardContent></Card>
          <Card><CardContent className="space-y-2">
            <h3 className="text-sm font-semibold">Access guide</h3>
            <div className="space-y-1 text-xs">
              <p><strong>Console:</strong> <code>http://127.0.0.1:4173</code> · <a className="underline" href="/worksheet">Worksheet</a></p>
              {active?.appUrl ? <div className="space-y-1 rounded-md border bg-secondary/50 p-2">
                <p><strong>Selected run app</strong></p>
                <p className="break-all font-mono text-[10px]">{active.namespace}</p>
                <a className="inline-block text-primary underline" href={active.appUrl} target="_blank" rel="noreferrer">Open this run’s app ↗</a>
                <p className="text-[11px] text-muted-foreground">This address routes only to the selected run’s edge and app.</p>
              </div> : <p className="text-muted-foreground">Create or select a run for its own browser address.</p>}
              <details className="pt-1">
                <summary className="cursor-pointer text-muted-foreground">Shared CLI endpoint</summary>
                <p className="mt-1"><code>http://127.0.0.1:8080</code> always routes to <code>scaling-lab</code>. Selecting a lesson never changes this route.</p>
              </details>
              <p><strong>Prometheus:</strong> <code>make prometheus-ui</code> → <code>http://127.0.0.1:19090</code></p>
              <p><strong>Grafana:</strong> <code>make grafana-ui</code> → <code>http://127.0.0.1:3003</code> (<code>admin</code>/<code>scaling-lab</code>)</p>
            </div>
          </CardContent></Card>
        </aside>
        )}

        <section className="min-w-0 space-y-4">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground">LAB 0{lessonIdx + 1} / 07 · {lesson.time}</p>
            <h1 className="text-3xl font-semibold tracking-tight">{lesson.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{lesson.intro}</p>
          </div>

          <Card><CardContent className="space-y-1">
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground">THE IDEA</p>
            <p className="text-sm">{lesson.concept}</p>
          </CardContent></Card>

          <Diagram lessonIndex={lessonIdx} />

          <Card><CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Run the experiment</h3>
              <span className="font-mono text-[10px] text-muted-foreground">01 / OBSERVE</span>
            </div>
            <p className="text-sm text-muted-foreground">{lesson.task}</p>
            {lesson.id === 'shutdown' && (
              <label className="flex flex-wrap items-center gap-2 text-sm">Next request mode
                <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-md border p-1 text-sm">
                  <option value="graceful">Graceful</option>
                  <option value="abrupt">Abrupt (failure demonstration)</option>
                </select>
                {appliedMode && <span className="text-xs text-muted-foreground">Last applied: {appliedMode}</span>}
              </label>
            )}
            <div className="flex flex-wrap gap-1">
              {STEPS.map((s) => (
                <span key={s} className={`rounded-full border px-2 py-1 font-mono text-[10px] ${done[s] ? 'border-green-600 bg-green-50 text-green-800' : 'text-muted-foreground'}`}>{s}</span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={active ? runUnavailable || active.hasPendingLong || active.load?.active : Boolean(busy || atRunLimit)} onClick={runScenario}>{selectedRun ? 'Run + verify →' : 'New run →'}</Button>
              <Button variant="outline" disabled={Boolean(busy || atRunLimit)} onClick={createRun}>New run</Button>
              {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
            </div>
            {defs.length > 0 && (
              <div className="space-y-2 border-t pt-2">
                <h4 className="text-sm font-semibold">Guided actions</h4>
                <p className="text-xs text-muted-foreground">Small steps you can run and inspect before the one-click verifier.</p>
                <div className="flex flex-wrap gap-2">
                  {defs.map(([v, label]) => (
                    <Button key={v} variant="outline" size="sm" disabled={runUnavailable || (v === 'terminate-serving' ? !active?.hasPendingLong : active?.hasPendingLong)} onClick={() => runAction(v)}>{busy === `Running ${v}…` ? `${label}…` : label}</Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2 border-t pt-2">
              <h4 className="text-sm font-semibold">Isolated runs</h4>
              <div className="flex flex-wrap items-center gap-2">
                <select value={selectedRun || ''} onChange={(e) => setSelectedRun(e.target.value || null)} className="max-w-full rounded-md border p-1 text-sm">
                  <option value="">no runs</option>
                  {lessonRuns.map((r) => (
                    <option key={r.id} value={r.id}>{r.id} · {r.status} · {r.namespace}</option>
                  ))}
                </select>
                <Button variant="outline" size="sm" onClick={() => downloadEvidence(selectedRun)}>Download evidence</Button>
                <a className="text-xs underline" href="#all-runs">Manage / close runs ↑</a>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                {active ? `run ${active.id} · ${active.status} · ${active.namespace} · ${pods.filter((p) => p.ready && !p.terminating).length} Ready pods` : 'No runs for this lesson — create one to start.'}
              </p>
              {active?.appUrl && (
                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold">Browser access</h4>
                    <a href={active.appUrl} target="_blank" rel="noreferrer" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">Open app ↗</a>
                  </div>
                  <a href={active.appUrl} target="_blank" rel="noreferrer" className="block break-all font-mono text-[11px] text-muted-foreground underline">{window.location.origin}{active.appUrl}</a>
                  <p className="break-all text-[11px] text-muted-foreground">Routes to <code className="text-foreground">{active.namespace}</code> · edge → app</p>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <a className="underline" href={`/app/${active.id}/slow?ms=8000`} target="_blank" rel="noreferrer">8s request ↗</a>
                    <a className="underline" href={`/app/${active.id}/stream`} target="_blank" rel="noreferrer">Stream ↗</a>
                    <a className="underline" href={`/app/${active.id}/metrics`} target="_blank" rel="noreferrer">Metrics ↗</a>
                    <a className="underline" href={`/app/${active.id}/health/ready`} target="_blank" rel="noreferrer">Readiness ↗</a>
                  </div>
                  <p className="text-[11px] text-muted-foreground">These links send requests to this run. No terminal setup needed.</p>
                </div>
              )}
              <p className="text-xs text-green-700">
                Footprint: {(state?.runs || []).filter((r) => r.status !== 'deleted' && r.status !== 'failed').length}/{maxActiveRuns} active runs · 100m CPU / 64Mi per app pod.
              </p>
              <div className="text-xs">
                <span className="font-mono text-muted-foreground">Archived evidence ({archived.length}): </span>
                {archived.slice(-5).reverse().map((id) => (
                  <button key={id} onClick={() => downloadEvidence(id)} className="mr-1 rounded border px-1 font-mono text-[11px] hover:bg-muted">{id}</button>
                ))}
                {archived.length > 5 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer underline">Show all {archived.length}</summary>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {archived.slice(0, -5).reverse().map((id) => (
                        <button key={id} onClick={() => downloadEvidence(id)} className="rounded border px-1 font-mono text-[11px] hover:bg-muted">{id}</button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
            {(lesson.id === 'prometheus' || lesson.id === 'autoscale') && (
              <div className="space-y-2 border-t pt-2">
                <h4 className="text-sm font-semibold">Manual traffic</h4>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={runUnavailable || active?.hasPendingLong || active?.load?.active} onClick={() => loadAction('start', lesson.id === 'autoscale' ? 'cpu-steady' : 'steady')}>Start</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !active?.load?.active} onClick={() => loadAction('increase')}>Increase</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !active?.load?.active} onClick={() => loadAction('decrease')}>Decrease</Button>
                  <Button variant="outline" size="sm" disabled={runUnavailable || !active?.load?.active} onClick={() => loadAction('stop')}>Stop</Button>
                </div>
                <p className="text-xs text-muted-foreground">{active?.load?.active ? `${active.load.profile} · target ${active.load.targetRps} req/s · total ${active.load.total}` : 'Manual load idle.'}</p>
              </div>
            )}
            <div className="space-y-2 border-t pt-2">
              <p className="text-sm"><strong>Predict:</strong> {lesson.predict}</p>
              <div className="flex flex-wrap gap-2">
                {lesson.guesses.map(([v, label]) => (
                  <Button key={v} variant={guess === v ? 'default' : 'outline'} size="sm" onClick={() => predict(v)}>{label}</Button>
                ))}
                <Button variant="ghost" size="sm" onClick={reveal}>Reveal explanation</Button>
              </div>
            </div>
            {notice && <p className="rounded-md bg-muted p-2 text-xs">{notice}</p>}
          </CardContent></Card>

          <Card><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Verification</h3>
              <span className="font-mono text-[10px] text-muted-foreground">02 / CHECK</span>
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

          <Card><CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Check your understanding</h3>
              <span className="font-mono text-[10px] text-muted-foreground">03 / EXPLAIN</span>
            </div>
            <p className="text-sm">{lesson.quiz}</p>
            <div className="flex flex-wrap gap-2">
              {lesson.answers.map((a, i) => (
                <Button key={i} variant={quizPick === i ? (i === lesson.correct ? 'default' : 'outline') : 'outline'} size="sm" onClick={() => setQuizPick(i)}>{a}</Button>
              ))}
            </div>
            {quizPick != null && <p className="text-xs text-muted-foreground">{quizPick === lesson.correct ? 'Correct. ' : 'Try again. '}{lesson.why}</p>}
          </CardContent></Card>
        </section>

        <aside className="min-w-0 space-y-3">
          <Card className="border-0 bg-transparent shadow-none"><CardContent className="space-y-2 px-0">
            <h3 className="text-sm font-semibold">Live observation {active?.load?.active ? '· LIVE' : '· IDLE'}</h3>
            {grafana?.available ? (
              <div className="space-y-2">
                <a className="text-xs underline" href={grafana.runUrl || grafana.dashboardUrl} target="_blank" rel="noreferrer">Open dashboard for this run ↗</a>
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
            {grafana?.embedUrl && selectedRun && (
              <iframe title={`Grafana ${grafana.viewLabel || 'HTTP response metrics'} for selected run`} src={`${grafana.embedUrl}${grafana.embedUrl.includes('?') ? '&' : '?'}from=now-15m&to=now&refresh=5s`} className="h-64 w-full rounded border" loading="lazy" />
            )}
            {grafana?.available && selectedRun && <p className="text-[11px] leading-relaxed text-muted-foreground">
              {grafana.view === 'activity' ? 'Shows active requests, including long requests before they finish. Metrics update about every 5 seconds.' : grafana.view === 'responses' ? 'Shows completed responses on current pods. Counters reset when pods restart; a short response can finish between scrapes.' : 'Shows completed responses per second. An idle run has a zero rate; long requests appear after they finish.'}
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
