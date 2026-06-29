import type { WorkflowStep } from "cloudflare:workers";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";
import type {
  createDataforseoClient,
  PostedRankCheckTask,
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { KEYWORDS_PER_BATCH } from "@/shared/rank-tracking";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

type KeywordEntry = { id: string; keyword: string; locationCode?: number | null };
type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

function mapResultsToSnapshotRows(
  runId: string,
  results: RankCheckResultWithDevice[],
) {
  return results.map((r) => ({
    runId,
    trackingKeywordId: r.keywordId,
    keyword: r.keyword,
    device: r.device,
    position: r.position,
    url: r.url,
    serpFeatures:
      r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
  }));
}

interface CheckContext {
  client: ReturnType<typeof createDataforseoClient>;
  keywords: KeywordEntry[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  domain: string;
  locationCode: number;
  languageCode: string;
  runId: string;
}

/** RankCheckTaskInput extended with a resolved per-task location. */
type TaskInputWithLocation = RankCheckTaskInput & { locationCode: number };

/** Expand keywords into one task input per keyword/device pair. */
function expandToTaskInputs(
  keywords: KeywordEntry[],
  devices: RankTrackingConfig["devices"],
  defaultLocationCode: number,
): TaskInputWithLocation[] {
  const deviceList: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  return keywords.flatMap((kw) =>
    deviceList.map((device) => ({
      keyword: kw.keyword,
      keywordId: kw.id,
      device,
      locationCode: kw.locationCode ?? defaultLocationCode,
    })),
  );
}

/**
 * Group an array of items by a key derived from each item.
 * Returns a Map preserving insertion order of first-seen keys.
 */
function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step bodies. Each runs inside a single step.do: inputs are its parameters,
// the return value is what the workflow engine persists and replays. They must
// not touch any mutable state outside their arguments.
// ---------------------------------------------------------------------------

/**
 * Check keyword/device pairs against the live endpoint and persist snapshots.
 * Per-call failures are logged and skipped (the metered client already charged
 * or refused each call individually). Returns the snapshot count written.
 * Each task carries its own resolved locationCode (keyword-level override or
 * config default).
 */
async function checkBatchLive(
  ctx: CheckContext,
  tasks: TaskInputWithLocation[],
): Promise<number> {
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      ctx.client.serp
        .rankCheck({
          keyword: task.keyword,
          keywordId: task.keywordId,
          locationCode: task.locationCode,
          languageCode: ctx.languageCode,
          device: task.device,
          targetDomain: ctx.domain,
          depth: ctx.serpDepth,
        })
        .then((r) => ({ ...r, device: task.device })),
    ),
  );
  const results: RankCheckResultWithDevice[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      console.error(
        `[rank-check] ${ctx.runId} live call failed:`,
        outcome.reason,
      );
    }
  }
  if (results.length > 0) {
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(ctx.runId, results),
    );
  }
  return results.length;
}

/**
 * Check keywords via Live API, parallel devices per keyword, real-time progress.
 * Keywords are grouped by their effective location code (keyword-level override
 * or config default). Within each location group, keywords are processed in
 * batches of KEYWORDS_PER_BATCH keywords (not tasks) with per-call billing
 * handled by the metered client. Snapshots are written incrementally after each
 * batch so partial results survive batch failures. ~6s per keyword batch.
 */
export async function runLiveCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<void> {
  // Group keywords by effective location, then expand each group to tasks.
  const keywordsByLocation = groupBy(
    ctx.keywords,
    (kw) => kw.locationCode ?? ctx.locationCode,
  );

  let globalBatchIndex = 0;
  let keywordsChecked = 0;

  for (const [locationCode, locationKeywords] of keywordsByLocation) {
    for (let i = 0; i < locationKeywords.length; i += KEYWORDS_PER_BATCH) {
      const keywordBatch = locationKeywords.slice(i, i + KEYWORDS_PER_BATCH);
      // Expand this keyword batch to tasks with the group's resolved location.
      const batchTasks = expandToTaskInputs(keywordBatch, ctx.devices, locationCode);
      const batchIndex = globalBatchIndex++;
      const batchKeywordsChecked = keywordsChecked + keywordBatch.length;

      await step.do(
        `live-batch-${batchIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const written = await checkBatchLive(ctx, batchTasks);
          // Progress for the UI; finalize recounts from the DB anyway.
          await RankTrackingRepository.updateRun(ctx.runId, {
            keywordsChecked: batchKeywordsChecked,
          });
          return written;
        },
      );

      keywordsChecked = batchKeywordsChecked;
    }
  }
}

// Poll cadence for queued tasks. Standard-priority tasks complete in ~5
// minutes on average, so the first check waits 4 minutes; cumulative waits are
// 4 / 6 / 8 / 10 / 12 / 15 minutes, after which stragglers fall back to the
// live endpoint.
const QUEUED_POLL_INTERVALS = [
  "4 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "3 minutes",
] as const;

/** Concurrent task_get requests within a collect step. */
const TASK_GET_CONCURRENCY = 25;

/** Max task_get calls per collect round (per-invocation subrequest budget). */
const TASK_GETS_PER_COLLECT = 500;

// Collect steps may issue hundreds of task_get calls, so they get more room
// than SINGLE_ATTEMPT_STEP_CONFIG's 2-minute timeout. Unlike the metered
// steps, retrying is safe and free: task_get isn't charged and snapshot
// inserts are onConflictDoNothing.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

interface CollectRoundOutcome {
  /** Snapshots written this round. */
  collected: number;
  /** Tasks still in DataForSEO's queue — poll again next round. */
  stillPending: PostedRankCheckTask[];
  /** Tasks DataForSEO failed — route to the live fallback. */
  failed: PostedRankCheckTask[];
}

/**
 * Fetch results for queued tasks (one free task_get each), persist completed
 * snapshots, and update run progress. Transient task_get failures stay
 * pending for the next round.
 */
async function collectQueuedRound(
  ctx: CheckContext,
  tasks: PostedRankCheckTask[],
): Promise<CollectRoundOutcome> {
  const completed: RankCheckResultWithDevice[] = [];
  const stillPending: PostedRankCheckTask[] = [];
  const failed: PostedRankCheckTask[] = [];

  for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
    const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((task) =>
        fetchRankCheckTaskResult({
          taskId: task.taskId,
          keywordId: task.keywordId,
          keyword: task.keyword,
          targetDomain: ctx.domain,
        }),
      ),
    );
    settled.forEach((result, index) => {
      const task = chunk[index];
      if (result.status === "rejected") {
        // Transient fetch failure — try again next round.
        console.warn(
          `[rank-check] ${ctx.runId} task_get failed:`,
          result.reason,
        );
        stillPending.push(task);
      } else if (result.value.status === "pending") {
        stillPending.push(task);
      } else if (result.value.status === "failed") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} failed: ${result.value.message}`,
        );
        failed.push(task);
      } else {
        completed.push({ ...result.value.result, device: task.device });
      }
    });
  }

  if (completed.length > 0) {
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(ctx.runId, completed),
    );
    // Progress for the UI; finalize recounts from the DB anyway.
    const snapshots = await RankTrackingRepository.getSnapshotsForRun(
      ctx.runId,
    );
    await RankTrackingRepository.updateRun(ctx.runId, {
      keywordsChecked: new Set(snapshots.map((s) => s.trackingKeywordId)).size,
    });
  }

  return { collected: completed.length, stillPending, failed };
}

/** Per-run accounting for the queued path, in keyword/device task units. */
export interface QueuedCheckStats {
  /** Tasks accepted into DataForSEO's queue. */
  queueTasks: number;
  /** Task results collected from the queue within the polling window. */
  queueCollected: number;
  /** Tasks routed to the live fallback (rejected, failed, or timed out). */
  fallbackTasks: number;
  /** Fallback tasks that produced a snapshot. */
  fallbackChecked: number;
}

/** PostedRankCheckTask with the resolved location retained for the fallback path. */
type PostedRankCheckTaskWithLocation = PostedRankCheckTask & {
  locationCode: number;
};

/**
 * Check keywords via DataForSEO's standard task queue (~30% of live cost).
 * Keywords are grouped by their effective location code (keyword-level override
 * or config default). Each location group is posted in chunks of at most
 * MAX_TASKS_PER_POST using that group's locationCode — because DataForSEO's
 * task_post API applies one location per request. The polling and fallback
 * logic is unchanged; location is carried on every pending/fallback entry so
 * the live fallback uses the correct per-keyword location.
 * Billing happens at task_post (and per live-fallback call).
 */
export async function runQueuedCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<QueuedCheckStats> {
  const taskInputs = expandToTaskInputs(ctx.keywords, ctx.devices, ctx.locationCode);

  // Group task inputs by effective location so each task_post call uses a
  // uniform location code (DataForSEO requires one location per POST body).
  const tasksByLocation = groupBy(taskInputs, (t) => t.locationCode);

  // Post all tasks to the queue, <=100 per request, one metered step each.
  // A failed chunk must not abort the run — earlier chunks were already
  // charged at DataForSEO, so their results have to be collected. The failed
  // chunk's pairs go to the live fallback instead.
  let pending: PostedRankCheckTaskWithLocation[] = [];
  const fallback: TaskInputWithLocation[] = [];
  let globalPostIndex = 0;

  for (const [locationCode, locationTasks] of tasksByLocation) {
    for (let i = 0; i < locationTasks.length; i += MAX_TASKS_PER_POST) {
      const chunk = locationTasks.slice(i, i + MAX_TASKS_PER_POST);
      const postIndex = globalPostIndex++;
      let posted: PostedRankCheckTask[];
      try {
        posted = await step.do(
          `post-tasks-${postIndex}`,
          SINGLE_ATTEMPT_STEP_CONFIG,
          async () =>
            ctx.client.serp.rankCheckTaskPost({
              tasks: chunk,
              locationCode,
              languageCode: ctx.languageCode,
              depth: ctx.serpDepth,
              targetDomain: ctx.domain,
            }),
        );
      } catch (error) {
        console.warn(
          `[rank-check] ${ctx.runId} post-tasks-${postIndex} failed:`,
          error,
        );
        fallback.push(...chunk);
        continue;
      }
      pending.push(...posted.map((t) => ({ ...t, locationCode })));
      if (posted.length < chunk.length) {
        const acceptedKeys = new Set(
          posted.map((t) => `${t.keywordId}:${t.device}`),
        );
        fallback.push(
          ...chunk.filter((t) => !acceptedKeys.has(`${t.keywordId}:${t.device}`)),
        );
      }
    }
  }

  const stats: QueuedCheckStats = {
    queueTasks: pending.length,
    queueCollected: 0,
    fallbackTasks: 0,
    fallbackChecked: 0,
  };

  // Poll until everything is collected or the ~15 minute window closes. A
  // collect failure (past its retries) leaves that round's tasks pending for
  // the next round — or the live fallback — instead of failing the run; the
  // posted tasks are already paid for.
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);

    // Cap task_gets per round so one collect step stays well inside the
    // per-invocation subrequest limit at the 1000-keyword config ceiling.
    const batch = pending.slice(0, TASK_GETS_PER_COLLECT);
    const overflow = pending.slice(TASK_GETS_PER_COLLECT);

    let outcome: CollectRoundOutcome;
    try {
      outcome = await step.do(`collect-${round}`, COLLECT_STEP_CONFIG, () =>
        collectQueuedRound(ctx, batch),
      );
    } catch (error) {
      console.warn(`[rank-check] ${ctx.runId} collect-${round} failed:`, error);
      continue;
    }

    stats.queueCollected += outcome.collected;
    // collectQueuedRound pushes the original task objects into stillPending /
    // failed, so the locationCode we attached is still present at runtime even
    // though TypeScript only sees PostedRankCheckTask. Cast to recover it.
    pending = [
      ...(outcome.stillPending as PostedRankCheckTaskWithLocation[]),
      ...overflow,
    ];
    fallback.push(
      ...(outcome.failed as PostedRankCheckTaskWithLocation[]).map((t) => ({
        keyword: t.keyword,
        keywordId: t.keywordId,
        device: t.device,
        locationCode: t.locationCode,
      })),
    );
  }

  // Live fallback: queued tasks that never finished, failed, or were rejected
  // at post time. A straggler is double-billed (customer was metered the
  // queued post cost and now the live call too — fractions of a cent).
  // Progress isn't updated here; finalize recounts keywordsChecked from the DB.
  // Each straggler carries its resolved locationCode so the live call uses
  // the correct per-keyword location.
  const stragglers: TaskInputWithLocation[] = [
    ...fallback,
    ...pending.map((t) => ({
      keyword: t.keyword,
      keywordId: t.keywordId,
      device: t.device,
      locationCode: t.locationCode,
    })),
  ];
  stats.fallbackTasks = stragglers.length;
  if (stragglers.length === 0) return stats;

  console.log(
    `[rank-check] ${ctx.runId} live fallback for ${stragglers.length} task(s)`,
  );

  for (let i = 0; i < stragglers.length; i += KEYWORDS_PER_BATCH) {
    const batch = stragglers.slice(i, i + KEYWORDS_PER_BATCH);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);

    stats.fallbackChecked += await step.do(
      `fallback-batch-${batchIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      () => checkBatchLive(ctx, batch),
    );
  }

  return stats;
}
