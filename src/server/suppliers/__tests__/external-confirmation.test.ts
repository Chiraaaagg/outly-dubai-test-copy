import { describe, expect, it } from "vitest";
import {
  EXTERNAL_MIN_HOLD_MS,
  EXTERNAL_POLL_MIN_MS,
  externalHandoffAt,
  externalHoldUsable,
  externalPollDelayMs,
  serviceStartMs,
} from "../external-confirmation";

/**
 * Doc 29 Batch 6: the timing rules of external-supplier bookings (poll
 * cadence, wait limit, hold length). Pure.
 */

const MIN = 60_000;
const since = new Date("2026-12-01T06:00:00Z"); // 10:00 Dubai

describe("wait limit before the hand-off", () => {
  it("is 30 minutes (at least the 20 TravelDesk's peak-season answer calls for) when the activity is far off", () => {
    const at = externalHandoffAt({ since, serviceDate: "2026-12-05", startMinutes: 600 });
    expect(at.getTime() - since.getTime()).toBe(30 * MIN);
    expect(at.getTime() - since.getTime()).toBeGreaterThanOrEqual(20 * MIN);
  });

  it("comes earlier when the activity is near: no later than 3 hours before it starts (Asia/Dubai)", () => {
    // Waiting since 10:00 Dubai. A 13:10 start: 3 h before is 10:10, so the hand-off is 10 minutes in; a 13:30 start gives 30.
    expect(externalHandoffAt({ since, serviceDate: "2026-12-01", startMinutes: 13 * 60 + 10 }).getTime() - since.getTime()).toBe(10 * MIN);
    expect(externalHandoffAt({ since, serviceDate: "2026-12-01", startMinutes: 13 * 60 + 30 }).getTime() - since.getTime()).toBe(30 * MIN);
  });

  it("is never sooner than 5 minutes after the booking started waiting, even for an activity about to start or past", () => {
    expect(externalHandoffAt({ since, serviceDate: "2026-12-01", startMinutes: 11 * 60 }).getTime() - since.getTime()).toBe(5 * MIN);
    expect(externalHandoffAt({ since, serviceDate: "2026-11-20", startMinutes: null }).getTime() - since.getTime()).toBe(5 * MIN);
  });

  it("counts an activity without a start time from 00:00 Dubai of its date", () => {
    expect(new Date(serviceStartMs("2026-12-02", null)).toISOString()).toBe("2026-12-01T20:00:00.000Z");
    // 00:00 Dubai on 2 Dec minus 3 h = 17:00 UTC on 1 Dec, well after since + 30 min.
    expect(externalHandoffAt({ since, serviceDate: "2026-12-02", startMinutes: null }).getTime() - since.getTime()).toBe(30 * MIN);
  });
});

describe("poll cadence", () => {
  it("is 15 s inside the wait limit, never more often than every 10 s", () => {
    expect(externalPollDelayMs(null)).toBe(15_000);
    expect(externalPollDelayMs(null)).toBeGreaterThanOrEqual(EXTERNAL_POLL_MIN_MS);
  });

  it("slows after the hand-off: a quarter of the time since, from one to ten minutes, and goes on", () => {
    expect(externalPollDelayMs(0)).toBe(MIN);
    expect(externalPollDelayMs(8 * MIN)).toBe(2 * MIN);
    expect(externalPollDelayMs(4 * 3_600_000)).toBe(10 * MIN);
    for (const t of [0, 1, 59_999, 3_600_000, 1e9]) expect(externalPollDelayMs(t)).toBeGreaterThanOrEqual(EXTERNAL_POLL_MIN_MS);
  });
});

describe("hold length", () => {
  const reserved = new Date("2026-12-01T06:00:00Z");
  const after = (ms: number) => new Date(reserved.getTime() + ms);

  it("a five-minute provider hold is too short to confirm safely; ten minutes is enough", () => {
    expect(externalHoldUsable(reserved, after(5 * MIN))).toBe(false);
    expect(externalHoldUsable(reserved, after(EXTERNAL_MIN_HOLD_MS - 1))).toBe(false);
    expect(externalHoldUsable(reserved, after(EXTERNAL_MIN_HOLD_MS))).toBe(true);
    expect(externalHoldUsable(reserved, after(15 * MIN))).toBe(true);
  });

  it("an unknown deadline or hold start is never usable", () => {
    expect(externalHoldUsable(reserved, null)).toBe(false);
    expect(externalHoldUsable(null, after(15 * MIN))).toBe(false);
  });
});
