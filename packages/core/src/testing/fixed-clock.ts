import type { Clock } from "../clock.js";

export class FixedClock implements Clock {
  constructor(private readonly current: Date) {}

  now(): Date {
    return new Date(this.current);
  }
}
