import Link from "next/link";
import { apiHealth } from "../lib/proofstack-api";

const foundation = [
  { label: "Evidence contract", state: "Implemented", value: "EvidenceEnvelope 0.1" },
  { label: "Operator reads", state: "Implemented", value: "Trace + comparison" },
  { label: "Decision authority", state: "Not present", value: "Descriptive only" },
  { label: "Production readiness", state: "Incomplete", value: "Not approved" },
] as const;

export default async function OverviewPage() {
  const health = await apiHealth();

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Agent Reliability Engineering</p>
          <h1>Operational evidence, before automation becomes trust.</h1>
          <p className="lede">
            The operator console exposes bounded read-only views backed by the configured API.
            Planned decision systems remain visibly absent.
          </p>
        </div>
        <div className={`health-pill ${health.ok ? "healthy" : "offline"}`}>
          <span className="status-dot" />
          {health.ok ? "API ready" : "API offline"}
        </div>
      </header>

      <section aria-label="Foundation status" className="metric-grid">
        {foundation.map((item) => (
          <article className="metric-card" key={item.label}>
            <p>{item.label}</p>
            <strong>{item.value}</strong>
            <span>{item.state}</span>
          </article>
        ))}
      </section>

      <section className="panel split-panel">
        <div>
          <p className="eyebrow">First verified workflow</p>
          <h2>Ingest and inspect a linked evidence trace</h2>
          <p>
            Metadata is validated at the boundary, scoped by the server-owned tenant identity, and
            stored through an idempotent repository port.
          </p>
          <Link className="primary-action" href="/traces">
            Open trace explorer
          </Link>
        </div>
        <ol className="workflow-list">
          <li>
            <span>01</span> SDK creates bounded, versioned evidence
          </li>
          <li>
            <span>02</span> API authenticates and validates the request
          </li>
          <li>
            <span>03</span> Core assigns immutable tenant scope
          </li>
          <li>
            <span>04</span> Console renders ordered evidence
          </li>
        </ol>
      </section>
    </div>
  );
}
