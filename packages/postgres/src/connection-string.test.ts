import { describe, expect, it } from "vitest";
import {
  PostgresConnectionStringError,
  validatePostgresConnectionString,
} from "./connection-string.js";

describe("validatePostgresConnectionString", () => {
  it("allows plaintext loopback only when explicitly enabled", () => {
    const value = "postgresql://runtime@127.0.0.1:5432/proofstack";

    expect(validatePostgresConnectionString(value, { allowPlaintextLoopback: true })).toBe(value);
    expect(() =>
      validatePostgresConnectionString(value, { allowPlaintextLoopback: false }),
    ).toThrow("sslmode=verify-full");
  });

  it("recognizes hostname and IPv6 loopback addresses", () => {
    expect(
      validatePostgresConnectionString("postgres://runtime@localhost/proofstack", {
        allowPlaintextLoopback: true,
      }),
    ).toContain("localhost");
    expect(
      validatePostgresConnectionString("postgres://runtime@[::1]/proofstack", {
        allowPlaintextLoopback: true,
      }),
    ).toContain("[::1]");
  });

  it("requires verified TLS for remote databases", () => {
    expect(() =>
      validatePostgresConnectionString("postgresql://runtime@db.example.com/proofstack", {
        allowPlaintextLoopback: true,
      }),
    ).toThrow("sslmode=verify-full");
    expect(() =>
      validatePostgresConnectionString(
        "postgresql://runtime@db.example.com/proofstack?sslmode=require",
        { allowPlaintextLoopback: true },
      ),
    ).toThrow("sslmode=verify-full");
    expect(
      validatePostgresConnectionString(
        "postgresql://runtime@db.example.com/proofstack?sslmode=verify-full",
        { allowPlaintextLoopback: true },
      ),
    ).toContain("verify-full");
  });

  it.each([
    ["not a URL", "valid URL"],
    ["https://runtime@localhost/proofstack", "postgres:"],
    ["postgresql://localhost/proofstack", "include a role"],
    ["postgresql://runtime@localhost", "include a database"],
    ["postgresql://runtime@localhost/proofstack#secret", "fragment"],
    [
      "postgresql://runtime@localhost/proofstack?sslmode=verify-full&sslmode=verify-full",
      "duplicate sslmode",
    ],
  ])("rejects malformed or ambiguous value %s", (value, message) => {
    expect(() => validatePostgresConnectionString(value, { allowPlaintextLoopback: true })).toThrow(
      message,
    );
  });

  it("returns a stable error type", () => {
    expect(() =>
      validatePostgresConnectionString("invalid", { allowPlaintextLoopback: true }),
    ).toThrow(PostgresConnectionStringError);
  });
});
