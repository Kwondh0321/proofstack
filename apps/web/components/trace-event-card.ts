import type { TraceResponse } from "@proofstack/contracts";
import { createElement } from "react";

function detail(term: string, description: string) {
  return createElement(
    "div",
    null,
    createElement("dt", null, term),
    createElement("dd", null, description),
  );
}

export function TraceEventCard({ event }: { readonly event: TraceResponse["events"][number] }) {
  return createElement(
    "article",
    { className: "timeline-event" },
    createElement("div", { className: "timeline-rail" }, createElement("span")),
    createElement(
      "div",
      { className: "event-card" },
      createElement(
        "header",
        null,
        createElement(
          "div",
          null,
          createElement("p", null, event.evidence.kind),
          createElement("h2", null, event.evidence.name),
        ),
        createElement(
          "span",
          { className: `event-status ${event.evidence.status}` },
          event.evidence.status,
        ),
      ),
      createElement(
        "dl",
        null,
        detail("Span", event.evidence.spanId),
        detail("Started", event.evidence.startedAt),
        detail("Service", event.evidence.source.serviceName),
        detail("Received", event.receivedAt),
      ),
    ),
  );
}
