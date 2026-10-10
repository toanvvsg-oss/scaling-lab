const lessons = [
  { id:'connections', title:'Connection reuse', time:'5 MIN', intro:'Find out which requests share a client connection and which open a new one.', concept:'HTTP keep-alive lets one TCP connection carry multiple requests. The edge proxy may use a separate pool of connections to Node.js, so client-to-edge and edge-to-app reuse are different observations.', task:'Create a run, then send eight sequential requests with a reused client socket and eight with fresh sockets. Compare the edge connection IDs in the evidence.', quiz:'If one client socket is reused, must the proxy reuse the same socket to Node.js?', answers:['Yes, both sides are one connection','No, the proxy has a separate upstream pool'], correct:1, why:'The proxy terminates the client connection and chooses its own upstream connection.' },
  { id:'timeouts', title:'Idle timeouts', time:'1 MIN', intro:'See the client and proxy keep one connection while Node.js closes another.', concept:'Each hop has its own idle timeout. The client-to-edge socket can remain open after Node.js closes the proxy-to-app socket; the next request then needs a new upstream connection.', task:'Create a run, then compare a one-second idle gap with a 6.5-second gap. The app has a five-second HTTP keep-alive timeout. Inspect both connection IDs.', quiz:'If the Node.js upstream socket expires, must the client open a new socket to the proxy?', answers:['Yes, the entire path closes','No, the proxy can reconnect upstream'], correct:1, why:'The proxy owns two independent socket pools.' },
  { id:'shutdown', title:'Graceful shutdown', time:'2 MIN', intro:'Delete the exact pod serving a long request while new requests continue.', concept:'Pod termination starts a grace deadline. The preStop hook runs before SIGTERM and consumes part of that deadline. Node.js can stop accepting new work while active HTTP requests finish.', task:'Create a run, then choose graceful or abrupt exit. The runner starts an eight-second request, reads its pod ID, and deletes that pod inside the run namespace. Watch the long request and background traffic.', quiz:'Does a failed readiness probe finish requests already in flight?', answers:['Yes, it closes them','No, the application must finish them'], correct:1, why:'Readiness affects endpoint selection for new traffic. The application controls active requests.' },
  { id:'rollout', title:'Rolling deployment', time:'2 MIN', intro:'Replace the application pods while a stream of requests keeps arriving.', concept:'A Deployment can start an extra pod before stopping an old one. Readiness gates traffic to new pods; the shutdown path matters when old pods are removed.', task:'Create a run, then start a rolling update with maxSurge 1 and maxUnavailable 0 inside the run namespace. Verify that new pod IDs appear and sampled requests keep succeeding.', quiz:'What does maxUnavailable: 0 require during a rollout?', answers:['No pod may terminate','The required number of available replicas is maintained'], correct:1, why:'Old pods may terminate once replacement capacity becomes available.' },
  { id:'streaming', title:'Streaming drain', time:'2 MIN', intro:'Delete a pod while it is sending a response in pieces.', concept:'A streaming response stays active much longer than a fast JSON response. Graceful shutdown must allow it to finish or set an explicit stream policy and deadline.', task:'Create a run, then start a 20-tick stream, delete its pod after the first ticks, and verify that every tick arrives before the process exits.', quiz:'Does server.close() instantly terminate an active HTTP stream?', answers:['Yes, it closes all sockets','No, the active response can continue'], correct:1, why:'Node.js stops new connections and waits for active HTTP requests; the shutdown deadline can still force an exit.' },
  { id:'autoscale', title:'Autoscaling', time:'4 MIN', intro:'Apply CPU load, then watch the HPA add and remove application replicas.', concept:'CPU utilization for HPA is measured relative to container CPU requests. Metrics collection and HPA reconciliation take time; scale down also waits through a stabilization window.', task:'Create a run — it provisions its own CPU HPA. Run the sustained CPU experiment inside the run, then watch replicas scale down.', quiz:'If the app has no CPU request, can a CPU utilization target be calculated?', answers:['Yes, from the CPU limit','No, utilization needs a request'], correct:1, why:'The HPA uses the resource request as the denominator for CPU utilization.' },
  { id:'prometheus', title:'Prometheus scaling', time:'5 MIN', intro:'Scale from observed HTTP request rate instead of CPU usage.', concept:'Each pod exposes a request counter. Prometheus scrapes those counters and calculates requests per second with PromQL. KEDA reads that query as an external metric and supplies it to a Kubernetes HPA.', task:'Create a run — it provisions its own KEDA scaler. Use manual steady/ramp/burst traffic, then reduce/stop it. Follow offered RPS, scraped RPS, desired replicas, and Ready pods through scale up and scale down. The HPA lags traffic.', quiz:'Which component turns the Prometheus query into a scaling metric for the HPA?', answers:['Prometheus itself','KEDA metrics API server'], correct:1, why:'KEDA queries Prometheus and exposes an external metric. The HPA uses that metric to choose replicas.' }
];
const $ = id => document.getElementById(id);
let current = 0, lastEventCount = 0, selectedRun = null, pendingRun = null, lastRunResultKey = null;
window.labLesson = 'connections'; window.labRun = null;
function escape(s){return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Lesson switching never mutates the cluster: every lesson runs inside its own
// isolated run namespace, so opening another lesson is always safe.
function select(index){
  current=index;const l=lessons[index];
  window.labLesson = l.id;
  $('lessons').innerHTML=lessons.map((x,i)=>`<button class="lesson-link ${i===index?'active':''}" data-index="${i}"><span class="num">0${i+1}</span>${escape(x.title)}</button>`).join('');
  document.querySelectorAll('.lesson-link').forEach(x=>x.onclick=()=>select(Number(x.dataset.index)));
  $('lesson-number').textContent=`LAB 0${index+1} / 07`;$('lesson-time').textContent=l.time;$('lesson-title').textContent=l.title;$('lesson-intro').textContent=l.intro;$('lesson-concept').textContent=l.concept;$('lesson-task').textContent=l.task;
  $('options').innerHTML=l.id==='shutdown'?'<label class="option-row">Shutdown mode <select id="mode"><option value="graceful">Graceful</option><option value="abrupt">Abrupt (failure demonstration)</option></select></label>':'';
  $('load-panel').hidden = l.id !== 'prometheus';
  lastRunResultKey = null; lastEventCount = 0;
  $('quiz-question').textContent=l.quiz;$('quiz-options').innerHTML=l.answers.map((x,i)=>`<button class="quiz-choice" data-answer="${i}">${escape(x)}</button>`).join('');$('quiz-feedback').textContent='';
  document.querySelectorAll('.quiz-choice').forEach(x=>x.onclick=()=>{const right=Number(x.dataset.answer)===l.correct;x.classList.add(right?'correct':'wrong');$('quiz-feedback').textContent=(right?'Correct. ':'Try again. ')+l.why;});
  $('verdict').innerHTML='<div class="empty">Run the experiment to see evidence and checks.</div>';
}
function renderResult(result){if(!result||document.querySelector("#verdict .verdict-card"))return;const checks=result.checks.map(x=>`<div class="check"><b class="${x.pass?'':'no'}">${x.pass?'✓':'✕'}</b><span>${escape(x.label)}</span></div>`).join('');$('verdict').innerHTML=`<div class="verdict-card ${escape(result.status)}"><div class="verdict-title">${escape(result.status)}</div>${checks}<details><summary style="margin-top:16px;font-size:11px;cursor:pointer">Show raw evidence</summary><pre class="evidence">${escape(JSON.stringify(result.evidence,null,2))}</pre></details></div>`;}
function renderEvents(events){const box=$('timeline');if(!events.length){box.innerHTML='<p class="timeline-empty">Events appear here as the scenario runs.</p>';return;}box.innerHTML=events.slice(-80).reverse().map(x=>{const d=x.data||{};let message=d.text||d.pod||d.status||'';if(x.type==='request')message=`${d.ok?'200':'ERROR'} · ${d.pod||'edge'} · ${d.ms||0}ms`;if(x.type==='slow-end')message=`${d.complete?'completed':'interrupted'} · ${d.pod}`;return `<div class="event ${x.type==='error'?'error':''}"><time>${new Date(x.at).toLocaleTimeString()}</time><strong>${escape(x.type.replaceAll('-',' '))}</strong>${escape(message)}</div>`;}).join('');}
async function createRunForLesson(lesson, statusEl){
  const before = await fetch('/api/state').then(x=>x.json());
  const known = new Set((before.runs||[]).map(x=>x.id));
  const r=await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lesson})});
  if(!r.ok){const b=await r.json();if(statusEl)statusEl.textContent=b.error;return null;}
  if(statusEl)statusEl.textContent='Creating run: namespace, app/edge rollout, scaler check…';
  for (let i=0;i<40;i++){
    await new Promise(x=>setTimeout(x,5000));
    const s=await fetch('/api/state').then(x=>x.json());
    const fresh=(s.runs||[]).map(x=>x.id).find(id=>!known.has(id));
    if(fresh){
      const rec=(s.runs||[]).find(x=>x.id===fresh);
      if(rec.status==='failed'){pendingRun=null;if(statusEl)statusEl.textContent=`Run creation failed: ${rec.error}`;return null;}
      pendingRun=fresh; return fresh;
    }
  }
  return null;
}
async function refresh(){
  try{
    const [state,cluster]=await Promise.all([fetch('/api/state').then(x=>x.json()),fetch('/api/cluster').then(x=>x.json())]);
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
    if (!selRec || selRec.lesson !== lesson) selectedRun = null;
    if (!selectedRun && live.length) selectedRun = live[live.length - 1].id;
    window.labRun = selectedRun;
    const sel = $('run-select');
    if (sel) {
      const opts = runs.map(r => `<option value="${escape(r.id)}" ${r.id === selectedRun ? 'selected' : ''}>${escape(r.id)} · ${escape(r.status)}${r.readopted ? ' · re-adopted' : ''} · ${escape(r.namespace)}</option>`).join('');
      if (sel.innerHTML !== opts) sel.innerHTML = opts || '<option value="">no runs</option>';
    }
    const active = (state.runs || []).find(r => r.id === selectedRun);
    // Live observation follows the selected run; without one it shows the shared lab.
    let pods = cluster.pods, endpoints = cluster.endpoints, runDetail = null;
    if (active) {
      try {
        const [rc, rd] = await Promise.all([
          fetch(`/api/runs/${active.id}/cluster`).then(x=>x.json()),
          fetch(`/api/runs/${active.id}`).then(x=>x.json()),
        ]);
        if (rc.connected) { pods = rc.pods; endpoints = rc.endpoints; }
        runDetail = rd;
      } catch { /* keep shared view on error */ }
    }
    $('pods').innerHTML=pods?.length?pods.map(x=>`<div class="pod ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.name)}">${escape(x.name)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No application pods';
    $('endpoints').innerHTML=endpoints?.length?endpoints.map(x=>`<div class="endpoint ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.pod)}">${escape(x.pod)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No endpoints';
    const scenarioBusy = active ? active.scenarioRunning : state.running;
    $('run').disabled=!!scenarioBusy;
    $('run-state').textContent=active ? (active.scenarioRunning ? 'Scenario running…' : active.error || '') : (state.error || '');
    $('live-pill').textContent=(active?.scenarioRunning || active?.load?.active)?'LIVE':'IDLE';
    $('run-panel-state').textContent = active ? `run ${active.id} · ${active.status} · ${active.namespace}${active.error ? ' · error: ' + active.error : ''}${active.status === 'deleted' ? ' · evidence stays downloadable' : ''}` : (pendingRun ? 'Creating run…' : 'No runs for this lesson — create one to start.');
    const liveRuns = (state.runs || []).filter(r => r.status === 'ready' || r.status === 'creating');
    const cap = state.maxActiveRuns || 2;
    $('run-footprint').textContent = liveRuns.length ? `Footprint: ${liveRuns.length}/${cap} active runs · ${liveRuns.length * 2} app pods (100m CPU / 64Mi each) + ${liveRuns.length} edge pod — laptop limit enforced.` : `Footprint: 0/${cap} active runs.`;
    const arch = state.archivedRuns || [];
    const box = $('archived-list');
    box.innerHTML = arch.length ? 'Archived evidence: ' : '';
    arch.forEach(id => {
      const b = document.createElement('button');
      b.className = 'timeline-mark'; b.textContent = id;
      b.onclick = () => downloadEvidence(id);
      box.appendChild(b);
    });
    const effLoad = active ? active.load : null;
    if (effLoad?.active) {
      const secs = Math.floor((effLoad.elapsedMs||0)/1000);
      $('load-state').textContent = `${effLoad.profile} · target ${effLoad.targetRps} req/s · measured ${effLoad.offeredLastSecond ?? 0} req/s · elapsed ${secs}s · total ${effLoad.total} (${effLoad.failures} failures)`;
    } else {$('load-state').textContent = 'Manual load idle.';}
    const events = runDetail ? runDetail.events : state.events;
    if(events.length!==lastEventCount){renderEvents(events);lastEventCount=events.length;}
    if(active && active.resultStatus && active.scenario === lesson){
      const key = `${active.id}:${active.scenario}:${active.resultStatus}`;
      if(key!==lastRunResultKey){
        lastRunResultKey = key;
        const ev = await fetch(`/api/evidence?run=${active.id}`).then(x=>x.json());
        if(ev.result) renderResult(ev.result);
      }
    } else if(state.result&&state.scenario===lesson){renderResult(state.result);}
  }catch(error){$('cluster-label').textContent='Dashboard disconnected';}
}
$('run').onclick=async()=>{
  const l=lessons[current];
  let id = selectedRun;
  const rec = id && await fetch(`/api/runs/${id}`).then(x=>x.ok?x.json():null).catch(()=>null);
  if(!rec || rec.lesson !== l.id || (rec.status !== 'ready' && rec.status !== 'creating')){
    $('verdict').innerHTML='<div class="empty">Creating an isolated run first…</div>';
    id = await createRunForLesson(l.id, $('run-panel-state'));
    if(!id){$('verdict').innerHTML='<div class="empty">Run creation failed. See run status above.</div>';return;}
    for(let i=0;i<40;i++){
      await new Promise(x=>setTimeout(x,5000)); await refresh();
      const s=await fetch('/api/state').then(x=>x.json());
      const r=(s.runs||[]).find(x=>x.id===id);
      if(r && r.status==='ready') break;
    }
  }
  selectedRun = id; lastRunResultKey = null; lastEventCount = 0;
  $('verdict').innerHTML='<div class="empty">Collecting evidence…</div>';renderEvents([]);
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
  $('reset-dialog').close();
  refresh();
};
$('cluster-delete-info').onclick=()=>$('delete-dialog').showModal();
$('delete-cancel').onclick=()=>$('delete-dialog').close();
async function loadAction(action){
  const profile=$('load-profile').value;
  if (lessons[current].id !== 'prometheus' || !selectedRun) { $('load-state').textContent = lessons[current].id === 'prometheus' ? 'Create a run first.' : 'Manual traffic is available in the Prometheus lesson.'; return; }
  const r=await fetch(`/api/runs/${selectedRun}/load`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,profile})});
  if(!r.ok){const b=await r.json();$('load-state').textContent=b.error;}
  refresh();
}
$('run-select').onchange=()=>{selectedRun=$('run-select').value || null; lastRunResultKey = null; lastEventCount = 0; $('verdict').innerHTML='<div class="empty">Run the experiment to see evidence and checks.</div>'; refresh();};
$('run-new').onclick=async()=>{
  const id = await createRunForLesson(lessons[current].id, $('run-panel-state'));
  refresh();
};
async function downloadEvidence(runId){
  const url = runId ? `/api/evidence?run=${runId}` : '/api/evidence';
  const r=await fetch(url);
  if(!r.ok){const b=await r.json();$('run-panel-state').textContent=b.error;return;}
  const data=await r.json();
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const link=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`scaling-lab-evidence-${runId||'legacy'}-${Date.now()}.json`;a.click();
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
  if(!r.ok){const b=await r.json();$('cleanup-status').textContent=`Cleanup failed: ${b.error}`;return;}
  for (let i=0;i<24;i++){
    await new Promise(x=>setTimeout(x,5000));
    const s=await fetch('/api/state').then(x=>x.json());
    const gone=!(s.runs||[]).some(x=>x.id===cleanupRun&&(x.status==='ready'||x.status==='creating'||x.status==='deleting'));
    if(gone) break;
  }
  $('cleanup-dialog').close();
  if(selectedRun===cleanupRun) selectedRun=null;
  cleanupRun=null; refresh();
};
$('load-start').onclick=()=>loadAction('start');
$('load-inc').onclick=()=>loadAction('increase');
$('load-dec').onclick=()=>loadAction('decrease');
$('load-stop').onclick=()=>loadAction('stop');
document.querySelectorAll('[data-guess]').forEach(b=>b.onclick=async()=>{
  await fetch('/api/predict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({guess:b.dataset.guess})});
  $('predict-state').textContent=`Predicted “${b.dataset.guess}”. Now watch offered → scraped → desired → Ready, then Reveal.`;
});
$('predict-reveal').onclick=async()=>{
  const r=await fetch('/api/reveal',{method:'POST'});
  if(!r.ok){$('predict-state').textContent='Record a prediction first.';return;}
  const b=await r.json();$('predict-state').textContent=b.explanation;
};
select(0);refresh();setInterval(refresh,1500);
