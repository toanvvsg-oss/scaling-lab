import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from './components/button.jsx';
import { Card, CardContent } from './components/card.jsx';
import { TimelineChart } from './components/timeline.jsx';
import { Diagram } from './components/diagram.jsx';
import { LESSONS, ACTION_DEFS, TIMELINE_HEADINGS, STEPS } from './lessons.js';
import { getJSON, postJSON, delJSON, downloadBlob } from './api.js';

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
  const [mode, setMode] = useState('graceful');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [guess, setGuess] = useState(null);
  const [quizPick, setQuizPick] = useState(null);
  const [cleanupConfirm, setCleanupConfirm] = useState(false);
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
          getJSON(`/api/grafana?run=${selectedRun}`).catch(() => null),
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
  }, [selectedRun]);

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

  const cleanup = async () => {
    if (!selectedRun) return;
    setBusy('Cleaning up…');
    try {
      await delJSON(`/api/runs/${selectedRun}`);
      setNotice(`Run ${selectedRun} cleanup started. Evidence stays downloadable.`);
      setSelectedRun(null);
      setCleanupConfirm(false);
    } catch (e) {
      setNotice(`Cleanup failed: ${e.message}`);
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
  const events = runDetail?.events || [];
  const points = (timeline?.points || []).slice(-180);
  const failures = (timeline?.milestones || []).filter((m) => m.kind === 'failure');
  const checks = evidence?.result?.checks || null;
  const verdict = evidence?.result?.status || active?.resultStatus || null;
  const archived = state?.archivedRuns || [];
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
      <header className="flex items-center justify-between bg-[#112a22] px-6 py-3 text-white">
        <div className="flex items-center gap-2 text-sm font-bold tracking-widest">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-lime-300 text-green-900">↗</span>
          SCALING LAB <span className="font-normal text-white/60">Field guide · shadcn console</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-white/70">
          <span>{cluster?.connected ? '● kind cluster connected' : '○ checking cluster…'}</span>
          <button className="rounded border border-white/30 px-2 py-1 underline" onClick={() => setSidebarOpen((v) => !v)} aria-expanded={sidebarOpen}>
            {sidebarOpen ? 'Hide lessons' : 'Show lessons'}
          </button>
          <a className="underline" href="/worksheet">Worksheet</a>
        </div>
      </header>

      <div className={`mx-auto grid max-w-7xl gap-4 p-4 ${sidebarOpen ? 'lg:grid-cols-[220px_minmax(0,1fr)_340px]' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
        {sidebarOpen && (
        <aside className="space-y-2">
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
              <p><strong>Shared edge</strong> (scaling-lab): <code>http://127.0.0.1:8080</code> — <code>/health/ready</code>, <code>/fast</code>, <code>/slow?ms=8000</code>, <code>/stream</code>, <code>/metrics</code></p>
              <p><strong>Run edge:</strong> use Guided actions (no port-hunting). Manual equivalent:</p>
              <pre className="overflow-auto rounded bg-muted p-2 font-mono text-[10px]">kubectl --context kind-scaling-lab -n scaling-run-&lt;id&gt; port-forward service/edge 8081:8080{'\n'}# then: http://127.0.0.1:8081/slow?ms=8000</pre>
              <p><strong>Prometheus:</strong> <code>make prometheus-ui</code> → <code>http://127.0.0.1:19090</code></p>
              <p><strong>Grafana:</strong> <code>make grafana-ui</code> → <code>http://127.0.0.1:3003</code> (<code>admin</code>/<code>scaling-lab</code>)</p>
            </div>
          </CardContent></Card>
        </aside>
        )}

        <section className="space-y-4">
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
              <label className="flex items-center gap-2 text-sm">Shutdown mode
                <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-md border p-1 text-sm">
                  <option value="graceful">Graceful</option>
                  <option value="abrupt">Abrupt (failure demonstration)</option>
                </select>
              </label>
            )}
            <div className="flex flex-wrap gap-1">
              {STEPS.map((s) => (
                <span key={s} className={`rounded-full border px-2 py-1 font-mono text-[10px] ${done[s] ? 'border-green-600 bg-green-50 text-green-800' : 'text-muted-foreground'}`}>{s}</span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={runScenario}>New run + verify →</Button>
              <Button variant="outline" onClick={createRun}>New run</Button>
              {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
            </div>
            {defs.length > 0 && (
              <div className="space-y-2 border-t pt-2">
                <h4 className="text-sm font-semibold">Guided actions</h4>
                <p className="text-xs text-muted-foreground">Small steps you can run and inspect before the one-click verifier.</p>
                <div className="flex flex-wrap gap-2">
                  {defs.map(([v, label]) => (
                    <Button key={v} variant="outline" size="sm" onClick={() => runAction(v)}>{label}</Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2 border-t pt-2">
              <h4 className="text-sm font-semibold">Isolated runs</h4>
              <div className="flex flex-wrap items-center gap-2">
                <select value={selectedRun || ''} onChange={(e) => setSelectedRun(e.target.value || null)} className="rounded-md border p-1 text-sm">
                  <option value="">no runs</option>
                  {lessonRuns.map((r) => (
                    <option key={r.id} value={r.id}>{r.id} · {r.status} · {r.namespace}</option>
                  ))}
                </select>
                <Button variant="outline" size="sm" onClick={() => downloadEvidence(selectedRun)}>Download evidence</Button>
                {!cleanupConfirm ? (
                  <Button variant="outline" size="sm" onClick={() => setCleanupConfirm(true)}>Clean up run…</Button>
                ) : (
                  <span className="flex items-center gap-2 text-xs">
                    Delete scaling-run-{selectedRun}? Evidence stays downloadable.
                    <Button size="sm" onClick={cleanup}>Confirm cleanup</Button>
                    <Button variant="ghost" size="sm" onClick={() => setCleanupConfirm(false)}>Cancel</Button>
                  </span>
                )}
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                {active ? `run ${active.id} · ${active.status} · ${active.namespace} · ${pods.filter((p) => p.ready && !p.terminating).length} Ready pods` : 'No runs for this lesson — create one to start.'}
              </p>
              <p className="text-xs text-green-700">
                Footprint: {(state?.runs || []).filter((r) => r.status !== 'deleted' && r.status !== 'failed').length}/{state?.maxActiveRuns || 2} active runs · 100m CPU / 64Mi per app pod.
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
                  <Button variant="outline" size="sm" onClick={() => loadAction('start', lesson.id === 'autoscale' ? 'cpu-steady' : 'steady')}>Start</Button>
                  <Button variant="outline" size="sm" onClick={() => loadAction('increase')}>Increase</Button>
                  <Button variant="outline" size="sm" onClick={() => loadAction('decrease')}>Decrease</Button>
                  <Button variant="outline" size="sm" onClick={() => loadAction('stop')}>Stop</Button>
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

        <aside className="space-y-3">
          <Card className="border-0 bg-transparent shadow-none"><CardContent className="space-y-2 px-0">
            <h3 className="text-sm font-semibold">Live observation {active?.load?.active ? '· LIVE' : '· IDLE'}</h3>
            {grafana?.available ? (
              <a className="text-xs underline" href={grafana.runUrl || grafana.dashboardUrl} target="_blank" rel="noreferrer">Open dashboard for this run ↗</a>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Monitoring integration is unavailable on this server (no <code>/api/grafana</code>). Use the manual path:</p>
                <pre className="overflow-auto rounded bg-muted p-2 font-mono text-[10px]">make grafana-up{'\n'}make grafana-ui  # http://127.0.0.1:3003</pre>
                <p className="text-xs text-muted-foreground">Login <code>admin</code> / <code>scaling-lab</code>, open “Scaling Lab - request rate vs replicas”.</p>
              </div>
            )}
            {grafana?.embedUrl && selectedRun && (
              <iframe title="Grafana HTTP response metrics for selected run" src={`${grafana.embedUrl}${grafana.embedUrl.includes('?') ? '&' : '?'}from=now-15m&to=now&refresh=5s`} className="h-64 w-full rounded border" loading="lazy" />
            )}
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

          <Card><CardContent className="space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">HTTP STATUS (CLIENT-OBSERVED)</p>
            {!stats?.total ? <p className="text-xs text-muted-foreground">No responses counted yet.</p> : (
              <p className="text-xs">2xx {stats.ok2xx} · 4xx {stats.http4xx} · 5xx {stats.http5xx} · transport {stats.transport} · total {stats.total}</p>
            )}
            {(stats?.recentErrors || []).slice(0, 5).map((e, i) => (
              <p key={i} className="font-mono text-[10px] text-red-800">{e.status != null ? `HTTP ${e.status}` : `transport ${e.transport}`} · {shortPod(e.pod)}</p>
            ))}
          </CardContent></Card>

          <Card><CardContent className="space-y-2">
            <p className="font-mono text-[10px] text-muted-foreground">{TIMELINE_HEADINGS[lesson.id]}</p>
            <TimelineChart points={points} lesson={lesson.id} failures={failures} />
            <div className="max-h-48 space-y-1 overflow-auto">
              {events.slice(-30).reverse().map((ev, i) => (
                <p key={i} className="font-mono text-[10px] text-muted-foreground">
                  {new Date(ev.at).toLocaleTimeString()} <strong>{ev.type}</strong> {ev.data?.pod ? shortPod(ev.data.pod) : ev.data?.text || ''}
                </p>
              ))}
            </div>
          </CardContent></Card>
        </aside>
      </div>
    </div>
  );
}
