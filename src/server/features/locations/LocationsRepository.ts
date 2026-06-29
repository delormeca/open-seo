import { count, eq, like, min } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { locationsCache } from "@/db/schema";

const DB_BATCH_SIZE = 100;
type BatchStatement = Parameters<typeof db.batch>[0][number];

async function executeInBatches<T>(
  items: T[],
  buildStatement: (item: T) => BatchStatement,
) {
  for (let i = 0; i < items.length; i += DB_BATCH_SIZE) {
    const chunk = items.slice(i, i + DB_BATCH_SIZE).map(buildStatement);
    const [first, ...rest] = chunk;
    if (!first) continue;
    await db.batch([first, ...rest]);
  }
}

async function getCount() {
  const rows = await db.select({ value: count() }).from(locationsCache);
  return rows[0]?.value ?? 0;
}

async function getOldestFetchedAt() {
  const rows = await db
    .select({ value: min(locationsCache.fetchedAt) })
    .from(locationsCache);
  return rows[0]?.value ?? null;
}

async function clearAll() {
  await db.delete(locationsCache);
}

async function search(normalizedQuery: string, limit: number) {
  return db
    .select()
    .from(locationsCache)
    .where(like(locationsCache.nameNormalized, `%${normalizedQuery}%`))
    .limit(limit);
}

async function insertBatch(
  locations: Array<InferInsertModel<typeof locationsCache>>,
) {
  await executeInBatches(locations, (loc) =>
    db.insert(locationsCache).values(loc).onConflictDoNothing(),
  );
}

async function getByCode(code: number) {
  const rows = await db
    .select()
    .from(locationsCache)
    .where(eq(locationsCache.code, code))
    .limit(1);
  return rows[0] ?? null;
}

export const LocationsRepository = {
  getCount,
  getOldestFetchedAt,
  clearAll,
  search,
  insertBatch,
  getByCode,
};
