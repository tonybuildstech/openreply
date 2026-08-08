import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression cover for a wedge that cost a real scheduled post its slot.
 *
 * `removeOnFail` keeps a failed job for seven days under the id
 * `publish_<postId>`, and BullMQ silently ignores an `add()` that reuses an
 * existing id. So once a post's job had failed, the fire-time poll re-found the
 * post every minute, "enqueued" it, and nothing ever ran — while the log
 * cheerfully reported "Enqueued 1 due post(s)" sixty times an hour.
 *
 * The stable job id still has to do its real job: never let two live jobs
 * publish the same video twice.
 */

const findMany = vi.fn();
const getJob = vi.fn();
const add = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { scheduledPost: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

vi.mock("@/lib/queue/client", () => ({
  PUBLISH_QUEUE_NAME: "publish-processing",
  getPublishQueue: () => ({
    getJob: (...a: unknown[]) => getJob(...a),
    add: (...a: unknown[]) => add(...a),
  }),
  getRedisConnection: () => ({}),
}));

vi.mock("bullmq", () => ({ Worker: class {} }));

async function loadPoll() {
  const mod = await import("../lib/queue/publish-worker");
  return mod.enqueueDuePosts;
}

/** A job already in Redis under the reused id. */
function job(state: string, remove = vi.fn().mockResolvedValue(undefined)) {
  return { getState: vi.fn().mockResolvedValue(state), remove };
}

beforeEach(() => {
  vi.resetModules();
  findMany.mockReset().mockResolvedValue([{ id: "post_1" }]);
  getJob.mockReset();
  add.mockReset().mockResolvedValue({});
});

describe("fire-time poll enqueue", () => {
  it("enqueues a post that has no job yet", async () => {
    getJob.mockResolvedValue(null);

    expect(await (await loadPoll())()).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][2]).toEqual({ jobId: "publish_post_1" });
  });

  it("clears a retained failed job so the post can run again", async () => {
    const failed = job("failed");
    getJob.mockResolvedValue(failed);

    expect(await (await loadPoll())()).toBe(1);
    // Without the removal, add() is a silent no-op and the post never publishes.
    expect(failed.remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("clears a completed job too — an edited post is QUEUED again", async () => {
    const completed = job("completed");
    getJob.mockResolvedValue(completed);

    expect(await (await loadPoll())()).toBe(1);
    expect(completed.remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it.each(["waiting", "waiting-children", "prioritized", "active", "delayed"])(
    "leaves a live '%s' job alone rather than publishing twice",
    async (state) => {
      const live = job(state);
      getJob.mockResolvedValue(live);

      expect(await (await loadPoll())()).toBe(0);
      expect(live.remove).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    }
  );

  it("reports the number actually enqueued, not the number of rows found", async () => {
    findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    getJob.mockImplementation(async (id: string) =>
      id === "publish_a" ? job("active") : null
    );

    // 'a' is already in flight; only b and c are real work. The old code
    // returned 3 here and logged it as such.
    expect(await (await loadPoll())()).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("does nothing when nothing is due", async () => {
    findMany.mockResolvedValue([]);

    expect(await (await loadPoll())()).toBe(0);
    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
