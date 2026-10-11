import { useEffect, useState } from 'react';
import { Card, CardContent } from './card.jsx';

const FRAMES = [
  [['Client opens a connection to the edge proxy.', 0], ['The proxy chooses its own connection to the Node.js pod.', 1], ['The next client request reuses the client-to-edge socket.', 0], ['A fresh client socket gets a new edge connection ID.', 0]],
  [['Client and proxy keep their connection open.', 0], ['Node.js closes its upstream socket after about six idle seconds.', 3], ['The client reuses its socket to the proxy.', 1], ['The proxy opens a new socket to the app.', 3]],
  [['A long request reaches one Node.js pod.', 3], ['Kubernetes marks that pod terminating.', 2], ['SIGTERM reaches the pod after preStop. The active response can finish.', 3], ['The old pod exits; new requests use ready pods.', 2]],
  [['Old pods serve traffic while a new pod starts.', 3], ['The new pod passes readiness and joins the Service.', 2], ['An old pod drains active work before exiting.', 3], ['Traffic continues through available replicas.', 2]],
  [['The pod begins sending a response in small chunks.', 3], ['Kubernetes marks the serving pod terminating.', 2], ['The active stream continues during graceful shutdown.', 3], ['The final chunk arrives; the pod can exit.', 0]],
  [['Clients create CPU demand in the app pods.', 1], ['Metrics-server reports CPU usage relative to requests.', 2], ['The HPA asks the Deployment for more replicas.', 3], ['New ready pods share subsequent requests.', 1]],
  [['App pods count each HTTP request and expose /metrics.', 0], ['Prometheus scrapes every app pod and calculates requests per second.', 1], ['KEDA queries Prometheus and offers that rate as an external HPA metric.', 2], ['The HPA changes replica count; each pod gets a share of traffic.', 3]],
];

const LABELS = [
  ['Client', 'Edge', 'Service', 'Pod'],
  ['Client', 'Edge', 'Service', 'Pod'],
  ['Client', 'Edge', 'Service', 'Pod'],
  ['Client', 'Edge', 'Service', 'Pod'],
  ['Client', 'Edge', 'Service', 'Pod'],
  ['Client', 'App', 'Metrics', 'HPA'],
  ['App', 'Prometheus', 'KEDA', 'HPA'],
];

export function Diagram({ lessonIndex }) {
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [lessonIndex]);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % 4), 2600);
    return () => clearInterval(t);
  }, [lessonIndex]);
  const frames = FRAMES[lessonIndex] || FRAMES[0];
  const labels = LABELS[lessonIndex] || LABELS[0];
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
