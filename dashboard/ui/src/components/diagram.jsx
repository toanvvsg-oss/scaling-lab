import { useEffect, useState } from 'react';
import { Card, CardContent } from './card.jsx';

// Diagrams keyed by stable lesson ID (never by catalog index, so chapter
// reordering cannot mismatch a lesson with another lesson's picture).
const DIAGRAMS = {
  connections: { labels: ['Client', 'Edge', 'Service', 'Pod'], frames: [['Client opens a connection to the edge proxy.', 0], ['The proxy chooses its own connection to the Node.js pod.', 1], ['The next client request reuses the client-to-edge socket.', 0], ['A fresh client socket gets a new edge connection ID.', 0]] },
  timeouts: { labels: ['Client', 'Edge', 'Service', 'Pod'], frames: [['Client and proxy keep their connection open.', 0], ['Node.js closes its upstream socket after about six idle seconds.', 3], ['The client reuses its socket to the proxy.', 1], ['The proxy opens a new socket to the app.', 3]] },
  shutdown: { labels: ['Client', 'Edge', 'Service', 'Pod'], frames: [['A long request reaches one Node.js pod.', 3], ['Kubernetes marks that pod terminating.', 2], ['SIGTERM reaches the pod after preStop. The active response can finish.', 3], ['The old pod exits; new requests use ready pods.', 2]] },
  rollout: { labels: ['Client', 'Edge', 'Service', 'Pod'], frames: [['Old pods serve traffic while a new pod starts.', 3], ['The new pod passes readiness and joins the Service.', 2], ['An old pod drains active work before exiting.', 3], ['Traffic continues through available replicas.', 2]] },
  streaming: { labels: ['Client', 'Edge', 'Service', 'Pod'], frames: [['The pod begins sending a response in small chunks.', 3], ['Kubernetes marks the serving pod terminating.', 2], ['The active stream continues during graceful shutdown.', 3], ['The final chunk arrives; the pod can exit.', 0]] },
  autoscale: { labels: ['Client', 'App', 'Metrics', 'HPA'], frames: [['Clients create CPU demand in the app pods.', 1], ['Metrics-server reports CPU usage relative to requests.', 2], ['The HPA asks the Deployment for more replicas.', 3], ['New ready pods share subsequent requests.', 1]] },
  prometheus: { labels: ['App', 'Prometheus', 'KEDA', 'HPA'], frames: [['App pods count each HTTP request and expose /metrics.', 0], ['Prometheus scrapes every app pod and calculates requests per second.', 1], ['KEDA queries Prometheus and offers that rate as an external HPA metric.', 2], ['The HPA changes replica count; each pod gets a share of traffic.', 3]] },
  capacity: { labels: ['Generator', 'Edge', 'One pod', 'Objective'], frames: [['The generator offers a fixed rate, independent of completions.', 0], ['The single pod serves, queues, or times out each offer.', 2], ['Dropped and missed offers mark generator limits, not service capacity.', 0], ['The highest generator-clean rate meeting the objective is its capacity.', 3]] },
  resources: { labels: ['Traffic', 'Request', 'Limit', 'HPA'], frames: [['Steady CPU traffic flows at a constant rate.', 0], ['Raising the CPU request shrinks utilization without new work.', 1], ['A tight CPU limit throttles; cpu.stat counts it directly.', 2], ['A tight memory limit kills; restarts plus OOMKilled prove it.', 2]] },
  signals: { labels: ['Work', 'RPS', 'CPU', 'Queue'], frames: [['Equal RPS can hide different work: CPU burn or slow I/O.', 0], ['CPU utilization sees the burn and misses the waiting.', 2], ['Backlog and oldest-message age see the waiting.', 3], ['Workers scale from backlog; drain time is the objective.', 3]] },
  hpareact: { labels: ['Load', 'Metric', 'HPA', 'Ready'], frames: [['A burst raises the observed metric after sampling delay.', 1], ['The HPA decides desired replicas from current × observed ÷ target.', 2], ['Tolerance, bounds, and missing metrics shape the decision.', 2], ['Scheduled pods pass readiness before they serve.', 3]] },
  pending: { labels: ['HPA', 'Scheduler', 'Nodes', 'Pods'], frames: [['The HPA desires replicas that cannot run yet.', 0], ['Constraints or full nodes leave pods Pending with reasons.', 1], ['Desired, scheduled, Running, and Ready disagree.', 3], ['Only schedulable node capacity clears Pending.', 2]] },
  downstream: { labels: ['Callers', 'Pool', 'Dep', 'Policy'], frames: [['More caller replicas push more load downstream.', 0], ['The fixed-concurrency dependency saturates; queues grow.', 2], ['Aggressive retries multiply attempts without adding capacity.', 2], ['Fail-fast plus shedding protects timely success.', 3]] },
  disruptions: { labels: ['Traffic', 'PDB', 'Evict', 'Delete'], frames: [['Background traffic flows across three pods.', 0], ['The budget allows one ordered eviction.', 1], ['A second eviction is refused while the budget is exhausted.', 2], ['Direct deletion bypasses the budget entirely.', 3]] },
  gateway: { labels: ['Client', 'Backend', 'Endpoints', 'Drain'], frames: [['A request drains from a pod under traffic.', 0], ['Endpoint removal and response completion race.', 2], ['Recorded order decides the verdict for this drain.', 2], ['GKE Gateway/NEG steps stay pending explicit cloud configuration.', 1]] },
  capstone: { labels: ['Burst', 'Rollout', 'Disrupt', 'Recover'], frames: [['Elevated load tests the objective first.', 0], ['A rolling update must not breach it.', 1], ['A guarded eviction must not breach it either.', 2], ['Recovery settles; the report carries raw evidence.', 3]] },
};

export function Diagram({ lessonId, lessonIndex }) {
  // lessonId is authoritative; lessonIndex remains as a legacy fallback.
  const key = (lessonId && DIAGRAMS[lessonId]) ? lessonId : Object.keys(DIAGRAMS)[lessonIndex] || 'connections';
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [key]);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % 4), 2600);
    return () => clearInterval(t);
  }, [key]);
  const { frames, labels } = DIAGRAMS[key];
  const [caption, active] = frames[step];
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Concept in motion (illustrative)</h3>
          <button className="text-xs underline" onClick={() => setStep(0)}>Replay</button>
        </div>
        <div className="flex items-center gap-2">
          {labels.map((label, i) => (
            <div key={label + i} className="flex flex-1 items-center gap-2">
              <div className={`flex-1 rounded-md border p-2 text-center text-xs ${i === active ? 'border-primary bg-secondary font-semibold' : 'bg-background'}`}>
                <div className="font-mono text-[10px] text-muted-foreground">0{i + 1}</div>
                {label}
              </div>
              {i < labels.length - 1 && <span className="text-muted-foreground">→</span>}
            </div>
          ))}
        </div>
        <p className="text-sm"><span className="font-mono text-xs text-muted-foreground">0{step + 1} / 04 · </span>{caption}</p>
        <div className="flex gap-1">
          {frames.map((_, i) => (
            <button key={i} aria-label={`Show step ${i + 1}`} onClick={() => setStep(i)} className={`h-2 w-2 rounded-full ${i === step ? 'bg-primary' : 'bg-border'}`} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
