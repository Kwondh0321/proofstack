import Link from "next/link";
import type { ReactNode } from "react";

const navigation = [
  { href: "/", label: "Overview" },
  { href: "/traces", label: "Traces" },
] as const;

export function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span aria-hidden="true" className="brand-mark">
            P
          </span>
          <span>
            <strong>ProofStack</strong>
            <small>Foundation preview</small>
          </span>
        </Link>

        <nav aria-label="Primary navigation" className="primary-nav">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" />
          Local development identity
        </div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  );
}
