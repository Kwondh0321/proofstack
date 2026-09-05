import { createElement, type ReactNode } from "react";

export function ScrollableTable({
  caption,
  children,
}: {
  readonly caption: string;
  readonly children?: ReactNode;
}) {
  // The named overflow section is deliberately focusable so keyboard users can scroll wide
  // evidence tables in browsers that do not add scroll containers to the tab order themselves.
  return createElement(
    "section",
    {
      "aria-label": `${caption}; scroll horizontally for additional columns`,
      className: "table-scroll",
      tabIndex: 0,
    },
    children,
  );
}
