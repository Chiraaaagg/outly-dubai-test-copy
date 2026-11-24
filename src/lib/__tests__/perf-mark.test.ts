import { describe, expect, it } from "vitest";
import { durationBucket, startMark } from "../perf-mark";
import { clientEventSchema } from "@/server/schemas/events.schemas";

/**
 * The browser mark helper (doc 29 §6.6): coarse buckets only, null for bad
 * clocks, and a bucket fits the existing collector's prop rules on an
 * existing event, so no new event or dependency is needed.
 */

describe("durationBucket", () => {
  it.each([
    [0, "lt_100ms"],
    [99.9, "lt_100ms"],
    [100, "lt_300ms"],
    [999, "lt_1s"],
    [2_499, "lt_2_5s"],
    [4_999, "lt_5s"],
    [7_999, "lt_8s"],
    [14_999, "lt_15s"],
    [15_000, "ge_15s"],
    [3_600_000, "ge_15s"],
  ])("%d ms is %s", (ms, bucket) => {
    expect(durationBucket(ms)).toBe(bucket);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("refuses %s", (ms) => {
    expect(durationBucket(ms)).toBeNull();
  });
});

describe("startMark", () => {
  it("returns the bucket of the elapsed time, once", () => {
    let t = 1_000;
    const done = startMark("quote", () => t);
    t = 2_200;
    expect(done()).toBe("lt_2_5s");
    t = 99_000;
    expect(done()).toBe("lt_2_5s");
  });

  it("is null without a usable clock", () => {
    expect(startMark("quote", () => Number.NaN)()).toBeNull();
  });

  it("travels as a primitive prop on an existing event", () => {
    const done = startMark("payment_session", (() => {
      let t = 0;
      return () => (t += 400);
    })());
    const body = { event: "payment_initiated", event_id: "evt-synthetic-1", duration_bucket: done() };
    expect(clientEventSchema.safeParse(body).success).toBe(true);
  });
});
