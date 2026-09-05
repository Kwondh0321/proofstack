import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { ScrollableTable } from "../../../components/scrollable-table";
import {
  type ArtifactRoleDisplay,
  buildComparisonDisplay,
  type ExactValueDisplay,
  type SampleClassDisplay,
} from "../../../lib/comparison-view-model";
import { getComparisonView } from "../../../lib/proofstack-api";

export const metadata: Metadata = { title: "Comparison detail" };

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function EmptyAwareList({
  empty,
  values,
}: {
  readonly empty: string;
  readonly values: readonly string[];
}) {
  return values.length > 0 ? (
    <ul className="compact-list">
      {values.map((value) => (
        <li key={value}>{humanize(value)}</li>
      ))}
    </ul>
  ) : (
    <span className="muted-value">{empty}</span>
  );
}

function ExactValue({ value }: { readonly value: ExactValueDisplay | undefined }) {
  if (!value) return <span className="muted-value">Not available</span>;
  return (
    <span className="exact-value">
      <strong>{value.text}</strong>
      {value.representation === "rational" ? (
        <small>
          numerator {value.numerator}; denominator {value.denominator}
        </small>
      ) : (
        <small>exact decimal</small>
      )}
    </span>
  );
}

function Samples({ label, value }: { readonly label: string; readonly value: SampleClassDisplay }) {
  return (
    <span className="sample-line">
      <strong>{label}</strong>
      <span>
        observed {value.observed}/{value.total}
        {"; "}missing {value.missing}
        {"; "}invalid {value.invalid}
        {"; "}unavailable {value.unavailable}
      </span>
    </span>
  );
}

function ArtifactRole({ value }: { readonly value: ArtifactRoleDisplay | undefined }) {
  if (!value) return <span className="muted-value">Not present</span>;
  return (
    <span className="artifact-role">
      <strong>{humanize(value.availability)}</strong>
      <span>
        {value.classification} · {value.mediaType} · {value.sizeBytes} bytes
      </span>
      <code>{value.sha256}</code>
      {value.redactedAt ? <span>redacted {value.redactedAt}</span> : null}
    </span>
  );
}

function TableSection({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <section className="panel evidence-section">
      <header className="section-heading">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

export default async function ComparisonDetailPage({
  params,
}: {
  readonly params: Promise<{ resultId: string }>;
}) {
  const { resultId } = await params;
  const cookieStore = await cookies();
  const browserSessionToken = cookieStore.get("__Host-proofstack_session")?.value;
  const result = await getComparisonView(
    resultId,
    globalThis.fetch,
    browserSessionToken ? { browserSessionToken } : {},
  );

  if (!result.ok) {
    return (
      <div className="page-stack narrow-page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Comparison unavailable</p>
            <h1>{result.message}</h1>
            <p className="lede">
              No placeholder or partially verified data was substituted. Confirm that the API is
              running, your session is valid, and the result belongs to the configured project and
              environment.
            </p>
          </div>
        </header>
        <Link className="secondary-action" href="/comparisons">
          Try another result
        </Link>
      </div>
    );
  }

  const model = buildComparisonDisplay(result.data);

  return (
    <div className="page-stack comparison-page">
      <header className="page-header comparison-heading">
        <div>
          <p className="eyebrow">Verified comparison bundle</p>
          <h1>{model.comparison.name}</h1>
          <p className="lede">{model.comparison.description ?? "No description was recorded."}</p>
          <dl className="identity-strip">
            <div>
              <dt>Result ID</dt>
              <dd>{model.result.resultId}</dd>
            </div>
            <div>
              <dt>Comparability</dt>
              <dd>{humanize(model.comparability.status)}</dd>
            </div>
            <div>
              <dt>Latest source cutoff</dt>
              <dd>{model.result.latestSourceCutoff}</dd>
            </div>
          </dl>
        </div>
        <Link className="secondary-action" href="/comparisons">
          New lookup
        </Link>
      </header>

      <aside className="boundary-note">
        <strong>This is descriptive evidence, not an approval decision.</strong> Increased or
        decreased values have no built-in good/bad meaning. Pairing, missingness, source limits, and
        your declared policy must be reviewed together.
      </aside>

      <section
        aria-labelledby="pairing-heading"
        className="panel evidence-section priority-section"
      >
        <header className="section-heading">
          <div>
            <p className="eyebrow">Review first</p>
            <h2 id="pairing-heading">Pairing and missingness</h2>
            <p>These exact populations determine which later aggregates can be interpreted.</p>
          </div>
          <span className="status-tag">{humanize(model.comparability.status)}</span>
        </header>
        <div className="pairing-grid">
          {[
            ["Requested", model.pairing.requested],
            ["Paired", model.pairing.paired],
            ["Baseline only", model.pairing.baselineOnly],
            ["Candidate only", model.pairing.candidateOnly],
            ["Invalid", model.pairing.invalid],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div className="reason-block">
          <h3>Comparability reasons</h3>
          <EmptyAwareList
            empty="No comparability exceptions were recorded."
            values={model.comparability.reasons}
          />
        </div>
      </section>

      <section aria-labelledby="sources-heading" className="evidence-section">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Immutable lineage</p>
            <h2 id="sources-heading">Baseline and candidate sources</h2>
            <p>
              Each source below was contract-validated, digest-verified, and bound to this result.
            </p>
          </div>
        </header>
        <div className="source-grid">
          {model.sources.map((source) => (
            <article className="source-card" key={source.role}>
              <header>
                <h3>{source.role}</h3>
                <span className="status-tag">integrity {source.integrity}</span>
              </header>
              <dl className="fact-list">
                <div>
                  <dt>Snapshot</dt>
                  <dd>{source.snapshotId}</dd>
                </div>
                <div>
                  <dt>Dataset</dt>
                  <dd>{source.dataset}</dd>
                </div>
                <div>
                  <dt>Target release</dt>
                  <dd>{source.targetReleaseIds.join(", ")}</dd>
                </div>
                <div>
                  <dt>Source cutoff</dt>
                  <dd>{source.sourceCutoff}</dd>
                </div>
                <div>
                  <dt>Snapshot created</dt>
                  <dd>{source.createdAt}</dd>
                </div>
                <div>
                  <dt>Fixtures / omissions</dt>
                  <dd>
                    {source.fixtureCount} / {source.omissionCount}
                  </dd>
                </div>
                <div className="wide-fact">
                  <dt>Snapshot SHA-256</dt>
                  <dd>{source.definitionSha256}</dd>
                </div>
                <div className="wide-fact">
                  <dt>Dataset SHA-256</dt>
                  <dd>{source.datasetSha256}</dd>
                </div>
              </dl>
              <div className="reason-block">
                <h4>Omission reasons</h4>
                <EmptyAwareList empty="None recorded" values={source.omissionReasons} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <TableSection
        description="Values retain their exact decimal or rational representation. Every denominator exposes missing, invalid, and unavailable classes."
        title="Declared metric results"
      >
        <ScrollableTable caption="Declared metric results">
          <table className="data-table metric-table">
            <caption className="sr-only">Declared metric results</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Status and values</th>
                <th scope="col">Exact populations</th>
                <th scope="col">Provenance / reasons</th>
              </tr>
            </thead>
            <tbody>
              {model.metrics.map((metric) => (
                <tr key={metric.metricId}>
                  <th scope="row">
                    <strong>{metric.label}</strong>
                    <code>{metric.metricId}</code>
                    <span>{humanize(metric.kind)}</span>
                    <span>unit {metric.unit}</span>
                  </th>
                  <td>
                    <span className="status-tag">{humanize(metric.status)}</span>
                    <dl className="value-stack">
                      <div>
                        <dt>Baseline</dt>
                        <dd>
                          <ExactValue value={metric.baseline} />
                        </dd>
                      </div>
                      <div>
                        <dt>Candidate</dt>
                        <dd>
                          <ExactValue value={metric.candidate} />
                        </dd>
                      </div>
                      <div>
                        <dt>Delta</dt>
                        <dd>
                          <ExactValue value={metric.delta} />
                        </dd>
                      </div>
                    </dl>
                    {metric.direction ? (
                      <span className="direction-label">direction: {metric.direction}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="sample-stack">
                      <Samples label="Baseline" value={metric.samples.baseline} />
                      <Samples label="Candidate" value={metric.samples.candidate} />
                      <Samples label="Paired" value={metric.samples.paired} />
                    </span>
                  </td>
                  <td>
                    <EmptyAwareList empty="No exception reasons" values={metric.reasons} />
                    {metric.usageProvenance ? (
                      <dl className="provenance-list">
                        <div>
                          <dt>Baseline usage</dt>
                          <dd>{metric.usageProvenance.baseline}</dd>
                        </div>
                        <div>
                          <dt>Candidate usage</dt>
                          <dd>{metric.usageProvenance.candidate}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      </TableSection>

      <TableSection
        description="The complete logical fixture population is retained, including unpaired and invalid cases."
        title="Exact comparison cases"
      >
        <ScrollableTable caption="Exact comparison cases">
          <table className="data-table">
            <caption className="sr-only">Exact comparison cases</caption>
            <thead>
              <tr>
                <th scope="col">Fixture</th>
                <th scope="col">State</th>
                <th scope="col">Baseline version / digest</th>
                <th scope="col">Candidate version / digest</th>
                <th scope="col">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {model.cases.map((entry) => (
                <tr key={entry.fixtureId}>
                  <th scope="row">
                    <code>{entry.fixtureId}</code>
                  </th>
                  <td>
                    <span className="status-tag">{humanize(entry.state)}</span>
                  </td>
                  <td>
                    <strong>{entry.baselineVersion ?? "Not present"}</strong>
                    <code>{entry.baselineDigest}</code>
                  </td>
                  <td>
                    <strong>{entry.candidateVersion ?? "Not present"}</strong>
                    <code>{entry.candidateDigest}</code>
                  </td>
                  <td>
                    <EmptyAwareList empty="None" values={entry.reasons} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      </TableSection>

      <div className="two-column-sections">
        <TableSection title="Calculation policy">
          <dl className="fact-list">
            {model.policy.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{humanize(item.value)}</dd>
              </div>
            ))}
          </dl>
        </TableSection>

        <TableSection title="Result identity">
          <dl className="fact-list">
            <div>
              <dt>Comparison ID</dt>
              <dd>{model.comparison.comparisonId}</dd>
            </div>
            <div>
              <dt>Version ID</dt>
              <dd>{model.comparison.comparisonVersionId}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>{model.result.schemaVersion}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{model.result.scope}</dd>
            </div>
            <div>
              <dt>Definition created</dt>
              <dd>{model.comparison.createdAt}</dd>
            </div>
            <div>
              <dt>Result created</dt>
              <dd>{model.result.createdAt}</dd>
            </div>
            <div className="wide-fact">
              <dt>Comparison SHA-256</dt>
              <dd>{model.comparison.definitionSha256}</dd>
            </div>
            <div className="wide-fact">
              <dt>Result SHA-256</dt>
              <dd>{model.result.definitionSha256}</dd>
            </div>
          </dl>
        </TableSection>
      </div>

      <TableSection title="Distribution summaries">
        {model.distributions.length > 0 ? (
          <ScrollableTable caption="Distribution summaries">
            <table className="data-table">
              <caption className="sr-only">Distribution summaries</caption>
              <thead>
                <tr>
                  <th scope="col">Metric / role</th>
                  <th scope="col">Method</th>
                  <th scope="col">Exact value</th>
                  <th scope="col">Population</th>
                </tr>
              </thead>
              <tbody>
                {model.distributions.map((entry) => (
                  <tr key={`${entry.metricId}:${entry.role}`}>
                    <th scope="row">
                      <code>{entry.metricId}</code>
                      <span>{entry.role}</span>
                    </th>
                    <td>{entry.method}</td>
                    <td>
                      <ExactValue value={entry.value} />
                    </td>
                    <td>
                      observed {entry.observed}/{entry.total}; missing {entry.missing}; invalid{" "}
                      {entry.invalid}; unavailable {entry.unavailable}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        ) : (
          <p className="empty-state">No source-backed distribution summaries were recorded.</p>
        )}
      </TableSection>

      <div className="two-column-sections">
        <TableSection title="Safety event counts">
          {model.safety.length > 0 ? (
            <ScrollableTable caption="Safety event counts">
              <table className="data-table compact-table">
                <caption className="sr-only">Safety event counts</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Baseline</th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {model.safety.map((entry) => (
                    <tr key={entry.kind}>
                      <th scope="row">{humanize(entry.kind)}</th>
                      <td>{entry.baseline}</td>
                      <td>{entry.candidate}</td>
                      <td>{entry.delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollableTable>
          ) : (
            <p className="empty-state">No safety count projection was recorded.</p>
          )}
        </TableSection>

        <TableSection title="Known limitations">
          {(["baseline", "candidate", "result"] as const).map((role) => (
            <div className="reason-block" key={role}>
              <h3>{role}</h3>
              <EmptyAwareList empty="None recorded" values={model.limitations[role]} />
            </div>
          ))}
        </TableSection>
      </div>

      <TableSection title="Verdict marginals and pairing availability">
        {model.verdictMarginals.length > 0 ? (
          <ScrollableTable caption="Verdict marginals and pairing availability">
            <table className="data-table">
              <caption className="sr-only">Verdict marginals and pairing availability</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Baseline counts</th>
                  <th scope="col">Candidate counts</th>
                  <th scope="col">Transitions</th>
                </tr>
              </thead>
              <tbody>
                {model.verdictMarginals.map((entry) => (
                  <tr key={entry.criterionId}>
                    <th scope="row">
                      <code>{entry.criterionId}</code>
                    </th>
                    <td>{entry.baseline}</td>
                    <td>{entry.candidate}</td>
                    <td>{entry.transition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        ) : (
          <p className="empty-state">No criterion verdict marginals were recorded.</p>
        )}
      </TableSection>

      <TableSection title="Exact verdict transitions">
        {model.verdictTransitions.length > 0 ? (
          <ScrollableTable caption="Exact verdict transitions">
            <table className="data-table compact-table">
              <caption className="sr-only">Exact verdict transitions</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Baseline</th>
                  <th scope="col">Candidate</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {model.verdictTransitions.map((entry) => (
                  <tr key={`${entry.criterionId}:${entry.baseline}:${entry.candidate}`}>
                    <th scope="row">
                      <code>{entry.criterionId}</code>
                    </th>
                    <td>{entry.baseline}</td>
                    <td>{entry.candidate}</td>
                    <td>{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        ) : (
          <p className="empty-state">No paired verdict transition was available.</p>
        )}
      </TableSection>

      <TableSection
        description="Only identity, digest, size, classification, media type, redaction timestamp, and availability metadata are projected. Artifact content is never rendered here."
        title="Artifact metadata changes"
      >
        {model.artifacts.length > 0 ? (
          <ScrollableTable caption="Artifact metadata changes">
            <table className="data-table artifact-table">
              <caption className="sr-only">Artifact metadata changes</caption>
              <thead>
                <tr>
                  <th scope="col">Artifact</th>
                  <th scope="col">Status</th>
                  <th scope="col">Baseline metadata</th>
                  <th scope="col">Candidate metadata</th>
                </tr>
              </thead>
              <tbody>
                {model.artifacts.map((entry) => (
                  <tr key={entry.artifactId}>
                    <th scope="row">
                      <code>{entry.artifactId}</code>
                    </th>
                    <td>
                      <span className="status-tag">{humanize(entry.status)}</span>
                    </td>
                    <td>
                      <ArtifactRole value={entry.baseline} />
                    </td>
                    <td>
                      <ArtifactRole value={entry.candidate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        ) : (
          <p className="empty-state">No artifact metadata changes were recorded.</p>
        )}
      </TableSection>
    </div>
  );
}
