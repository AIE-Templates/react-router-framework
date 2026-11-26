import type { Operation, OwnerId, Scheduler, WakeLogger } from "./contracts.ts";
import { deferred } from "./deferred.ts";
import type { WakeIndex } from "./wake-index.ts";

type Outcome = "success" | "failure" | "destroyed" | "expired";

interface Request {
  readonly ownerId: OwnerId;
  granted: boolean;
  settle(outcome: Outcome): void;
  done: Promise<void>;
}

export class ScopeOperations {
  readonly #index: WakeIndex;
  readonly #scheduler: Scheduler;
  readonly #logger: WakeLogger;
  readonly #cancelEvents: (scope: string) => void;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #subscribeTails = new Map<string, Promise<void>>();
  readonly #requests = new Map<string, Request>();
  #quit?: Promise<void>;

  constructor(index: WakeIndex, scheduler: Scheduler, logger: WakeLogger, cancelEvents: (scope: string) => void) {
    this.#index = index;
    this.#scheduler = scheduler;
    this.#logger = logger;
    this.#cancelEvents = cancelEvents;
  }

  #enqueue(scope: string, run: () => Promise<void>): Promise<void> {
    const result = (this.#tails.get(scope) ?? Promise.resolve()).then(run);
    const tail = result
      .catch(() => {})
      .finally(() => {
        if (this.#tails.get(scope) === tail) this.#tails.delete(scope);
      });
    this.#tails.set(scope, tail);
    return result;
  }

  async acquire(scope: string, operation: Operation, ownerId: OwnerId): Promise<{ operationId: string }> {
    if (this.#quit) throw new Error("Cookie worker manager closed");
    if (operation.kind === "subscribe")
      this.#index.checkSubscribe(scope, this.#subscribeTails, operation.subscriptions);
    const operationId = crypto.randomUUID();
    const grant = deferred<{ operationId: string }>();
    const released = deferred<void>();
    let cancelLease: (() => void) | undefined;
    const request: Request = {
      ownerId,
      granted: false,
      settle: (value) => {
        this.#requests.delete(operationId);
        if (!request.granted) {
          grant.reject(new Error("Subscription operation owner destroyed"));
          return;
        }
        cancelLease?.();
        void this.#apply(scope, operation, value).then(released.resolve, released.reject);
      },
      done: this.#enqueue(scope, async () => {
        if (!this.#requests.has(operationId)) return;
        if (operation.kind === "subscribe") {
          await this.#index.subscribe(scope, operation.subscriptions, this.#scheduler.now());
          if (!this.#requests.has(operationId)) {
            // The owner disappeared during persistence and never received a grant.
            await this.#index.finishSubscribe(scope, "failure");
            return;
          }
        }
        this.#index.advance(scope);
        request.granted = true;
        cancelLease = this.#scheduler.after(10_000, () => {
          this.#logger.warn({ scope, operationId }, "Subscription operation lease expired");
          request.settle("expired");
        });
        grant.resolve({ operationId });
        await released.promise;
      }),
    };
    this.#requests.set(operationId, request);
    if (operation.kind === "subscribe") this.#subscribeTails.set(scope, request.done);
    void request.done
      .catch((error: unknown) => {
        this.#requests.delete(operationId);
        grant.reject(error);
        this.#logger.warn({ scope, operationId }, "Wake index operation failed");
      })
      .finally(() => {
        if (this.#subscribeTails.get(scope) === request.done) this.#subscribeTails.delete(scope);
      });
    return grant.promise;
  }

  async #apply(scope: string, operation: Operation, result: Outcome): Promise<void> {
    switch (operation.kind) {
      case "subscribe":
        await this.#index.finishSubscribe(scope, result);
        if (result === "expired") await this.#index.editSubscriptions(scope, operation.subscriptions, "pin");
        break;
      case "unsubscribe":
        if (result === "success") await this.#index.editSubscriptions(scope, operation.subscriptions, "remove");
        break;
      case "unregister":
        if (result !== "failure") {
          // A vanished holder may already have committed the native unregister.
          this.#cancelEvents(scope);
          await this.#index.clear(scope, result === "success" ? "remove" : "keep-hints");
        }
        break;
    }
  }

  async complete(operationId: string, success: boolean, ownerId?: OwnerId): Promise<void> {
    const request = this.#requests.get(operationId);
    if (!request?.granted || (ownerId !== undefined && request.ownerId !== ownerId)) return;
    request.settle(success ? "success" : "failure");
    await request.done;
  }

  hasOwner(ownerId: OwnerId): boolean {
    return [...this.#requests.values()].some((request) => request.ownerId === ownerId);
  }

  ownerDestroyed(ownerId: OwnerId): void {
    for (const request of this.#requests.values()) {
      if (request.ownerId === ownerId) request.settle("destroyed");
    }
  }

  exhausted(scope: string, revision: number): Promise<void> {
    if (!this.#index.recordExhaustion(scope, revision)) return Promise.resolve();
    return this.#enqueue(scope, () => this.#index.persistDormancy(scope));
  }

  missingRegistration(scope: string, revision: number): Promise<void> {
    return this.#enqueue(scope, async () => {
      if (this.#quit) return;
      const unchanged = this.#index.revision(scope) === revision;
      this.#index.advance(scope);
      if (unchanged) {
        this.#cancelEvents(scope);
        await this.#index.clear(scope, "remove");
      }
    });
  }

  quitAll(timeoutMs: number): Promise<void> {
    if (this.#quit) return this.#quit;
    const finished = deferred<void>();
    this.#quit = finished.promise;
    for (const request of this.#requests.values()) request.settle("destroyed");
    const cancelTimeout = this.#scheduler.after(timeoutMs, () => {
      this.#index.closeWrites();
      this.#logger.warn({ timeoutMs }, "Finalizing cookie wake index timed out");
      finished.resolve();
    });
    void Promise.all(this.#tails.values())
      .then(() => this.#index.flushForQuit())
      .then(() => {
        cancelTimeout();
        return finished.resolve();
      });
    return this.#quit;
  }
}
