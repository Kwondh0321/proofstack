import type { PolicyEvaluationExecutionLimits } from "@proofstack/contracts";

export class PolicyRecordGraphError extends Error {
  readonly code = "policy_record_graph_failed";
  constructor(
    readonly reason:
      | "record_limit"
      | "byte_limit"
      | "reference_limit"
      | "unmeasurable_record"
      | "reference_conflict"
      | "observation_conflict",
    readonly identity?: string,
  ) {
    super(`Policy record graph: ${reason}${identity ? ` (${identity})` : ""}`);
    this.name = "PolicyRecordGraphError";
  }
}

/** Read-response admission, not a wire decoder or a promise to interrupt a pending repository call. */
export class AcquisitionBudget {
  private records = 0;
  private reads = 0;
  private bytes = 0;
  private references = 0;
  private referenceBytes = 0;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly limits: PolicyEvaluationExecutionLimits) {}

  async settle() {
    // A dual-format fixture read can start both ports before one rejects. Never return from graph
    // acquisition while its sibling read is still running, even after a limit or storage failure.
    await Promise.allSettled([...this.pending]);
  }

  usage() {
    return {
      reads: this.reads,
      records: this.records,
      bytes: this.bytes,
      references: this.references,
      referenceBytes: this.referenceBytes,
    };
  }

  private charge(bytes: number) {
    if (bytes > this.limits.maxAcquisitionRecordBytes - this.bytes - this.referenceBytes)
      throw new PolicyRecordGraphError("byte_limit");
    this.bytes += bytes;
  }

  private reserveRecords(count: number) {
    if (count > this.limits.maxAcquisitionRecords - this.records)
      throw new PolicyRecordGraphError("record_limit");
    this.records += count;
  }

  addReferences(count: number, bytes: number) {
    if (count > this.limits.maxAcquisitionRecords - this.references)
      throw new PolicyRecordGraphError("reference_limit");
    if (bytes > this.limits.maxAcquisitionRecordBytes - this.bytes - this.referenceBytes)
      throw new PolicyRecordGraphError("byte_limit");
    this.references += count;
    this.referenceBytes += bytes;
  }

  /** Each actual read, including null/duplicate responses, consumes budget before I/O. */
  wrap<T extends object>(repository: T): T {
    return new Proxy(repository, {
      get: (target, property) => {
        const method: unknown = Reflect.get(target, property);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const task = (async () => {
            const requestedEvents =
              property === "resolveExactEvents" && Array.isArray(args[2]) ? args[2].length : 0;
            // Exact trace selectors are bounded before I/O. Reserve every requested row even for
            // absent/invalid responses; a multi-event lookup is not a one-record budget shortcut.
            this.reserveRecords(1 + requestedEvents);
            this.reads++;
            const value: unknown = await Reflect.apply(method, target, args);
            if (
              property === "resolveExactEvents" &&
              Array.isArray(value) &&
              value.length > requestedEvents
            )
              this.reserveRecords(value.length - requestedEvents);
            this.measure(value);
            if (property === "findJob" && value !== null && typeof value === "object") {
              let rows = 0;
              const job = value as Record<string, unknown>;
              if (job["cancellationRequest"] != null) rows++;
              for (const key of [
                "attempts",
                "budgetLedger",
                "cancellationAcknowledgements",
                "executionObservations",
                "usageObservations",
              ]) {
                const entries = job[key];
                if (Array.isArray(entries)) rows += entries.length;
              }
              this.reserveRecords(rows);
            }
            return structuredClone(value);
          })();
          this.pending.add(task);
          void task.then(
            () => this.pending.delete(task),
            () => this.pending.delete(task),
          );
          return task;
        };
      },
    });
  }

  /** Count JSON-compatible bytes without allocating an entire encoded response or invoking getters. */
  private measure(value: unknown) {
    const active = new Set<object>();
    const string = (text: string) => {
      if (
        text.length + 2 >
        this.limits.maxAcquisitionRecordBytes - this.bytes - this.referenceBytes
      )
        throw new PolicyRecordGraphError("byte_limit");
      this.charge(Buffer.byteLength(JSON.stringify(text), "utf8"));
    };
    const visit = (item: unknown, depth: number): void => {
      if (depth > 128) throw new PolicyRecordGraphError("unmeasurable_record");
      if (item === undefined) return; // No returned wire body; the owning validator rejects this.
      if (item === null) {
        this.charge(4);
        return;
      }
      if (typeof item === "string") {
        string(item);
        return;
      }
      if (typeof item === "boolean") {
        this.charge(item ? 4 : 5);
        return;
      }
      if (typeof item === "number" && Number.isFinite(item)) {
        this.charge(Buffer.byteLength(JSON.stringify(item)));
        return;
      }
      if (typeof item !== "object" || active.has(item))
        throw new PolicyRecordGraphError("unmeasurable_record");
      const array = Array.isArray(item);
      if (
        !array &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new PolicyRecordGraphError("unmeasurable_record");
      active.add(item);
      this.charge(2);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (
        Object.getOwnPropertySymbols(item).length > 0 ||
        (array && Object.keys(descriptors).length !== item.length + 1)
      )
        throw new PolicyRecordGraphError("unmeasurable_record");
      let count = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === "length") continue;
        if (!descriptor.enumerable || (array && key !== String(count)))
          throw new PolicyRecordGraphError("unmeasurable_record");
        if (!Object.hasOwn(descriptor, "value"))
          throw new PolicyRecordGraphError("unmeasurable_record");
        if (!array && descriptor.value === undefined) continue;
        if (count++) this.charge(1);
        if (!array) {
          string(key);
          this.charge(1);
        }
        if (array && descriptor.value === undefined) this.charge(4);
        else visit(descriptor.value, depth + 1);
      }
      active.delete(item);
    };
    visit(value, 0);
  }
}
