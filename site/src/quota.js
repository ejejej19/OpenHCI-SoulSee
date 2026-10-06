export const GHOST_DAILY_LIMIT = 10_000;

const TAIPEI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function taipeiQuotaWindow(now = Date.now()) {
  const dayIndex = Math.floor((now + TAIPEI_UTC_OFFSET_MS) / DAY_MS);
  return {
    key: `ghost-generation:${dayIndex}`,
    resetAt: (dayIndex + 1) * DAY_MS - TAIPEI_UTC_OFFSET_MS,
  };
}

export async function reserveGhostGeneration(
  env,
  { now = Date.now(), limit = GHOST_DAILY_LIMIT } = {},
) {
  const window = taipeiQuotaWindow(now);
  const stub = env.GHOST_DAILY_LIMIT.getByName(window.key, {
    locationHint: "apac-ne",
  });

  return {
    ...(await stub.consume(limit)),
    resetAt: window.resetAt,
  };
}
