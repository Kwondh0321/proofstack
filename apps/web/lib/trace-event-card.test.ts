import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TraceEventCard } from "../components/trace-event-card.js";

describe("TraceEventCard", () => {
  it("renders hostile evidence strings as inert text within semantic trace markup", () => {
    const markup = renderToStaticMarkup(
      createElement(TraceEventCard, {
        event: {
          evidence: {
            attributes: {},
            contentReferences: [],
            eventId: "evt_hostile_text",
            extensions: {},
            kind: "agent.run",
            name: "<script>alert('event')</script>",
            source: {
              sdkName: "@proofstack/sdk",
              sdkVersion: "0.0.0",
              serviceName: "<img src=x onerror=alert('service')>",
            },
            spanId: "00f067aa0ba902b7",
            startedAt: "2026-09-06T00:00:00.000Z",
            status: "error",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          },
          receivedAt: "2026-09-06T00:00:00.100Z",
          schemaVersion: "0.1",
          scope: {
            environmentId: "env_local",
            projectId: "prj_local",
            tenantId: "ten_local",
          },
        },
      }),
    );

    expect(markup).toContain("<article");
    expect(markup).toContain("<h2>&lt;script&gt;alert(&#x27;event&#x27;)&lt;/script&gt;</h2>");
    expect(markup).toContain("&lt;img src=x onerror=alert(&#x27;service&#x27;)&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img src=x");
  });

  it("keeps hostile headings and details shrinkable and wrappable on narrow screens", () => {
    const styles = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.event-card h2\s*\{[^}]*overflow-wrap: anywhere;/u);
    expect(styles).toMatch(
      /\.event-card header > div,\s*\.event-card dl > div\s*\{[^}]*min-width: 0;/u,
    );
    expect(styles).toMatch(
      /\.event-card dd\s*\{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/u,
    );
  });
});
