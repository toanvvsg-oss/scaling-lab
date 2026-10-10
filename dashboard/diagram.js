const frames = [
  [
    ['Client opens a connection to the edge proxy.', 0, 'play'],
    ['The proxy chooses its own connection to the Node.js pod.', 1, 'play'],
    ['The next client request reuses the client-to-edge socket.', 0, 'play'],
    ['A fresh client socket gets a new edge connection ID.', 0, 'play']
  ],
  [
    ['Client and proxy keep their connection open.', 0, 'play'],
    ['Node.js closes its upstream socket after five idle seconds.', 3, 'still'],
    ['The client reuses its socket to the proxy.', 1, 'play'],
    ['The proxy opens a new socket to the app.', 3, 'play']
  ],
  [
    ['A long request reaches one Node.js pod.', 3, 'play'],
    ['Kubernetes marks that pod terminating and removes it from normal endpoint selection.', 2, 'still'],
    ['SIGTERM reaches the pod after preStop. The active response can finish.', 3, 'reverse'],
    ['The old pod exits; new requests use ready pods.', 2, 'play']
  ],
  [
    ['Old pods serve traffic while a new pod starts.', 3, 'play'],
    ['The new pod passes readiness and joins the Service.', 2, 'play'],
    ['An old pod drains active work before exiting.', 3, 'reverse'],
    ['Traffic continues through available replicas.', 2, 'play']
  ],
  [
    ['The pod begins sending a response in small chunks.', 3, 'reverse'],
    ['Kubernetes marks the serving pod terminating.', 2, 'still'],
    ['The active stream continues during graceful shutdown.', 3, 'reverse'],
    ['The final chunk arrives; the pod can exit.', 0, 'reverse']
  ],
  [
    ['Clients create CPU demand in the app pods.', 3, 'play'],
    ['Metrics-server reports CPU usage relative to requests.', 2, 'still'],
    ['The HPA asks the Deployment for more replicas.', 2, 'play'],
    ['New ready pods share subsequent requests.', 3, 'play']
  ]
];
let lesson = 0, step = 0, timer;
const nodes = [...document.querySelectorAll('.diagram-node')];
function draw() {
  const [caption, active, motion] = frames[lesson][step];
  document.getElementById('diagram-step').textContent = `0${step + 1} / 04`;
  document.getElementById('diagram-text').textContent = caption;
  const track = document.getElementById('diagram-track');
  track.className = `diagram-track ${motion}`;
  nodes.forEach((node, index) => {
    node.classList.toggle('active', index === active);
    node.classList.toggle('drain', (lesson === 2 || lesson === 3 || lesson === 4) && step === 2 && index === 3);
    node.classList.toggle('gone', lesson === 2 && step === 3 && index === 3);
  });
  document.getElementById('diagram-dots').innerHTML = frames[lesson].map((_, index) => `<button aria-label="Show step ${index+1}" data-step="${index}" class="${index === step ? 'active' : ''}"></button>`).join('');
}
function play() { clearInterval(timer); step = 0; draw(); timer = setInterval(() => { step = (step + 1) % 4; draw(); }, 2600); }
document.getElementById('replay').onclick = play;
document.getElementById('diagram-dots').onclick = event => {
  const button = event.target.closest('button[data-step]');
  if (!button) return;
  clearInterval(timer); step = Number(button.dataset.step); draw();
};
document.addEventListener('click', event => {
  const button = event.target.closest('.lesson-link[data-index]');
  if (!button) return;
  lesson = Number(button.dataset.index); play();
});
play();
