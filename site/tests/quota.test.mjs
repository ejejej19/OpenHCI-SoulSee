import assert from "node:assert/strict";
import test from "node:test";

import {
  GHOST_DAILY_LIMIT,
  reserveGhostGeneration,
  taipeiQuotaWindow,
} from "../src/quota.js";

test("Taipei quota resets at local midnight", () => {
  const beforeMidnight = Date.parse("2026-07-13T15:59:59.999Z");
  const atMidnight = Date.parse("2026-07-13T16:00:00.000Z");

  const before = taipeiQuotaWindow(beforeMidnight);
  const after = taipeiQuotaWindow(atMidnight);

  assert.notEqual(before.key, after.key);
  assert.equal(before.resetAt, atMidnight);
  assert.equal(after.resetAt, Date.parse("2026-07-14T16:00:00.000Z"));
});

test("quota keys remain stable within a Taipei calendar day", () => {
  const morning = taipeiQuotaWindow(Date.parse("2026-07-14T01:00:00.000Z"));
  const evening = taipeiQuotaWindow(Date.parse("2026-07-14T15:59:59.999Z"));

  assert.equal(morning.key, evening.key);
  assert.equal(morning.resetAt, evening.resetAt);
});

test("reserveGhostGeneration consumes the configured limit from the daily object", async () => {
  const calls = [];
  const env = {
    GHOST_DAILY_LIMIT: {
      getByName(name, options) {
        calls.push({ name, options });
        return {
          async consume(limit) {
            calls.push({ limit });
            return { allowed: true, used: 1, remaining: limit - 1 };
          },
        };
      },
    },
  };
  const now = Date.parse("2026-07-14T02:00:00.000Z");

  const result = await reserveGhostGeneration(env, { now });

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, GHOST_DAILY_LIMIT - 1);
  assert.equal(result.resetAt, Date.parse("2026-07-14T16:00:00.000Z"));
  assert.deepEqual(calls, [
    {
      name: taipeiQuotaWindow(now).key,
      options: { locationHint: "apac-ne" },
    },
    { limit: GHOST_DAILY_LIMIT },
  ]);
});
