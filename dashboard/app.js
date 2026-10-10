const lessons = [
  { id:'connections', title:'Connection reuse', time:'5 MIN', intro:'Find out which requests share a client connection and which open a new one.', concept:'HTTP keep-alive lets one TCP connection carry multiple requests. The edge proxy may use a separate pool of connections to Node.js, so client-to-edge and edge-to-app reuse are different observations.', task:'Create a run, then send eight sequential requests with a reused client socket and eight with fresh sockets. Compare the edge connection IDs in the evidence.', quiz:'If one client socket is reused, must the proxy reuse the same socket to Node.js?', answers:['Yes, both sides are one connection','No, the proxy has a separate upstream pool'], correct:1, why:'The proxy terminates the client connection and chooses its own upstream connection.', guesses:[['share','Share one edge connection'],['same','No change'],['fresh','Open fresh connections']],predict:'Will the 8 reused requests share one edge connection ID?', act:'Run the experiment in your run, then inspect the trace below.' },
  { id:'timeouts', title:'Idle timeouts', time:'1 MIN', intro:'See the client and proxy keep one connection while Node.js closes another.', concept:'Each hop has its own idle timeout. The client-to-edge socket can remain open after Node.js closes the proxy-to-app socket; the next request then needs a new upstream connection. Node.js is configured with a 5s keep-alive plus a 1s close buffer, so upstream sockets go idle at about six seconds.', task:'Create a run, then compare a one-second idle gap with a 6.5-second gap. The app effective upstream budget is about six seconds (5s keep-alive + 1s buffer on recent Node). Inspect both connection IDs.', quiz:'If the Node.js upstream socket expires, must the client open a new socket to the proxy?', answers:['Yes, the entire path closes','No, the proxy can reconnect upstream'], correct:1, why:'The proxy owns two independent socket pools.', guesses:[['up','Both connections survive'],['same','No change'],['down','Upstream expires']],predict:'Will the client socket survive both idle gaps?', act:'Run the experiment, then compare short-gap and long-gap connection IDs.' },
  { id:'shutdown', title:'Graceful shutdown', time:'2 MIN', intro:'Delete the exact pod serving a long request while new requests continue.', concept:'Pod termination starts a grace deadline. The preStop hook runs before SIGTERM and consumes part of that deadline. Node.js can stop accepting new work while active HTTP requests finish.', task:'Create a run, then choose graceful or abrupt exit. The runner starts an eight-second request, reads its pod ID, and deletes that pod inside the run namespace. Watch the long request and background traffic.', quiz:'Does a failed readiness probe finish requests already in flight?', answers:['Yes, it closes them','No, the application must finish them'], correct:1, why:'Readiness affects endpoint selection for new traffic. The application controls active requests.', guesses:[['up','Long request completes'],['same','No change'],['down','Request interrupted']],predict:'Will the 8s request finish despite its pod being deleted?', act:'Pick a shutdown mode, run the experiment, then read the signal trace.' },
  { id:'rollout', title:'Rolling deployment', time:'2 MIN', intro:'Replace the application pods while a stream of requests keeps arriving.', concept:'A Deployment can start an extra pod before stopping an old one. Readiness gates traffic to new pods; the shutdown path matters when old pods are removed.', task:'Create a run, then start a rolling update with maxSurge 1 and maxUnavailable 0 inside the run namespace. Verify that new pod IDs appear and sampled requests keep succeeding.', quiz:'What does maxUnavailable: 0 require during a rollout?', answers:['No pod may terminate','The required number of available replicas is maintained'], correct:1, why:'Old pods may terminate once replacement capacity becomes available.', guesses:[['up','New pods serve traffic'],['same','No change'],['down','Some requests fail']],predict:'Will any sampled request fail while pods are replaced?', act:'Run the experiment and watch pod IDs turn over with zero failures.' },
  { id:'streaming', title:'Streaming drain', time:'2 MIN', intro:'Delete a pod while it is sending a response in pieces.', concept:'A streaming response stays active much longer than a fast JSON response. Graceful shutdown must allow it to finish or set an explicit stream policy and deadline.', task:'Create a run, then start a 20-tick stream, delete its pod after the first ticks, and verify that every tick arrives before the process exits.', quiz:'Does server.close() instantly terminate an active HTTP stream?', answers:['Yes, it closes all sockets','No, the active response can continue'], correct:1, why:'Node.js stops new connections and waits for active HTTP requests; the shutdown deadline can still force an exit.', guesses:[['up','All 20 ticks arrive'],['same','No change'],['down','Stream resets']],predict:'Will all 20 ticks arrive after the serving pod is deleted?', act:'Run the experiment and count ticks in the trace.' },
  { id:'autoscale', title:'Autoscaling', time:'4 MIN', intro:'Apply CPU load, then watch the HPA add and remove application replicas.', concept:'CPU utilization for HPA is measured relative to container CPU requests. Metrics collection and HPA reconciliation take time; scale down also waits through a stabilization window.', task:'Create a run — it provisions its own CPU HPA. Run the sustained CPU experiment inside the run, or drive CPU manually, then watch replicas scale down.', quiz:'If the app has no CPU request, can a CPU utilization target be calculated?', answers:['Yes, from the CPU limit','No, utilization needs a request'], correct:1, why:'The HPA uses the resource request as the denominator for CPU utilization.', guesses:[['up','Replicas scale up'],['same','Stay'],['down','Scale back down']],predict:'Will replicas rise, and how long will scale-down take?', act:'Run the experiment or start a CPU profile, then follow CPU % vs the 60% target.' },
  { id:'prometheus', title:'Prometheus scaling', time:'5 MIN', intro:'Scale from observed HTTP request rate instead of CPU usage.', concept:'Each pod exposes a request counter. Prometheus scrapes those counters and calculates requests per second with PromQL. KEDA reads that query as an external metric and supplies it to a Kubernetes HPA.', task:'Create a run — it provisions its own KEDA scaler. Use manual steady/ramp/burst traffic, then reduce/stop it. Follow offered RPS, scraped RPS, desired replicas, and Ready pods through scale up and scale down. The HPA lags traffic.', quiz:'Which component turns the Prometheus query into a scaling metric for the HPA?', answers:['Prometheus itself','KEDA metrics API server'], correct:1, why:'KEDA queries Prometheus and exposes an external metric. The HPA uses that metric to choose replicas.', guesses:[['up','Replicas scale up'],['same','Stay'],['down','Scale back down']],predict:'After a burst, what moves first: scraped RPS, desired replicas, or Ready pods?', act:'Start a profile, change it mid-run, then stop and watch scale-in order.' }
];
const STEPS = ['baseline', 'predict', 'act', 'observe', 'explain', 'checks'];
const ACTION_DEFS = {
  connections: [
    ['reuse-batch', 'Send 8 reused requests', 'One client socket, eight requests — check the shared edge connection ID.'],
    ['fresh-batch', 'Send 8 fresh requests', 'Eight new sockets — each should get its own edge connection ID.'],
  ],
  timeouts: [
    ['short-gap', 'Probe 1s idle gap', 'Short pause: both connections should survive.'],
    ['long-gap', 'Probe 6.5s idle gap', 'Long pause: the Node.js upstream socket should expire.'],
  ],
  shutdown: [
    ['start-long', 'Start 8s request', 'Starts the long request and pins its serving pod.'],
    ['terminate-serving', 'Delete serving pod', 'Deletes the pod serving the pending request.'],
  ],
  streaming: [
    ['start-stream', 'Start 20-tick stream', 'Starts the stream and pins its serving pod.'],
    ['terminate-serving', 'Delete serving pod', 'Deletes the pod mid-stream.'],
  ],
  rollout: [
    ['bg-start', 'Start background traffic', 'Steady requests so the rollout has traffic to preserve.'],
    ['trigger-rollout', 'Trigger rollout', 'Changes the pod template and rolls the deployment.'],
    ['bg-stop', 'Stop background traffic', 'Stops the background requests.'],
  ],
  autoscale: [],
  prometheus: [],
};
const TIMELINE_HEADINGS = {
  prometheus: 'CAUSE ↔ EFFECT TIMELINE (units: req/s · replicas · target 5 req/s per pod)',
  autoscale: 'CAUSE ↔ EFFECT TIMELINE (units: CPU % · replicas · target 60%)',
  connections: 'REQUEST TIMELINE (units: requests · connection IDs)',
  timeouts: 'REQUEST TIMELINE (units: requests · connection IDs)',
  shutdown: 'SHUTDOWN TIMELINE (units: requests · pod signals)',
  rollout: 'ROLLOUT TIMELINE (units: requests · pods)',
  streaming: 'STREAM TIMELINE (units: ticks · pod signals)',
};
const $ = id => document.getElementById(id);
let current = 0, lastEventRev = -1, lastEventUpto = null, selectedRun = null, pendingRun = null, lastRunResultKey = null, lastPredictSig = null;
let frozenView = false, frozenAt = null;
// Selection epoch: bumped on every lesson/run/creation intent change. Async
// refresh responses from an older epoch are discarded before they can mutate
// global selection or render, so a slow out-of-order poll can never flip a
// fresh selection back to an older run.
let selEpoch = 0;
const bumpEpoch = () => { selEpoch += 1; };
// Single-flight periodic refresh: overlapping polls (slow kubectl) queue one
// follow-up instead of racing each other.
let refreshActive = false, refreshQueued = false;
window.labLesson = 'connections'; window.labRun = null; window.labCursor = null;
function saveSelection() {
  try { localStorage.setItem('scaling-lab-selection', JSON.stringify({ lesson: lessons[current].id, run: selectedRun })); } catch { /* private mode */ }
}
function loadSelection() {
  try {
    const s = JSON.parse(localStorage.getItem('scaling-lab-selection') || 'null');
    if (!s) return null;
    const idx = lessons.findIndex((l) => l.id === s.lesson);
    if (idx < 0) return null;
    return { index: idx, run: typeof s.run === 'string' ? s.run : null };
  } catch { return null; }
}
window.addEventListener('lab:freeze', () => { frozenView = true; frozenAt = new Date().toISOString(); const pill = $('live-pill'); if (pill) pill.textContent = 'PAUSED'; });
window.addEventListener('lab:resume', () => { frozenView = false; frozenAt = null; window.labCursor = null; refresh(); });
function escape(s){return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Lesson switching never mutates the cluster: every lesson runs inside its own
// isolated run namespace, so opening another lesson is always safe.
function select(index){
  current=index;const l=lessons[index];
  window.labLesson = l.id;
  bumpEpoch();
  saveSelection();
  window.dispatchEvent(new CustomEvent('lab:lesson', { detail: index }));
  window.dispatchEvent(new CustomEvent('lab:select'));
  $('lessons').innerHTML=lessons.map((x,i)=>`<button class="lesson-link ${i===index?'active':''}" data-index="${i}"><span class="num">0${i+1}</span>${escape(x.title)}</button>`).join('');
  document.querySelectorAll('.lesson-link').forEach(x=>x.onclick=()=>select(Number(x.dataset.index)));
  $('lesson-number').textContent=`LAB 0${index+1} / 07`;$('lesson-time').textContent=l.time;$('lesson-title').textContent=l.title;$('lesson-intro').textContent=l.intro;$('lesson-concept').textContent=l.concept;$('lesson-task').textContent=l.task;
  $('options').innerHTML=l.id==='shutdown'?'<label class="option-row">Shutdown mode <select id="mode"><option value="graceful">Graceful</option><option value="abrupt">Abrupt (failure demonstration)</option></select></label>':'';
  $('load-panel').hidden = l.id !== 'prometheus' && l.id !== 'autoscale';
  const defs = ACTION_DEFS[l.id] || [];
  $('action-panel').hidden = defs.length === 0;
  $('timeline-heading').textContent = TIMELINE_HEADINGS[l.id] || 'TIMELINE';
  if (defs.length) {
    $('action-hint').textContent = 'Small steps you can run and inspect before the one-click verifier.';
    $('action-buttons').innerHTML = defs.map(([v, label]) => `<button data-action="${v}">${escape(label)}</button>`).join('');
    $('action-buttons').querySelectorAll('button').forEach(b => b.onclick = () => runLearnerAction(b.dataset.action));
  }
  $('predict-prompt').textContent = l.predict;
  $('guess-options').innerHTML = l.guesses.map(([v,label])=>`<button data-guess="${v}">${escape(label)}</button>`).join('');
  document.querySelectorAll('[data-guess]').forEach(b=>b.onclick=predictClick);
  lastRunResultKey = null; lastEventRev = -1;
  $('quiz-question').textContent=l.quiz;$('quiz-options').innerHTML=l.answers.map((x,i)=>`<button class="quiz-choice" data-answer="${i}">${escape(x)}</button>`).join('');$('quiz-feedback').textContent='';
  document.querySelectorAll('.quiz-choice').forEach(x=>x.onclick=()=>{const right=Number(x.dataset.answer)===l.correct;x.classList.add(right?'correct':'wrong');$('quiz-feedback').textContent=(right?'Correct. ':'Try again. ')+l.why;});
  $('verdict').innerHTML='<div class="empty">Run the experiment to see evidence and checks.</div>';
  refresh();
}
function renderResult(result, key){
  const box = $('verdict');
  if (!result) return;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const checks=result.checks.map(x=>`<div class="check"><b class="${x.pass?'':'no'}">${x.pass?'✓':'✕'}</b><span>${escape(x.label)}</span></div>`).join('');
  box.innerHTML=`<div class="verdict-card ${escape(result.status)}"><div class="verdict-title">${escape(result.status)}</div>${checks}<details><summary style="margin-top:16px;font-size:11px;cursor:pointer">Show raw evidence</summary><pre class="evidence">${escape(JSON.stringify(result.evidence,null,2))}</pre></details></div>`;
}
function renderEvents(events, rev, upto = window.labCursor ?? null){
  if (rev === lastEventRev && upto === lastEventUpto) return;
  lastEventRev = rev; lastEventUpto = upto;
  const shown = upto == null ? events : events.filter(x => new Date(x.at).getTime() <= upto);
  const box=$('timeline');
  if(!shown.length){box.innerHTML='<p class="timeline-empty">Events appear here as the scenario runs.</p>';}
  else box.innerHTML=shown.slice(-80).reverse().map(x=>{const d=x.data||{};let message=d.text||d.pod||d.status||'';if(x.type==='request'||x.type==='sample')message=`${d.ok===false?'ERROR':'200'} · ${d.pod||'edge'} · ${d.ms||0}ms`;if(x.type==='slow-end')message=`${d.complete?'completed':'interrupted'} · ${d.pod}`;return `<div class="event ${x.type==='error'?'error':''}"><time>${new Date(x.at).toLocaleTimeString()}</time><strong>${escape(x.type.replaceAll('-',' '))}</strong>${escape(message)}</div>`;}).join('');
  renderTrace(events, upto);
}
function renderTrace(events, upto = window.labCursor ?? null){
  const box = $('trace');
  if (!box) return;
  const rows = events.filter(x => ['sample', 'request', 'slow-start', 'slow-end', 'stream-start', 'stream-end', 'pod-delete', 'app-signal', 'prestop'].includes(x.type) && (upto == null || new Date(x.at).getTime() <= upto)).slice(-40);
  if (!rows.length) { box.innerHTML = '<p class="timeline-empty">Request and signal traces appear here.</p>'; return; }
  const short = (v) => v == null || v === '' ? '?' : String(v).slice(0, 8);
  // Pod names share the deployment-hash prefix across replicas
  // (app-7446d768d6-*); only the final random suffix is unique. Upstream
  // socket identity is pod-suffix + app connection ID.
  const shortPod = (v) => {
    if (v == null || v === '') return '?';
    const parts = String(v).split('-');
    return `…${parts[parts.length - 1]}`;
  };
  box.innerHTML = rows.map(x => {
    const d = x.data || {};
    const t = new Date(x.at).toLocaleTimeString();
    let body = '';
    if (x.type === 'sample' || x.type === 'request') body = `${d.ok === false ? 'ERROR' : '200'} · req ${short(d.requestId)} · edge ${short(d.edgeConnection)} → ${shortPod(d.pod)}/${short(d.appConnection)} · ${d.ms || 0}ms`;
    else if (x.type === 'pod-delete') body = `deleted ${shortPod(d.pod)}`;
    else if (x.type === 'prestop') body = `preStop ${escape(d.phase || '?')} · ${shortPod(d.pod)}`;
    else if (x.type === 'app-signal') body = `${escape(d.event || '')} · active ${d.active ?? '?'}`;
    else if (x.type === 'slow-end') body = `${d.complete ? 'completed' : 'INTERRUPTED'} · req ${short(d.requestId)} · ${shortPod(d.pod)} · ${d.ms || 0}ms`;
    else if (x.type === 'stream-end') body = d.complete ? 'stream complete' : `stream error: ${escape(d.error || '')}`;
    else body = `${shortPod(d.pod || d.requestId || d.text || '')}`;
    return `<div class="event"><time>${t}</time><strong>${escape(x.type.replaceAll('-', ' '))}</strong>${body}</div>`;
  }).join('');
}
function renderStepper(detail){
  const box = $('stepper');
  if (!box) return;
  const l = lessons[current];
  const done = {
    baseline: Boolean(detail && (detail.status === 'ready' || detail.status === 'creating')),
    predict: Boolean(detail?.predicted),
    act: Boolean(detail && (detail.scenario || (detail.actions || 0) > 0 || (detail.load?.total || 0) > 0)),
    observe: Boolean(detail?.observed),
    explain: Boolean(detail?.revealed),
    checks: Boolean(detail?.resultStatus),
  };
  box.innerHTML = STEPS.map(s => {
    let hint = '';
    if (s === 'predict') hint = l.predict;
    if (s === 'act') hint = l.act;
    return `<span class="step-pill ${done[s] ? 'done' : ''}">${s}${hint ? `<small>${escape(hint)}</small>` : ''}</span>`;
  }).join('');
}
async function createRunForLesson(lesson, statusEl){
  bumpEpoch();
  const r=await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lesson})});
  if(!r.ok){const b=await r.json();if(statusEl)statusEl.textContent=`Run creation failed: ${b.error}`;return null;}
  const { id } = await r.json();
  if(statusEl)statusEl.textContent='Creating run: namespace, app/edge rollout, scaler check…';
  pendingRun = id;
  return id;
}
function setCreatingDisabled(disabled){
  for (const id of ['run-new', 'reset-confirm']) { const el = $(id); if (el) el.disabled = disabled; }
}
async function refresh(){
  if (frozenView) return; // whole observation stays frozen: pods, endpoints, events, trace
  if (refreshActive) { refreshQueued = true; return; }
  refreshActive = true;
  try {
    await refreshInner();
  } finally {
    refreshActive = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}
async function refreshInner(){
  const epoch = selEpoch;
  const alive = () => epoch === selEpoch;
  let clusterConnected = false;
  try{
    const [state,cluster]=await Promise.all([fetch('/api/state').then(x=>x.json()),fetch('/api/cluster').then(x=>x.json())]);
    if (!alive()) return;
    clusterConnected = Boolean(cluster.connected);
    if (frozenView) return; // a freeze landed mid-fetch: never paint stale data over it
    $('cluster-dot').classList.toggle('good',cluster.connected);
    $('cluster-label').textContent=cluster.connected?'kind cluster connected':'Cluster offline';
    const lesson = lessons[current].id;
    const runs = (state.runs || []).filter(r => r.lesson === lesson);
    const live = runs.filter(r => r.status === 'ready' || r.status === 'creating');
    if (pendingRun) {
      const pr = (state.runs || []).find(r => r.id === pendingRun);
      if (pr && pr.status === 'ready') { selectedRun = pendingRun; pendingRun = null; }
      else if (pr && pr.status !== 'creating') { pendingRun = null; }
    }
    const selRec = (state.runs || []).find(r => r.id === selectedRun);
    if (!selRec || selRec.lesson !== lesson || selRec.status === 'deleted') selectedRun = null;
    if (!selectedRun && live.length) selectedRun = live[live.length - 1].id;
    saveSelection();
    setCreatingDisabled(Boolean(pendingRun));
    window.labRun = selectedRun;
    const sel = $('run-select');
    if (sel) {
      const opts = runs.map(r => `<option value="${escape(r.id)}" ${r.id === selectedRun ? 'selected' : ''}>${escape(r.id)} · ${escape(r.status)}${r.readopted ? ' · re-adopted' : ''} · ${escape(r.namespace)}</option>`).join('');
      if (sel.innerHTML !== opts) sel.innerHTML = opts || '<option value="">no runs</option>';
    }
    const active = (state.runs || []).find(r => r.id === selectedRun);
    let pods = cluster.pods, endpoints = cluster.endpoints, runDetail = null;
    if (active) {
      try {
        const [rc, rd] = await Promise.all([
          fetch(`/api/runs/${active.id}/cluster`).then(x=>x.json()),
          fetch(`/api/runs/${active.id}`).then(x=>x.json()),
        ]);
        if (!alive()) return;
        if (rc.connected) { pods = rc.pods; endpoints = rc.endpoints; }
        if (rd && Array.isArray(rd.events)) runDetail = rd;
      } catch { /* keep shared view on error */ }
    }
    if (!alive()) return;
    renderStepper(runDetail);
    $('pods').innerHTML=pods?.length?pods.map(x=>`<div class="pod ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.name)}">${escape(x.name)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No application pods';
    $('endpoints').innerHTML=endpoints?.length?endpoints.map(x=>`<div class="endpoint ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.pod)}">${escape(x.pod)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No endpoints';
    const scenarioBusy = active ? active.scenarioRunning : state.running;
    $('run').disabled=!!scenarioBusy || Boolean(pendingRun);
    $('run-state').textContent=active ? (active.scenarioRunning ? 'Scenario running…' : active.error || '') : '';
    $('live-pill').textContent=(active?.scenarioRunning || active?.load?.active || active?.actionRunning || active?.hasPendingLong)?'LIVE':'IDLE';
    const readyPods = pods.filter(p => p.ready && !p.terminating).length;
    $('run-panel-state').textContent = active ? `run ${active.id} · ${active.status} · ${active.namespace} · ${readyPods} Ready pods${active.error ? ' · error: ' + active.error : ''}${active.status === 'deleted' ? ' · evidence stays downloadable' : ''}` : (pendingRun ? 'Creating run…' : 'No runs for this lesson — create one to start.');
    const liveRuns = (state.runs || []).filter(r => r.status !== 'deleted' && r.status !== 'failed');
    const cap = state.maxActiveRuns || 2;
    $('run-footprint').textContent = liveRuns.length ? `Footprint: ${liveRuns.length}/${cap} active runs · 100m CPU / 64Mi requested per app pod · selected run: ${readyPods} Ready pods — laptop limit enforced.` : `Footprint: 0/${cap} active runs.`;
    const arch = state.archivedRuns || [];
    const box = $('archived-list');
    box.innerHTML = arch.length ? 'Archived evidence: ' : '';
    arch.forEach(id => {
      const b = document.createElement('button');
      b.className = 'timeline-mark'; b.textContent = id;
      b.onclick = () => downloadEvidence(id);
      box.appendChild(b);
    });
    // manual profile options follow the lesson (CPU work for autoscale)
    const profSel = $('load-profile');
    if (profSel && state.profiles) {
      const set = lesson === 'autoscale' ? state.profiles.cpu : state.profiles.request;
      const opts = Object.entries(set).map(([k, v]) => `<option value="${k}">${k} · ${v.phases[0].rps} req/s</option>`).join('');
      if (profSel.dataset.set !== lesson) { profSel.innerHTML = opts; profSel.dataset.set = lesson; }
    }
    const effLoad = active ? active.load : null;
    if (effLoad?.active) {
      const secs = Math.floor((effLoad.elapsedMs||0)/1000);
      $('load-state').textContent = `${effLoad.profile}${effLoad.phaseLabel ? ' · phase ' + effLoad.phaseLabel : ''} · target ${effLoad.targetRps} req/s · measured ${effLoad.offeredLastSecond ?? 0} offered / ${effLoad.achievedLastSecond ?? 0} ok req/s · elapsed ${secs}s · total ${effLoad.total} (${effLoad.failures} failures)`;
    } else {$('load-state').textContent = 'Manual load idle.';}
    // Predict status writes only on transitions so reveal errors and
    // explanations set by click handlers are never clobbered by polling.
    const predictSig = runDetail?.predicted ? `run:${runDetail.revealed}` : (state.legacyPrediction ? `legacy:${state.legacyPrediction.revealed}` : 'none');
    if (predictSig !== lastPredictSig) {
      lastPredictSig = predictSig;
      $('predict-state').textContent = runDetail?.predicted ? (runDetail.revealed ? 'Explanation revealed below the timeline.' : `Predicted. Observe, then reveal.`) : (state.legacyPrediction ? (state.legacyPrediction.revealed ? 'Explanation revealed below the timeline.' : 'Predicted. Observe, then reveal.') : '');
    }
    const events = runDetail ? runDetail.events : state.events;
    renderEvents(events, runDetail ? runDetail.rev : state.rev);
    if(active && active.resultStatus && active.scenario === lesson){
      const key = `${active.id}:${active.scenario}:${active.resultStatus}`;
      if(key!==lastRunResultKey){
        lastRunResultKey = key;
        $('verdict').innerHTML = '';
        $('verdict').dataset.key = '';
        const ev = await fetch(`/api/evidence?run=${active.id}`).then(x=>x.json());
        if (!alive()) return;
        if(ev.result) renderResult(ev.result, key);
      }
    } else if(state.result&&state.scenario===lesson){renderResult(state.result, `legacy:${state.scenario}:${state.result.status}`);}
    if (runDetail?.prediction) { /* reserved */ }
  }catch(error){
    console.error('dashboard refresh failed:', error);
    window.labLastError = String(error && error.message || error);
    window.labLastErrorAt = new Date().toISOString();
    $('cluster-label').textContent = clusterConnected ? 'UI update failed (see console)' : 'Cluster offline';
  }
}
$('run').onclick=async()=>{
  const l=lessons[current];
  // Run always provisions a fresh isolated run: experiment evidence from
  // different sessions never mixes. (Reload continuity only reconnects
  // selection; it never creates runs.)
  let id = null;
  let transferGuess = null;
  $('verdict').innerHTML='<div class="empty">Creating an isolated run first…</div>';
  // Transfer an unrevealed same-lesson prediction onto the new run so the
  // guess stays connected to the action instead of dangling on legacy scope.
  try {
    const st0 = await fetch('/api/state').then(x=>x.json());
    if (st0.legacyPrediction && st0.legacyPrediction.lesson === l.id && !st0.legacyPrediction.revealed) {
      transferGuess = st0.legacyPrediction.guess;
    }
  } catch { /* proceed without transfer */ }
  id = await createRunForLesson(l.id, $('run-panel-state'));
  if(!id){$('verdict').innerHTML='<div class="empty">Run creation failed. See run status above.</div>';return;}
  for(let i=0;i<60;i++){
    await new Promise(x=>setTimeout(x,5000)); await refresh();
    const s=await fetch('/api/state').then(x=>x.json());
    const r=(s.runs||[]).find(x=>x.id===id);
    if(r && r.status==='ready') break;
    if(r && r.status!=='creating'){pendingRun=null;$('verdict').innerHTML=`<div class="empty">Run creation failed: ${escape(r.error||'unknown')}. The dialog stays open — fix and retry.</div>`;return;}
  }
  selectedRun = id; lastRunResultKey = null; lastEventRev = -1;
  if (transferGuess) {
    await fetch('/api/predict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({guess: transferGuess, lesson: l.id, run: id})});
  }
  $('verdict').innerHTML='<div class="empty">Collecting evidence…</div>';$('verdict').dataset.key='';renderEvents([], -2);
  const response=await fetch(`/api/runs/${id}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,mode:$('mode')?.value})});
  if(!response.ok){const body=await response.json();$('verdict').innerHTML=`<div class="empty">${escape(body.error)}</div>`;}
  refresh();
};
$('reset-open').onclick=()=>{$('reset-status').textContent='';$('reset-text').textContent=`Create a fresh isolated run for “${lessons[current].title}”? Existing runs are untouched; clean them up explicitly when done.`;$('reset-dialog').showModal();};
$('reset-cancel').onclick=()=>{$('reset-dialog').close();};
$('reset-download').onclick=()=>downloadEvidence(selectedRun);
$('reset-confirm').onclick=async()=>{
  $('reset-status').textContent='Creating a fresh isolated run…';
  const id = await createRunForLesson(lessons[current].id, $('reset-status'));
  if (!id) return; // error stays visible; dialog stays open for retry
  $('reset-dialog').close();
  refresh();
};
$('cluster-delete-info').onclick=()=>$('delete-dialog').showModal();
$('delete-cancel').onclick=()=>$('delete-dialog').close();
async function runLearnerAction(action){
  if (!selectedRun) { $('action-state').textContent = 'Create a run first.'; return; }
  $('action-state').textContent = `Running ${action}…`;
  const body = { action };
  if (action === 'start-long') body.mode = $('mode')?.value || 'graceful';
  const r = await fetch(`/api/runs/${selectedRun}/actions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json();
  if (!r.ok) { $('action-state').textContent = data.error; return; }
  $('action-state').textContent = `${action}: ${escape(summarizeAction(data))}`;
  refresh();
}
function summarizeAction(s){
  if (!s || typeof s !== 'object') return '';
  if (s.shared !== undefined) return s.shared ? 'one shared edge connection' : 'distinct edge connections';
  if (s.allDistinct !== undefined) return s.allDistinct ? 'all fresh connections distinct' : 'some connections reused';
  if (s.clientReused !== undefined) return `client ${s.clientReused ? 'reused' : 'renewed'}`;
  if (s.complete !== undefined) return s.complete ? `completed in ${s.ms}ms` : 'interrupted';
  if (s.pod) return `serving pod ${s.pod}`;
  if (s.rolled) return 'rollout finished';
  if (s.profile) return `background ${s.profile} started`;
  if (s.total !== undefined) return `${s.total} background requests sent`;
  return s.action || '';
}
async function loadAction(action){
  const profile=$('load-profile').value;
  const durationMs=(Number($('load-duration')?.value) || 180) * 1000;
  if (!selectedRun) { $('load-state').textContent = 'Create a run first.'; return; }
  const r=await fetch(`/api/runs/${selectedRun}/load`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,profile,durationMs})});
  if(!r.ok){const b=await r.json();$('load-state').textContent=b.error;}
  refresh();
}
$('run-select').onchange=()=>{bumpEpoch();selectedRun=$('run-select').value || null; lastRunResultKey = null; lastEventRev = -1; $('verdict').innerHTML='<div class="empty">Run the experiment to see evidence and checks.</div>';$('verdict').dataset.key=''; window.dispatchEvent(new CustomEvent('lab:select')); refresh();};
$('run-new').onclick=async()=>{
  await createRunForLesson(lessons[current].id, $('run-panel-state'));
  refresh();
};
async function downloadEvidence(runId){
  const url = runId ? `/api/evidence?run=${runId}` : '/api/evidence';
  const r=await fetch(url);
  if(!r.ok){const b=await r.json();$('run-panel-state').textContent=b.error;return;}
  const data=await r.json();
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const link=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=link;a.download=`scaling-lab-evidence-${runId||'legacy'}-${Date.now()}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(link),1000);
}
$('run-evidence').onclick=()=>downloadEvidence(selectedRun);
let cleanupRun = null;
$('run-cleanup-open').onclick=()=>{
  if(!selectedRun){$('run-panel-state').textContent='Select a run to clean up.';return;}
  cleanupRun=selectedRun;
  $('cleanup-text').innerHTML=`This deletes namespace <code>scaling-run-${escape(selectedRun)}</code> and stops its traffic. Other runs are untouched; its evidence stays downloadable.`;
  $('cleanup-status').textContent='';
  $('cleanup-dialog').showModal();
};
$('cleanup-cancel').onclick=()=>{cleanupRun=null;$('cleanup-dialog').close();};
$('cleanup-download').onclick=()=>downloadEvidence(cleanupRun);
$('cleanup-confirm').onclick=async()=>{
  $('cleanup-status').textContent='Cleaning up: stopping traffic, snapshotting evidence, deleting namespace…';
  const r=await fetch(`/api/runs/${cleanupRun}`,{method:'DELETE'});
  if(!r.ok){const b=await r.json();$('cleanup-status').textContent=`Cleanup failed: ${b.error} — fix and retry, or Cancel.`;return;}
  for (let i=0;i<24;i++){
    await new Promise(x=>setTimeout(x,5000));
    const s=await fetch('/api/state').then(x=>x.json());
    const gone=!(s.runs||[]).some(x=>x.id===cleanupRun&&(x.status==='ready'||x.status==='creating'||x.status==='deleting'));
    if(gone) break;
  }
  const s=await fetch('/api/state').then(x=>x.json());
  const rec=(s.runs||[]).find(x=>x.id===cleanupRun);
  if(rec && rec.status==='cleanup-failed'){$('cleanup-status').textContent=`Cleanup failed: ${rec.error} — retry Confirm, or Cancel.`;return;}
  $('cleanup-dialog').close();
  if(selectedRun===cleanupRun) { selectedRun=null; bumpEpoch(); }
  cleanupRun=null; refresh();
};
$('load-start').onclick=()=>loadAction('start');
$('load-inc').onclick=()=>loadAction('increase');
$('load-dec').onclick=()=>loadAction('decrease');
$('load-stop').onclick=()=>loadAction('stop');
async function predictClick(b){
  const btn = b?.dataset ? b : this;
  const body = { guess: btn.dataset.guess, lesson: lessons[current].id };
  if (selectedRun) body.run = selectedRun;
  const r = await fetch('/api/predict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){const e=await r.json();$('predict-state').textContent=e.error;return;}
  $('predict-state').textContent=`Predicted. Now observe, then reveal the explanation.`;
  refresh();
}
document.querySelectorAll('[data-guess]').forEach(b=>b.onclick=predictClick);
$('predict-reveal').onclick=async()=>{
  const body = { lesson: lessons[current].id };
  if (selectedRun) body.run = selectedRun;
  const r=await fetch('/api/reveal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){const e=await r.json();$('predict-state').textContent=e.error;return;}
  const b=await r.json();$('predict-state').textContent=b.explanation;
  const box=$('timeline-explain'); if(box) box.textContent=b.explanation;
  refresh();
};
let bootSaved = null;
try { bootSaved = loadSelection(); } catch { /* start fresh */ }
select(bootSaved ? bootSaved.index : 0);
if (bootSaved && bootSaved.run) selectedRun = bootSaved.run;
refresh();setInterval(refresh,1500);
// Restore validation happens in refresh: unknown or mismatched runs are
// dropped, and server-side load is only ever reconnected to, never restarted.
