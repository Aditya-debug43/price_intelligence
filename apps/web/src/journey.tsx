import { Link } from 'react-router-dom';
import { useOrg, useOrgQuery } from './app-shell';
import { Card } from './ui';

interface JourneyStep {
  id: string;
  title: string;
  state: 'done' | 'current' | 'todo' | 'optional';
  detail: string;
  action: { label: string; to: string } | null;
}
export interface JourneyData {
  steps: JourneyStep[];
  complete: boolean;
  next: JourneyStep | null;
}

/**
 * The guided path from an empty workspace to a first report. The steps ARE a real sequence, so they are numbered; each state comes from
 * what actually exists on the server (never from which pages were visited).
 */
export function JourneyCard({ compact = false }: { compact?: boolean }) {
  const { orgId, isAdmin } = useOrg();
  const q = useOrgQuery<JourneyData>('journey', '/journey', { refetchInterval: 10_000 });
  const j = q.data;
  if (!j || (j.complete && compact)) return null;
  const required = j.steps.filter((s) => s.state !== 'optional');
  const doneCount = required.filter((s) => s.state === 'done').length;
  const steps = compact ? j.steps.filter((s) => s.state === 'current' || s.state === 'todo').slice(0, 3) : j.steps;
  return (
    <Card
      title={j.complete ? 'You’re set up' : compact ? `Next steps — ${doneCount} of ${required.length} done` : 'Get started'}
      actions={compact ? undefined : <span className="small muted">{doneCount} of {required.length} done</span>}
    >
      {!compact && !j.complete && <p style={{ marginTop: 0 }} className="muted">Nothing is collected until you say so. Each step below turns green only when it has really happened.</p>}
      <ol className="journey">
        {steps.map((s, i) => (
          <li key={s.id} className={`journey-step ${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="journey-mark" aria-hidden="true">{s.state === 'done' ? '✓' : compact ? '•' : i + 1}</span>
            <div>
              <div className="journey-title">{s.title}{s.state === 'optional' && <span className="pill" style={{ marginLeft: 8 }}>optional</span>}</div>
              <div className="small muted">{s.detail}</div>
              {s.action && isAdmin && (s.state === 'current' || s.state === 'optional') && (
                <Link className={`btn btn-sm ${s.state === 'current' ? 'btn-primary' : ''}`} style={{ marginTop: 6 }} to={`/o/${orgId}/${s.action.to}`}>{s.action.label}</Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
