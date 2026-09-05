import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrollableTable } from "../components/scrollable-table";

describe("ScrollableTable", () => {
  it("labels the table and makes its bounded overflow region keyboard-scrollable", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ScrollableTable,
        { caption: "Exact comparison cases" },
        createElement(
          "table",
          { className: "data-table compact-table" },
          createElement("caption", { className: "sr-only" }, "Exact comparison cases"),
          createElement("tbody", null),
        ),
      ),
    );

    expect(markup).toContain(
      'aria-label="Exact comparison cases; scroll horizontally for additional columns"',
    );
    expect(markup).toContain('class="table-scroll" tabindex="0"');
    expect(markup).toContain('class="data-table compact-table"');
    expect(markup).toContain('<caption class="sr-only">Exact comparison cases</caption>');
  });
});
