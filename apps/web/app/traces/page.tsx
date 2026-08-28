import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Traces" };

export default async function TracesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  if (id) redirect(`/traces/${encodeURIComponent(id.trim())}`);

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
              autoComplete="off"
              id="trace-id"
              name="id"
              pattern="[0-9a-f]{32}"
              placeholder="4bf92f3577b34da6a3ce929d0e0e4736"
              required
            />
            <button type="submit">Inspect trace</button>
          </div>
          <p>Trace content is never fetched until the identifier passes local validation.</p>
        </form>
      </section>
    </div>
  );
}
