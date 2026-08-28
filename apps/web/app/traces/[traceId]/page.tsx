import type { Metadata } from "next";
import Link from "next/link";
import { getTrace } from "../../../lib/proofstack-api";

export const metadata: Metadata = { title: "Trace detail" };

export default async function TraceDetailPage({
  params,
}: {
  readonly params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const result = await getTrace(traceId);

  if (!result.ok) {
    return (
      <div className="page-stack narrow-page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Trace unavailable</p>
            <h1>{result.message}</h1>
            <p className="lede">
              The console did not substitute placeholder data. Confirm the API is running and the ID
              belongs to the configured local project.
            </p>
          </div>
        </header>
        <Link className="secondary-action" href="/traces">
          Try another trace
        </Link>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <header className="page-header trace-heading">
        <div>
          <p className="eyebrow">Trace detail</p>
          <h1 className="mono-title">{result.data.traceId}</h1>
          <p className="lede">
            {result.data.events.length} evidence event{result.data.events.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link className="secondary-action" href="/traces">
          New lookup
        </Link>
      </header>

      <section aria-label="Trace events" className="timeline">
        {result.data.events.length === 0 ? (
          <div className="panel empty-state">The trace exists but contains no visible events.</div>
        ) : (
          result.data.events.map((event) => (
            <article className="timeline-event" key={event.evidence.eventId}>
              <div className="timeline-rail">
                <span />
              </div>
              <div className="event-card">
                <header>
                  <div>
                    <p>{event.evidence.kind}</p>
                    <h2>{event.evidence.name}</h2>
                  </div>
                  <span className={`event-status ${event.evidence.status}`}>
                    {event.evidence.status}
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>Span</dt>
                    <dd>{event.evidence.spanId}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{event.evidence.startedAt}</dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>{event.evidence.source.serviceName}</dd>
                  </div>
                  <div>
                    <dt>Received</dt>
                    <dd>{event.receivedAt}</dd>
                  </div>
                </dl>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
