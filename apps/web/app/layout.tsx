import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Shell } from "../components/shell";
import "./styles.css";

export const metadata: Metadata = {
  description: "Agent Reliability Engineering platform",
  title: {
    default: "ProofStack",
    template: "%s · ProofStack",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#090b10",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
