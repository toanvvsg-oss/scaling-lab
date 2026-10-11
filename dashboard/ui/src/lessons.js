export const LESSONS = [
  { id: 'connections', title: 'Connection reuse', time: '5 MIN', intro: 'Find out which requests share a client connection and which open a new one.', concept: 'HTTP keep-alive lets one TCP connection carry multiple requests. The edge proxy may use a separate pool of connections to Node.js, so client-to-edge and edge-to-app reuse are different observations.', task: 'Create a run, then send eight sequential requests with a reused client socket and eight with fresh sockets. Compare the edge connection IDs in the evidence.', quiz: 'If one client socket is reused, must the proxy reuse the same socket to Node.js?', answers: ['Yes, both sides are one connection', 'No, the proxy has a separate upstream pool'], correct: 1, why: 'The proxy terminates the client connection and chooses its own upstream connection.', guesses: [['share', 'Share one edge connection'], ['same', 'No change'], ['fresh', 'Open fresh connections']], predict: 'Will the 8 reused requests share one edge connection ID?', act: 'Run the experiment in your run, then inspect the trace below.' },
  { id: 'timeouts', title: 'Idle timeouts', time: '1 MIN', intro: 'See the client and proxy keep one connection while Node.js closes another.', concept: 'Each hop has its own idle timeout. The client-to-edge socket can remain open after Node.js closes the proxy-to-app socket; the next request then needs a new upstream connection. Node.js is configured with a 5s keep-alive plus a 1s close buffer, so upstream sockets go idle at about six seconds.', task: 'Create a run, then compare a one-second idle gap with a 6.5-second gap. The app effective upstream budget is about six seconds (5s keep-alive + 1s buffer on recent Node). Inspect both connection IDs.', quiz: 'If the Node.js upstream socket expires, must the client open a new socket to the proxy?', answers: ['Yes, the entire path closes', 'No, the proxy can reconnect upstream'], correct: 1, why: 'The proxy owns two independent socket pools.', guesses: [['up', 'Both connections survive'], ['same', 'No change'], ['down', 'Upstream expires']], predict: 'Will the client socket survive both idle gaps?', act: 'Run the experiment, then compare short-gap and long-gap connection IDs.' },
  { id: 'shutdown', title: 'Graceful shutdown', time: '2 MIN', intro: 'Delete the exact pod serving a long request while new requests continue.', concept: 'Pod termination starts a grace deadline. The preStop hook runs before SIGTERM and consumes part of that deadline. Node.js can stop accepting new work while active HTTP requests finish.', task: 'Create a run, then choose graceful or abrupt exit. The runner starts an eight-second request, reads its pod ID, and deletes that pod inside the run namespace. Watch the long request and background traffic.', quiz: 'Does a failed readiness probe finish requests already in flight?', answers: ['Yes, it closes them', 'No, the application must finish them'], correct: 1, why: 'Readiness affects endpoint selection for new traffic. The application controls active requests.', guesses: [['up', 'Long request completes'], ['same', 'No change'], ['down', 'Request interrupted']], predict: 'Will the 8s request finish despite its pod being deleted?', act: 'Pick a shutdown mode, run the experiment, then read the signal trace.' },
  { id: 'rollout', title: 'Rolling deployment', time: '2 MIN', intro: 'Replace the application pods while a stream of requests keeps arriving.', concept: 'A Deployment can start an extra pod before stopping an old one. Readiness gates traffic to new pods; the shutdown path matters when old pods are removed.', task: 'Create a run, then start a rolling update with maxSurge 1 and maxUnavailable 0 inside the run namespace. Verify that new pod IDs appear and sampled requests keep succeeding.', quiz: 'What does maxUnavailable: 0 require during a rollout?', answers: ['No pod may terminate', 'The required number of available replicas is maintained'], correct: 1, why: 'Old pods may terminate once replacement capacity becomes available.', guesses: [['up', 'New pods serve traffic'], ['same', 'No change'], ['down', 'Some requests fail']], predict: 'Will any sampled request fail while pods are replaced?', act: 'Run the experiment and watch pod IDs turn over with zero failures.' },
  { id: 'streaming', title: 'Streaming drain', time: '2 MIN', intro: 'Delete a pod while it is sending a response in pieces.', concept: 'A streaming response stays active much longer than a fast JSON response. Graceful shutdown must allow it to finish or set an explicit stream policy and deadline.', task: 'Create a run, then start a 20-tick stream, delete its pod after the first ticks, and verify that every tick arrives before the process exits.', quiz: 'Does server.close() instantly terminate an active HTTP stream?', answers: ['Yes, it closes all sockets', 'No, the active response can continue'], correct: 1, why: 'Node.js stops new connections and waits for active HTTP requests; the shutdown deadline can still force an exit.', guesses: [['up', 'All 20 ticks arrive'], ['same', 'No change'], ['down', 'Stream resets']], predict: 'Will all 20 ticks arrive after the serving pod is deleted?', act: 'Run the experiment and count ticks in the trace.' },
  { id: 'autoscale', title: 'Autoscaling', time: '4 MIN', intro: 'Apply CPU load, then watch the HPA add and remove application replicas.', concept: 'CPU utilization for HPA is measured relative to container CPU requests. Metrics collection and HPA reconciliation take time; scale down also waits through a stabilization window.', task: "Create a run — it provisions its own CPU HPA. Run the sustained CPU experiment inside the run, or drive CPU manually, then watch replicas scale down.", quiz: 'If the app has no CPU request, can a CPU utilization target be calculated?', answers: ['Yes, from the CPU limit', 'No, utilization needs a request'], correct: 1, why: 'The HPA uses the resource request as the denominator for CPU utilization.', guesses: [['up', 'Replicas scale up'], ['same', 'Stay'], ['down', 'Scale back down']], predict: 'Will replicas rise, and how long will scale-down take?', act: 'Run the experiment or start a CPU profile, then follow CPU % vs the 60% target.' },
  { id: 'prometheus', title: 'Prometheus scaling', time: '5 MIN', intro: 'Scale from observed HTTP request rate instead of CPU usage.', concept: 'Each pod exposes a request counter. Prometheus scrapes those counters and calculates requests per second with PromQL. KEDA reads that query as an external metric and supplies it to a Kubernetes HPA.', task: "Create a run — it provisions its own KEDA scaler. Use manual steady/ramp/burst traffic, then reduce/stop it. Follow offered RPS, scraped RPS, desired replicas, and Ready pods through scale up and scale down. The HPA lags traffic.", quiz: 'Which component turns the Prometheus query into a scaling metric for the HPA?', answers: ['Prometheus itself', 'KEDA metrics API server'], correct: 1, why: 'KEDA queries Prometheus and exposes an external metric. The HPA uses that metric to choose replicas.', guesses: [['up', 'Replicas scale up'], ['same', 'Stay'], ['down', 'Scale back down']], predict: 'After a burst, what moves first: scraped RPS, desired replicas, or Ready pods?', act: 'Start a profile, change it mid-run, then stop and watch scale-in order.' },
];

export const ACTION_DEFS = {
  connections: [
    ['reuse-batch', 'Send 8 reused requests'],
    ['fresh-batch', 'Send 8 fresh requests'],
    ['demo-404', 'Demo app 404'],
    ['demo-500', 'Demo app 500'],
  ],
  timeouts: [
    ['short-gap', 'Probe 1s idle gap'],
    ['long-gap', 'Probe 6.5s idle gap'],
  ],
  shutdown: [
    ['start-long', 'Start 8s request'],
    ['terminate-serving', 'Delete serving pod'],
  ],
  streaming: [
    ['start-stream', 'Start 20-tick stream'],
    ['terminate-serving', 'Delete serving pod'],
  ],
  rollout: [
    ['bg-start', 'Start background traffic'],
    ['trigger-rollout', 'Trigger rollout'],
    ['bg-stop', 'Stop background traffic'],
  ],
  autoscale: [],
  prometheus: [],
};

export const TIMELINE_HEADINGS = {
  prometheus: 'Cause ↔ effect timeline (req/s · replicas · target 5 req/s per pod)',
  autoscale: 'Cause ↔ effect timeline (CPU % · replicas · target 60%)',
  connections: 'Request timeline (requests · connection IDs)',
  timeouts: 'Request timeline (requests · connection IDs)',
  shutdown: 'Shutdown timeline (requests · pod signals)',
  rollout: 'Rollout timeline (requests · pods)',
  streaming: 'Stream timeline (ticks · pod signals)',
};

export const STEPS = ['baseline', 'predict', 'act', 'observe', 'explain', 'checks'];
