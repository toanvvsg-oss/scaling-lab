import { useEffect, useRef, useState } from 'react';
import { Button } from './button.jsx';
import { Card } from './card.jsx';
import { ArrowUpRight, Download, LoaderCircle, X } from 'lucide-react';
import { LESSONS } from '../lessons.js';
import { delJSON, getJSON, postJSON } from '../api.js';

function RunRow({ run, selected, onOpen, onRefresh, onDownload }) {
  const [confirm, setConfirm] = useState(false);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const priorCleanup = useRef(null);
  const closed = run.status === 'deleted' || run.status === 'failed';
  const closing = run.status === 'deleting' || Boolean(operation);
  const waiting = run.status === 'creating' || run.scenarioRunning || run.actionRunning;
  const title = LESSONS.find((l) => l.id === run.lesson)?.title || run.lesson;

  useEffect(() => {
    if (operation === 'accepted' && (closed || (run.status === 'cleanup-failed' && run.cleanup?.updatedAt !== priorCleanup.current))) {
      locked.current = false;
      setOperation(null);
    }
  }, [operation, closed, run.status, run.cleanup?.updatedAt]);

  const close = async () => {
    if (locked.current || closing || waiting || closed) return;
    locked.current = true;
    priorCleanup.current = run.cleanup?.updatedAt;
    setConfirm(false);
    setError('');
    setOperation('Requesting cleanup…');
    try {
      const current = await getJSON(`/api/runs/${run.id}`);
      if (current.hasPendingLong) {
        setOperation('Terminating the serving pod and waiting for the request to finish…');
        if (current.load?.active) await postJSON(`/api/runs/${run.id}/load`, { action: 'stop' });
        try {
          await postJSON(`/api/runs/${run.id}/actions`, { action: 'terminate-serving' });
        } catch (e) {
          // A request may finish naturally between the state read and termination.
          const latest = await getJSON(`/api/runs/${run.id}`);
          if (latest.hasPendingLong || latest.actionRunning || !/No long request|already completed/.test(e.message)) throw e;
        }
      }
      await delJSON(`/api/runs/${run.id}`);
      setOperation('accepted');
      onRefresh();
    } catch (e) {
      locked.current = false;
      setOperation(null);
      setError(e.message);
      onRefresh();
    }
  };

  const status = closed ? (run.status === 'deleted' ? 'Closed' : 'Creation failed')
    : closing ? 'Closing…' : run.status === 'cleanup-failed' ? 'Close failed'
    : run.actionRunning ? 'Action in progress…' : run.scenarioRunning ? 'Scenario running…'
    : run.status === 'creating' ? 'Creating…' : run.hasPendingLong ? 'Request in flight'
    : run.load?.active ? 'Traffic running' : run.status === 'ready' ? 'Ready' : run.status === 'degraded' ? 'Degraded' : run.status;
  const detail = run.status === 'deleting' ? run.cleanup?.detail || 'Cleanup is in progress…'
    : operation ? (operation === 'accepted' ? 'Cleanup accepted. Waiting for progress…' : operation)
    : run.status === 'creating' ? run.steps?.at(-1)?.detail : null;

  const badge = closed ? 'bg-slate-100 text-muted-foreground'
    : run.status === 'cleanup-failed' ? 'bg-red-50 text-red-700'
    : closing || waiting ? 'bg-amber-50 text-amber-700'
    : 'bg-emerald-50 text-emerald-700';

  return (
    <div className={`border-t border-border/60 px-4 py-3 transition-colors ${selected ? 'bg-secondary/70' : 'hover:bg-muted/40'}`} data-run-id={run.id} aria-busy={closing || waiting}>
      <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_240px]">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70" title={run.namespace}>
            {run.id}{selected && <span className="font-sans text-[10px] font-medium text-emerald-700">Selected</span>}
          </p>
        </div>
        <div className="min-w-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge}`} role="status">
            {(closing || waiting) ? <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" /> : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
            {status}
          </span>
          {detail && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" role="status">{detail}</p>}
          {run.status === 'deleting' && run.cleanup && (
            <div className="mt-1.5 flex max-w-xs items-center gap-2">
              <progress className="run-cleanup-progress h-1 w-full overflow-hidden rounded-full" value={run.cleanup.completed} max={run.cleanup.total} aria-label={`Cleanup stages for ${run.id}`} />
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{run.cleanup.completed}/{run.cleanup.total}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 sm:justify-end">
          {!closed && <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => onOpen(run)}>Open <ArrowUpRight aria-hidden="true" /></Button>}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => onDownload(run.id)}><Download aria-hidden="true" /> Evidence</Button>
          {!closed && <Button variant="outline" size="sm" className="h-7 border-border px-2 text-muted-foreground shadow-none hover:border-red-200 hover:bg-red-50 hover:text-red-700" disabled={closing || waiting} onClick={() => setConfirm(true)}>
            {closing ? 'Closing…' : <><X aria-hidden="true" />{run.status === 'cleanup-failed' ? 'Retry close' : 'Close'}</>}
          </Button>}
        </div>
      </div>
      {(error || run.error) && <p className="mt-2 break-words text-xs text-red-700" role="alert">{error || run.error}</p>}
      {confirm && !closing && !waiting && !closed && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2.5">
          <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">Close <strong>{run.id}</strong>? This stops traffic{run.hasPendingLong ? ', terminates the serving pod and waits for its request' : ''}, saves evidence, and deletes <code>{run.namespace}</code>.</p>
          <div className="flex gap-2">
            <Button size="sm" className="h-7" onClick={close}>Confirm close</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RunsPanel({ runs, archived, maxActiveRuns, selectedRun, onOpen, onRefresh, onDownload }) {
  const liveRuns = runs.filter((r) => r.status !== 'deleted' && r.status !== 'failed');
  const closedRuns = runs.filter((r) => r.status === 'deleted' || r.status === 'failed');
  const lastClosed = closedRuns.at(-1);
  return (
    <Card className="mx-auto mt-4 overflow-hidden" id="all-runs">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-foreground">All runs</h2>
          <span className="hidden text-xs text-muted-foreground/70 sm:inline">Across all lessons</span>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span><strong className="font-semibold text-foreground">{liveRuns.length}</strong> / {maxActiveRuns} active runs</span>
        </span>
      </div>
      {liveRuns.length ? (
        <div>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_240px] gap-3 border-t border-border/60 bg-muted/40 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 sm:grid">
            <span>Lesson / Run</span><span>Status</span><span className="text-right">Actions</span>
          </div>
          {liveRuns.map((run) => <RunRow key={run.id} run={run} selected={run.id === selectedRun} onOpen={onOpen} onRefresh={onRefresh} onDownload={onDownload} />)}
        </div>
      ) : <p className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground">No active runs. Choose a lesson and create a run to start.</p>}
      {(closedRuns.length > 0 || archived.length > 0) && (
        <details className="border-t border-border/60 text-xs">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2.5 text-muted-foreground hover:bg-muted/70 [&::-webkit-details-marker]:hidden">
            <span><span className="mr-2 text-muted-foreground/70">▸</span>History <span className="ml-1 text-muted-foreground/70">{closedRuns.length} closed · {archived.length} archives</span></span>
            {lastClosed && <span className="text-[11px] text-emerald-700">{lastClosed.id} · {lastClosed.status === 'deleted' ? 'Cleanup complete' : 'Creation failed'}</span>}
          </summary>
          {closedRuns.map((run) => <RunRow key={run.id} run={run} selected={false} onOpen={onOpen} onRefresh={onRefresh} onDownload={onDownload} />)}
          {archived.length > 0 && <div className="border-t border-border/60 px-4 py-3">
            <p className="mb-2 text-[11px] text-muted-foreground/70">Saved evidence</p>
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto">
              {[...archived].reverse().map((id) => <button key={id} onClick={() => onDownload(id)} className="rounded border border-border bg-white px-2 py-1 font-mono text-[10px] text-muted-foreground hover:border-emerald-300 hover:text-emerald-700">{id}</button>)}
            </div>
          </div>}
        </details>
      )}
    </Card>
  );
}
