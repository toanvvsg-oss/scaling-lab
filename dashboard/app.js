const lessons = [
  { id:'connections', title:'Connection reuse', time:'5 MIN', reset:'baseline', intro:'Find out which requests share a client connection and which open a new one.', concept:'HTTP keep-alive lets one TCP connection carry multiple requests. The edge proxy may use a separate pool of connections to Node.js, so client-to-edge and edge-to-app reuse are different observations.', task:'Send eight sequential requests with a reused client socket, then eight with fresh sockets. Compare the edge connection IDs in the evidence.', quiz:'If one client socket is reused, must the proxy reuse the same socket to Node.js?', answers:['Yes, both sides are one connection','No, the proxy has a separate upstream pool'], correct:1, why:'The proxy terminates the client connection and chooses its own upstream connection.' },
  { id:'timeouts', title:'Idle timeouts', time:'1 MIN', reset:'baseline', intro:'See the client and proxy keep one connection while Node.js closes another.', concept:'Each hop has its own idle timeout. The client-to-edge socket can remain open after Node.js closes the proxy-to-app socket; the next request then needs a new upstream connection.', task:'Compare a one-second idle gap with a 6.5-second gap. The app has a five-second HTTP keep-alive timeout. Inspect both connection IDs.', quiz:'If the Node.js upstream socket expires, must the client open a new socket to the proxy?', answers:['Yes, the entire path closes','No, the proxy can reconnect upstream'], correct:1, why:'The proxy owns two independent socket pools.' },
  { id:'shutdown', title:'Graceful shutdown', time:'2 MIN', reset:'baseline', intro:'Delete the exact pod serving a long request while new requests continue.', concept:'Pod termination starts a grace deadline. The preStop hook runs before SIGTERM and consumes part of that deadline. Node.js can stop accepting new work while active HTTP requests finish.', task:'Choose graceful or abrupt exit. The runner starts an eight-second request, reads its pod ID, and deletes that pod. Watch the long request and background traffic.', quiz:'Does a failed readiness probe finish requests already in flight?', answers:['Yes, it closes them','No, the application must finish them'], correct:1, why:'Readiness affects endpoint selection for new traffic. The application controls active requests.' },
  { id:'rollout', title:'Rolling deployment', time:'2 MIN', reset:'baseline', intro:'Replace the application pods while a stream of requests keeps arriving.', concept:'A Deployment can start an extra pod before stopping an old one. Readiness gates traffic to new pods; the shutdown path matters when old pods are removed.', task:'Start a rolling update with maxSurge 1 and maxUnavailable 0. Verify that new pod IDs appear and sampled requests keep succeeding.', quiz:'What does maxUnavailable: 0 require during a rollout?', answers:['No pod may terminate','The required number of available replicas is maintained'], correct:1, why:'Old pods may terminate once replacement capacity becomes available.' },
  { id:'streaming', title:'Streaming drain', time:'2 MIN', reset:'baseline', intro:'Delete a pod while it is sending a response in pieces.', concept:'A streaming response stays active much longer than a fast JSON response. Graceful shutdown must allow it to finish or set an explicit stream policy and deadline.', task:'Start a 20-tick stream, delete its pod after the first ticks, and verify that every tick arrives before the process exits.', quiz:'Does server.close() instantly terminate an active HTTP stream?', answers:['Yes, it closes all sockets','No, the active response can continue'], correct:1, why:'Node.js stops new connections and waits for active HTTP requests; the shutdown deadline can still force an exit.' },
  { id:'autoscale', title:'Autoscaling', time:'4 MIN', reset:'cpu', intro:'Apply CPU load, then watch the HPA add and remove application replicas.', concept:'CPU utilization for HPA is measured relative to container CPU requests. Metrics collection and HPA reconciliation take time; scale down also waits through a stabilization window.', task:'Install metrics-server and enable the HPA with make hpa-up. Run sustained CPU load, then keep sending light traffic as replicas scale down. Manual load uses /fast request rate; the one-click check uses CPU burn.', quiz:'If the app has no CPU request, can a CPU utilization target be calculated?', answers:['Yes, from the CPU limit','No, utilization needs a request'], correct:1, why:'The HPA uses the resource request as the denominator for CPU utilization.' },
  { id:'prometheus', title:'Prometheus scaling', time:'5 MIN', reset:'prometheus', intro:'Scale from observed HTTP request rate instead of CPU usage.', concept:'Each pod exposes a request counter. Prometheus scrapes those counters and calculates requests per second with PromQL. KEDA reads that query as an external metric and supplies it to a Kubernetes HPA.', task:'Run make prometheus-up first. Use manual steady/ramp/burst traffic, then reduce/stop it. Follow offered RPS, scraped RPS, desired replicas, and Ready pods through scale up and scale down. The HPA lags traffic.', quiz:'Which component turns the Prometheus query into a scaling metric for the HPA?', answers:['Prometheus itself','KEDA metrics API server'], correct:1, why:'KEDA queries Prometheus and exposes an external metric. The HPA uses that metric to choose replicas.' }
];
const $ = id => document.getElementById(id);
let current = 0, lastEventCount = 0, pendingLesson = null;
function escape(s){return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function select(index){
  // Opening another lesson never mutates the cluster. If the target lesson needs a
  // different autoscaler, prompt for a confirmed reset instead of switching silently.
  const next = lessons[index];
  const needs = next.reset;
  const currentReset = lessons[current]?.reset;
  if (pendingLesson == null && needs !== currentReset && (needs === 'cpu' || needs === 'prometheus' || currentReset === 'cpu' || currentReset === 'prometheus')) {
    pendingLesson = index;
    $('reset-target').value = needs;
    $('reset-status').textContent = `Lesson “${next.title}” needs the ${needs === 'cpu' ? 'CPU HPA (make hpa-up)' : 'Prometheus KEDA scaler (make prometheus-up)'}. Confirm to replace the autoscaler, or Cancel to stay.`;
    $('reset-dialog').showModal();
    return;
  }
  pendingLesson = null;
  current=index;const l=lessons[index];
  $('lessons').innerHTML=lessons.map((x,i)=>`<button class="lesson-link ${i===index?'active':''}" data-index="${i}"><span class="num">0${i+1}</span>${escape(x.title)}</button>`).join('');
  document.querySelectorAll('.lesson-link').forEach(x=>x.onclick=()=>select(Number(x.dataset.index)));
  $('lesson-number').textContent=`LAB 0${index+1} / 07`;$('lesson-time').textContent=l.time;$('lesson-title').textContent=l.title;$('lesson-intro').textContent=l.intro;$('lesson-concept').textContent=l.concept;$('lesson-task').textContent=l.task;
  $('options').innerHTML=l.id==='shutdown'?'<label class="option-row">Shutdown mode <select id="mode"><option value="graceful">Graceful</option><option value="abrupt">Abrupt (failure demonstration)</option></select></label>':'';
  $('load-panel').hidden = !(l.id === 'prometheus' || l.id === 'autoscale');
  $('quiz-question').textContent=l.quiz;$('quiz-options').innerHTML=l.answers.map((x,i)=>`<button class="quiz-choice" data-answer="${i}">${escape(x)}</button>`).join('');$('quiz-feedback').textContent='';
  document.querySelectorAll('.quiz-choice').forEach(x=>x.onclick=()=>{const right=Number(x.dataset.answer)===l.correct;x.classList.add(right?'correct':'wrong');$('quiz-feedback').textContent=(right?'Correct. ':'Try again. ')+l.why;});
  $('verdict').innerHTML='<div class="empty">Run the experiment to see evidence and checks.</div>';
}
function renderResult(result){if(!result||document.querySelector("#verdict .verdict-card"))return;const checks=result.checks.map(x=>`<div class="check"><b class="${x.pass?'':'no'}">${x.pass?'✓':'✕'}</b><span>${escape(x.label)}</span></div>`).join('');$('verdict').innerHTML=`<div class="verdict-card ${escape(result.status)}"><div class="verdict-title">${escape(result.status)}</div>${checks}<details><summary style="margin-top:16px;font-size:11px;cursor:pointer">Show raw evidence</summary><pre class="evidence">${escape(JSON.stringify(result.evidence,null,2))}</pre></details></div>`;}
function renderEvents(events){const box=$('timeline');if(!events.length){box.innerHTML='<p class="timeline-empty">Events appear here as the scenario runs.</p>';return;}box.innerHTML=events.slice(-80).reverse().map(x=>{const d=x.data||{};let message=d.text||d.pod||d.status||'';if(x.type==='request')message=`${d.ok?'200':'ERROR'} · ${d.pod||'edge'} · ${d.ms||0}ms`;if(x.type==='slow-end')message=`${d.complete?'completed':'interrupted'} · ${d.pod}`;return `<div class="event ${x.type==='error'?'error':''}"><time>${new Date(x.at).toLocaleTimeString()}</time><strong>${escape(x.type.replaceAll('-',' '))}</strong>${escape(message)}</div>`;}).join('');}
async function refresh(){
  try{
    const [state,cluster]=await Promise.all([fetch('/api/state').then(x=>x.json()),fetch('/api/cluster').then(x=>x.json())]);
    $('cluster-dot').classList.toggle('good',cluster.connected);
    $('cluster-label').textContent=cluster.connected?'kind cluster connected':'Cluster offline';
    $('pods').innerHTML=cluster.pods?.length?cluster.pods.map(x=>`<div class="pod ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.name)}">${escape(x.name)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No application pods';
    $('endpoints').innerHTML=cluster.endpoints?.length?cluster.endpoints.map(x=>`<div class="endpoint ${x.terminating?'terminating':x.ready?'':'not-ready'}" title="${escape(x.pod)}">${escape(x.pod)} · ${x.terminating?'terminating':x.ready?'ready':'not ready'}</div>`).join(''):'No endpoints';
    $('run').disabled=state.running||state.resetting;
    $('run-state').textContent=state.error||(state.resetting?'Reset in progress…':state.running?'Scenario running…':'');
    const load = state.load;
    $('live-pill').textContent=state.resetting?'RESETTING':state.running||load?.active?'LIVE':'IDLE';
    if (load?.active) {
      const secs = Math.floor((load.elapsedMs||0)/1000);
      $('load-state').textContent = `${load.profile} · target ${load.targetRps} req/s · elapsed ${secs}s · total ${load.total} (${load.failures} failures) · phase ${load.profile}`;
    } else {$('load-state').textContent = state.resetting ? 'Reset in progress — traffic stopped.' : 'Manual load idle.';}
    if(state.resetting && $('reset-dialog').open){$('reset-status').textContent='Reset running: stopping traffic, removing old scaler, restoring baseline, waiting for 2 Ready pods…';}
    if(!state.resetting && $('reset-dialog').open && /Reset running/.test($('reset-status').textContent)){$('reset-dialog').close(); if(pendingLesson!=null){const i=pendingLesson; pendingLesson=null; select(i);} refresh();}
    if(state.events.length!==lastEventCount){renderEvents(state.events);lastEventCount=state.events.length;}
    if(state.result&&state.scenario===lessons[current].id)renderResult(state.result);
    if(state.error&&!state.resetting)$('run-state').textContent=state.error;
  }catch(error){$('cluster-label').textContent='Dashboard disconnected';}
}
$('run').onclick=async()=>{const l=lessons[current];$('verdict').innerHTML='<div class="empty">Collecting evidence…</div>';lastEventCount=0;renderEvents([]);const response=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,mode:$('mode')?.value})});if(!response.ok){const body=await response.json();$('verdict').innerHTML=`<div class="empty">${escape(body.error)}</div>`;}refresh();};
$('reset-open').onclick=()=>{$('reset-target').value=lessons[current].reset;$('reset-status').textContent='';$('reset-dialog').showModal();};
$('reset-cancel').onclick=()=>{pendingLesson=null;$('reset-dialog').close();};
$('reset-download').onclick=async()=>{const data=await fetch('/api/evidence').then(r=>r.json());const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`scaling-lab-evidence-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('reset-confirm').onclick=async()=>{
  $('reset-status').textContent='Reset running: stopping traffic, removing old scaler, restoring baseline, waiting for 2 Ready pods…';
  const target=$('reset-target').value;
  const r=await fetch('/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target})});
  if(!r.ok){const b=await r.json();$('reset-status').textContent=`Reset failed: ${b.error} — retry, or run ${target==='cpu'?'make hpa-up':target==='prometheus'?'make prometheus-up':'make reset'} in a terminal.`;return;}
  $('reset-status').textContent='Reset running: stopping traffic, removing old scaler, restoring baseline, waiting for 2 Ready pods…';
};
$('cluster-delete-info').onclick=()=>$('delete-dialog').showModal();
$('delete-cancel').onclick=()=>$('delete-dialog').close();
async function loadAction(action){
  const profile=$('load-profile').value;
  const r=await fetch('/api/load',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,profile})});
  if(!r.ok){const b=await r.json();$('load-state').textContent=b.error;}
  refresh();
}
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
