import { describe, expect, test } from "bun:test";
import { pool } from "../agent";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pool", () => {
  test("preserves input order regardless of completion order", async () => {
    const results = await pool([30, 10, 20], 3, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  test("respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5, 6], 2, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  test("stops dequeuing after a failure", async () => {
    const started: number[] = [];
    const attempt = pool([1, 2, 3, 4, 5, 6], 1, async (item) => {
      started.push(item);
      if (item === 2) throw new Error("boom");
    });
    await expect(attempt).rejects.toThrow("boom");
    // 3 onwards must never have been picked up.
    expect(started).toEqual([1, 2]);
  });

  test("awaits in-flight workers before propagating, so a caller cannot finalize mid-write", async () => {
    let settled = 0;
    const attempt = pool([1, 2], 2, async (item) => {
      if (item === 1) throw new Error("boom");
      await tick(25);
      settled++;
    });
    await expect(attempt).rejects.toThrow("boom");
    // The slow worker finished before the rejection surfaced; a scan that
    // recorded its counts here would not be describing work still in progress.
    expect(settled).toBe(1);
  });

  test("reports the first failure when several fail", async () => {
    const attempt = pool([1, 2], 2, async (item) => {
      await tick(item === 1 ? 0 : 20);
      throw new Error(`fail-${item}`);
    });
    await expect(attempt).rejects.toThrow("fail-1");
  });

  test("rejects a concurrency limit that would run no workers", async () => {
    const worked: number[] = [];
    const run = (limit: number) => pool([1], limit, async (n) => void worked.push(n));

    await expect(run(0)).rejects.toThrow("positive integer");
    // Number("garbage") — the shape a mistyped OBSERF_ASSESS_CONCURRENCY takes.
    await expect(run(Number.NaN)).rejects.toThrow("positive integer");
    expect(worked).toEqual([]);
  });
});
