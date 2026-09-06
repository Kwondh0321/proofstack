import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { TraceEventCard } from "../../../components/trace-event-card";
import { getTrace } from "../../../lib/proofstack-api";

export const metadata: Metadata = { title: "Trace detail" };

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ traceId: string }>;
  readonly searchParams: Promise<{ cursor?: string }>;
}) {
  const { traceId } = await params;
  const { cursor } = await searchParams;
  const cookieStore = await cookies();
  const browserSessionToken = cookieStore.get("__Host-proofstack_session")?.value;
  const result = await getTrace(traceId, globalThis.fetch, {
    ...(browserSessionToken ? { browserSessionToken } : {}),
    ...(cursor ? { cursor } : {}),
  });

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
            {result.data.events.length} evidence event{result.data.events.length === 1 ? "" : "s"}{" "}
            on this page
          </p>
        </div>
        <Link className="secondary-action" href="/traces">
          New lookup
        </Link>
      </header>

      <section aria-label="Trace events" className="timeline">
        {result.data.events.map((event) => (
          <TraceEventCard event={event} key={event.evidence.eventId} />
        ))}
      </section>

      {result.data.nextCursor ? (
        <Link
          className="secondary-action"
          href={`/traces/${encodeURIComponent(traceId)}?cursor=${encodeURIComponent(result.data.nextCursor)}`}
        >
          Next page
        </Link>
      ) : cursor ? (
        <Link className="secondary-action" href={`/traces/${encodeURIComponent(traceId)}`}>
          Back to first page
        </Link>
      ) : null}
    </div>
  );
}
