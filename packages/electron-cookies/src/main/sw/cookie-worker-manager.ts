import { QUIT_FLUSH_TIMEOUT_MS } from "../../store.ts";
import type {
  CookieChange,
  CookieItem,
  CookieWorkerOptions,
  EventRef,
  Operation,
  OwnerId,
  WorkerPort,
} from "./contracts.ts";
import { deferred } from "./deferred.ts";
import { ScopeOperations } from "./scope-operations.ts";
import { WakeIndex } from "./wake-index.ts";

export type * from "./contracts.ts";

const RETRY_MS = [100, 400, 1_600];
const WAKE_TIMEOUT_MS = 60_000; // Chromium's startup timeout for an installed service worker.
const TASK_TIMEOUT_MS = 5 * 60_000;
const MAX_QUEUED_CHANGES = 128;

interface Lane<Item extends CookieItem> {
  readonly queue: CookieChange<Item>[];
  overflowWarned: boolean;
  cancelWait?: () => void;
}

interface Delivery {
  readonly versionId: number;
  start?: () => void;
  release(reason: "ack" | "inactive" | "destroyed" | "timeout" | "failed" | "quit"): void;
}

export class CookieWorkerManager<Item extends CookieItem = CookieItem> {
  readonly #options: CookieWorkerOptions<Item>;
  readonly #index: WakeIndex;
  readonly #operations: ScopeOperations;
  readonly #lanes = new Map<string, Lane<Item>>();
  readonly #deliveries = new Map<string, Delivery>();
  #closed = false;

  constructor(options: CookieWorkerOptions<Item>) {
    this.#options = options;
    this.#index = new WakeIndex(options.storage, options.scheduler, options.logger);
    this.#operations = new ScopeOperations(this.#index, options.scheduler, options.logger, (scope) =>
      this.#cancelScope(scope),
    );
  }

  acquire(scope: string, operation: Operation, ownerId: OwnerId) {
    return this.#operations.acquire(scope, operation, ownerId);
  }

  complete(operationId: string, success: boolean, ownerId?: OwnerId): Promise<void> {
    return this.#operations.complete(operationId, success, ownerId);
  }

  hasOwner(ownerId: OwnerId): boolean {
    return this.#operations.hasOwner(ownerId);
  }

  ownerDestroyed(ownerId: OwnerId): void {
    this.#operations.ownerDestroyed(ownerId);
  }

  onChange(event: CookieChange<Item>): void {
    if (this.#closed) return;
    for (const scope of this.#index.scopes(event)) {
      const lane = this.#lanes.get(scope);
      if (lane) {
        if (lane.queue.length === MAX_QUEUED_CHANGES) {
          lane.queue.shift();
          this.#warnOverflow(scope, lane);
        }
        lane.queue.push(event);
      } else {
        const next = { queue: [event], overflowWarned: false };
        this.#lanes.set(scope, next);
        void this.#drain(scope, next);
      }
    }
  }

  #warnOverflow(scope: string, lane: Lane<Item>): void {
    if (lane.overflowWarned) return;
    lane.overflowWarned = true;
    this.#options.logger.warn({ scope }, "Cookie change queue full; dropping oldest changes");
  }

  #cancelScope(scope: string): void {
    const lane = this.#lanes.get(scope);
    if (!lane) return;
    this.#lanes.delete(scope);
    lane.queue.length = 0;
    lane.cancelWait?.();
  }

  async #drain(scope: string, lane: Lane<Item>): Promise<void> {
    while (this.#lanes.get(scope) === lane && lane.queue.length) {
      try {
        await this.#wake(scope, lane);
      } catch {
        this.#options.logger.warn({ scope }, "Cookie change delivery failed");
      }
    }
    if (this.#lanes.get(scope) === lane) this.#lanes.delete(scope);
  }

  async #obtainWorker(scope: string, lane: Lane<Item>): Promise<WorkerPort<Item> | null | undefined> {
    // Each native call can settle only its own attempt, even after expiry or cancellation.
    const attempt = deferred<WorkerPort<Item> | null | undefined>();
    const expire = () => attempt.resolve(undefined);
    const cancelTimeout = this.#options.scheduler.after(this.#options.wakeTimeoutMs ?? WAKE_TIMEOUT_MS, expire);
    lane.cancelWait = expire;
    try {
      void this.#options.native.startWorkerForScope(scope).then(attempt.resolve, attempt.reject);
      return await attempt.promise;
    } catch {
      // Only an explicit missing registration authorizes cleanup.
      return undefined;
    } finally {
      cancelTimeout();
      lane.cancelWait = undefined;
    }
  }

  async #wake(scope: string, lane: Lane<Item>): Promise<void> {
    for (let attempt = 0; this.#lanes.get(scope) === lane; attempt++) {
      const revision = this.#index.revision(scope);
      const worker = await this.#obtainWorker(scope, lane);
      if (this.#lanes.get(scope) !== lane) return;
      if (worker === null) {
        lane.queue.shift();
        await this.#operations.missingRegistration(scope, revision);
        return;
      }
      if (worker?.scope === scope) {
        // Select the oldest retained change after the wake, including after a retry.
        const event = lane.queue.shift()!;
        const items = this.#index.eligibleItems(scope, event);
        if (!items.changed.length && !items.deleted.length) {
          this.#index.wakeSucceeded(scope);
          return;
        }
        const outcome = await this.#send(worker, items);
        if (this.#lanes.get(scope) !== lane) return;
        if (outcome === "done") {
          this.#index.wakeSucceeded(scope);
          return;
        }
        // Dispatch never started. Requeue the event unless newer changes filled the backlog.
        if (lane.queue.length < MAX_QUEUED_CHANGES) lane.queue.unshift(event);
        else this.#warnOverflow(scope, lane);
      }
      if (attempt === RETRY_MS.length) {
        this.#cancelScope(scope);
        this.#options.logger.warn(
          { scope },
          "Cookie change worker unavailable after three retries; dropping queued changes",
        );
        await this.#operations.exhausted(scope, revision);
        return;
      }
      await new Promise<void>((resolve) => {
        const cancel = this.#options.scheduler.after(RETRY_MS[attempt], resolve);
        lane.cancelWait = () => {
          cancel();
          resolve();
        };
      });
      lane.cancelWait = undefined;
    }
  }

  async #send(worker: WorkerPort<Item>, items: { changed: Item[]; deleted: Item[] }): Promise<"done" | "retry"> {
    const eventId = crypto.randomUUID();
    const { versionId, scope } = worker;
    let task: ReturnType<typeof worker.startTask>;
    try {
      task = worker.startTask();
    } catch {
      return "retry";
    }
    const dispatched = deferred<"done" | "retry">();
    const cancelTimeout = this.#options.scheduler.after(this.#options.taskTimeoutMs ?? TASK_TIMEOUT_MS, () =>
      delivery.release("timeout"),
    );
    const delivery: Delivery = {
      versionId,
      start: () => {
        delivery.start = undefined;
        dispatched.resolve("done");
      },
      release: (reason) => {
        if (!this.#deliveries.delete(eventId)) return;
        cancelTimeout();
        if (reason === "timeout") {
          if (delivery.start)
            this.#options.logger.warn({ scope, eventId }, "Dropping cookie event after dispatch timeout");
          try {
            worker.finish(eventId);
          } catch {
            this.#options.logger.warn({ scope, eventId }, "Unable to notify worker of cookie event timeout");
          }
        }
        try {
          task.end();
        } catch {
          this.#options.logger.warn({ scope, eventId }, "Unable to end cookie event task");
        }
        const retry = delivery.start && (reason === "inactive" || reason === "destroyed" || reason === "failed");
        dispatched.resolve(retry ? "retry" : "done");
      },
    };
    this.#deliveries.set(eventId, delivery);
    try {
      worker.send({ eventId, ...items });
    } catch {
      delivery.release("failed");
      this.#options.logger.warn({ scope, eventId }, "Unable to send cookie change to worker");
    }
    return dispatched.promise;
  }

  #lookup({ versionId, eventId }: EventRef): Delivery | undefined {
    const delivery = this.#deliveries.get(eventId);
    return delivery?.versionId === versionId ? delivery : undefined;
  }

  /** Sent as soon as dispatch begins, independently of waitUntil completion. */
  started(ref: EventRef): void {
    this.#lookup(ref)?.start?.();
  }

  nack(ref: EventRef): void {
    const delivery = this.#lookup(ref);
    if (delivery?.start) delivery.release("inactive");
  }

  ack(ref: EventRef): void {
    this.#lookup(ref)?.release("ack");
  }

  workerDestroyed(versionId: number): void {
    this.ownerDestroyed(versionId);
    for (const delivery of this.#deliveries.values()) {
      if (delivery.versionId === versionId) delivery.release("destroyed");
    }
  }

  quitAll(): Promise<void> {
    this.#closed = true;
    for (const scope of this.#lanes.keys()) this.#cancelScope(scope);
    for (const delivery of this.#deliveries.values()) delivery.release("quit");
    return this.#operations.quitAll(this.#options.quitTimeoutMs ?? QUIT_FLUSH_TIMEOUT_MS);
  }
}
