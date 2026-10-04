/**
 * Pin the real village day for a test file. A run dated before the real day is
 * read-only for delivery state, so tests that use fixed dates pin "now" to a
 * day before all of them; tests about back-dated runs set their own.
 */

import { afterEach, beforeEach } from "bun:test";

import { deliveryClock } from "../delivery-state";

export const PINNED_NOW = new Date("2026-01-01T06:00:00Z");

export function pinDeliveryClock(now: Date = PINNED_NOW): void {
  const real = deliveryClock.now;
  beforeEach(() => {
    deliveryClock.now = () => now;
  });
  afterEach(() => {
    deliveryClock.now = real;
  });
}
