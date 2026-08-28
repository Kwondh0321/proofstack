import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { parseTraceLookup } from "../../lib/trace-lookup";

export const metadata: Metadata = { title: "Traces" };

export default async function TracesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const lookup = parseTraceLookup(id);
  if (lookup.status === "valid") {
    redirect(`/traces/${encodeURIComponent(lookup.traceId)}`);
  }

  return (
    <div className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Flight recorder</p>
          <h1>Trace explorer</h1>
          <p className="lede">Open an exact trace using its W3C-compatible 32-character ID.</p>
        </div>
      </header>

      <section className="panel lookup-panel">
        <form action="/traces" method="get">
          <label htmlFor="trace-id">Trace ID</label>
          <div className="lookup-row">
            <input
              aria-describedby={lookup.status === "invalid" ? "trace-id-error" : "trace-id-help"}
              aria-invalid={lookup.status === "invalid"}
              autoComplete="off"
              defaultValue={lookup.status === "invalid" ? lookup.value : undefined}
              id="trace-id"
              name="id"
              pattern="[0-9a-f]{32}"
              placeholder="4bf92f3577b34da6a3ce929d0e0e4736"
              required
            />
            <button type="submit">Inspect trace</button>
          </div>
          {lookup.status === "invalid" ? (
            <p id="trace-id-error" role="alert">
              Enter a lowercase, 32-character hexadecimal trace ID.
            </p>
          ) : (
            <p id="trace-id-help">
              Trace content is never fetched until the identifier passes validation.
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
