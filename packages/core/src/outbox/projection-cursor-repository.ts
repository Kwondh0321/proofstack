export interface ProjectionCursorKey {
  readonly consumerName: string;
  readonly generation: number;
}

export interface ProjectionCursor extends ProjectionCursorKey {
  readonly lastOutboxId: string;
  readonly tenantId: string;
  readonly updatedAt: string;
}

export interface AdvanceProjectionCursorOptions extends ProjectionCursorKey {
  readonly lastOutboxId: string;
}

export interface AdvanceProjectionCursorResult {
  readonly advanced: boolean;
  readonly cursor: ProjectionCursor;
}

export class ProjectionCursorRegressionError extends Error {
  readonly currentOutboxId: string;
  readonly requestedOutboxId: string;

  constructor(currentOutboxId: string, requestedOutboxId: string) {
    super(`Projection cursor cannot move backward from ${currentOutboxId} to ${requestedOutboxId}`);
    this.name = "ProjectionCursorRegressionError";
    this.currentOutboxId = currentOutboxId;
    this.requestedOutboxId = requestedOutboxId;
  }
}

export interface ProjectionCursorRepository {
  advance(
    tenantId: string,
    options: AdvanceProjectionCursorOptions,
  ): Promise<AdvanceProjectionCursorResult>;
  get(tenantId: string, key: ProjectionCursorKey): Promise<ProjectionCursor | null>;
}
