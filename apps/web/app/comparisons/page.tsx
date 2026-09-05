import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { parseComparisonLookup } from "../../lib/comparison-lookup";

export const metadata: Metadata = { title: "Comparisons" };

export default async function ComparisonsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const lookup = parseComparisonLookup(id);
  if (lookup.status === "valid") {
    redirect(`/comparisons/${encodeURIComponent(lookup.resultId)}`);
  }

  return (
    <div className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Exact evidence comparison</p>
          <h1>Comparison explorer</h1>
          <p className="lede">
            Inspect one immutable baseline/candidate result. The console verifies every referenced
            definition and snapshot before it renders any comparison.
          </p>
        </div>
      </header>

      <section className="panel lookup-panel">
        <form action="/comparisons" method="get">
          <label htmlFor="comparison-result-id">Comparison result ID</label>
          <div className="lookup-row">
            <input
              aria-describedby={
                lookup.status === "invalid"
                  ? "comparison-result-id-error"
                  : "comparison-result-id-help"
              }
              aria-invalid={lookup.status === "invalid"}
              autoCapitalize="none"
              autoComplete="off"
              defaultValue={lookup.status === "invalid" ? lookup.value : undefined}
              id="comparison-result-id"
              maxLength={64}
              name="id"
              pattern="[a-z][a-z0-9_]{2,63}"
              placeholder="result_release_candidate_42"
              required
              spellCheck={false}
            />
            <button type="submit">Inspect comparison</button>
          </div>
          {lookup.status === "invalid" ? (
            <p id="comparison-result-id-error" role="alert">
              Enter 3–64 characters beginning with a lowercase letter and using only lowercase
              letters, numbers, or underscores.
            </p>
          ) : (
            <p id="comparison-result-id-help">
              Invalid identifiers are rejected locally and never sent to the API.
            </p>
          )}
        </form>
      </section>

      <aside className="boundary-note">
        <strong>Descriptive evidence only.</strong> Direction such as increased or decreased is not a
        release verdict, approval, or claim of causal improvement.
      </aside>
    </div>
  );
}
