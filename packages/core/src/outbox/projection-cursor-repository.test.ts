import { describe, expect, it } from "vitest";
import { ProjectionCursorRegressionError } from "./projection-cursor-repository.js";

describe("ProjectionCursorRegressionError", () => {
  it("preserves the rejected cursor transition", () => {
    const error = new ProjectionCursorRegressionError("42", "41");

    expect(error).toMatchObject({
      currentOutboxId: "42",
      message: "Projection cursor cannot move backward from 42 to 41",
      name: "ProjectionCursorRegressionError",
      requestedOutboxId: "41",
    });
  });
});
