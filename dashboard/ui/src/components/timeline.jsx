function elapsedOf(points) {
  if (points.length < 2) return 1;
  return Math.max(1, new Date(points.at(-1).at).getTime() - new Date(points[0].at).getTime());
}

function series(points, t0, key, max, top = 78) {
  const el = elapsedOf(points);
  return points.map((p) => {
    const x = 8 + ((new Date(p.at).getTime() - t0) / Math.max(1, el)) * 264;
    const v = p[key];
    const y = v == null ? null : top - (Math.min(v, max) * 68) / max;
    return { x, y, v };
  });
}

function runsOf(pts) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (p.y == null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function Polyline({ pts, color, dashed, width }) {
  return (
    <>
      {runsOf(pts).map((r, i) => {
        if (r.length === 1) return <circle key={i} cx={r[0].x.toFixed(1)} cy={r[0].y.toFixed(1)} r="2" fill={color} />;
        return (
          <polyline
            key={i}
            points={r.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={width || 2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={dashed ? '4 3' : undefined}
          />
        );
      })}
    </>
  );
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function TimelineChart({ points, lesson, failures }) {
  if (!points || points.length < 2) return <p className="text-sm text-muted-foreground">Create a run, start manual load, or run the experiment to observe.</p>;
  const t0 = new Date(points[0].at).getTime();
  const el = elapsedOf(points);
  const cpu = lesson === 'autoscale';
  const prom = lesson === 'prometheus';
  const maxRps = Math.max(15, ...points.map((p) => Math.max(p.offeredRps || 0, p.observedRps || 0, p.offeredTarget || 0, p.achievedRps || 0)));
  const maxRep = Math.max(5, ...points.map((p) => Math.max(p.desired || 0, p.actual || 0, p.ready || 0, p.terminating || 0, p.endpoints || 0)));
  const maxCpu = Math.max(100, ...points.map((p) => p.currentCPU || 0));
  const leftMax = cpu ? maxCpu : maxRps;
  const rps = (k) => series(points, t0, k, leftMax);
  const rep = (k) => series(points, t0, k, maxRep);
  const xFor = (frac) => 8 + frac * 264;

  return (
    <div>
      <svg viewBox="0 0 280 92" className="block h-28 w-full rounded bg-muted/40" role="img" aria-label="Synchronized cause-effect timeline">
        {[0, 1, 2, 3, 4].map((i) => {
          const y = 78 - (68 * i) / 4;
          return <line key={i} x1="8" y1={y} x2="272" y2={y} stroke="#e6ece3" strokeWidth="0.5" />;
        })}
        <line x1="8" y1="78" x2="272" y2="78" stroke="#cbd8ca" />
        <text x="10" y="12" fontSize="7" fill="#8a6fb1">{cpu ? '% / req/s (left)' : 'req/s (left)'}</text>
        <text x="272" y="12" fontSize="7" fill="#3a7ca5" textAnchor="end">pods (right)</text>
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={xFor(f)} y="88" fontSize="6" fill="#95a69a" textAnchor="middle">{fmtElapsed(f * el)}</text>
        ))}
        <Polyline pts={rps('offeredRps')} color="#8a6fb1" />
        <Polyline pts={rps('offeredTarget')} color="#b9a8d6" dashed width={1.5} />
        <Polyline pts={rps('achievedRps')} color="#5aa9e6" dashed width={1.5} />
        {cpu && <Polyline pts={rps('currentCPU')} color="#c07a2a" />}
        {prom && <Polyline pts={rps('observedRps')} color="#4a8452" />}
        {(prom || cpu) && <Polyline pts={rep('desired')} color="#c07a2a" dashed />}
        <Polyline pts={rep('actual')} color="#2f6040" width={1.5} />
        <Polyline pts={rep('ready')} color="#3a7ca5" />
        <Polyline pts={rep('terminating')} color="#dfae5d" dashed width={1.5} />
        <Polyline pts={rep('endpoints')} color="#95a69a" dashed width={1} />
        {(failures || []).map((m, i) => {
          const x = 8 + ((new Date(m.at).getTime() - t0) / Math.max(1, el)) * 264;
          if (!Number.isFinite(x)) return null;
          return <text key={i} x={x.toFixed(1)} y="76" fontSize="8" fill="#bd6655" textAnchor="middle">✕</text>;
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-mono text-muted-foreground">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#8a6fb1' }} />offered</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#5aa9e6' }} />achieved</span>
        {prom && <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#4a8452' }} />Prometheus RPS</span>}
        {cpu && <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#c07a2a' }} />CPU %</span>}
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#2f6040' }} />actual</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#3a7ca5' }} />ready</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: '#95a69a' }} />endpoints</span>
        <span>✕ failure</span>
      </div>
    </div>
  );
}
