import { cookiePathMatches } from "../../parse.ts";
import { abandonOn } from "../../store.ts";
import type {
  CookieChange,
  CookieItem,
  Scheduler,
  Subscription,
  WakeLogger,
  WakeRecord,
  WakeStorage,
} from "./contracts.ts";

const WRITE_TIMEOUT_MS = 5_000;
const MAX_OPERATION_SUBSCRIPTIONS = 128;
const MAX_SCOPE_SUBSCRIPTIONS = 256;
const MAX_SCOPES = 128;
const MAX_NAME_BYTES = 4096;
const MAX_EXHAUSTED_CYCLES = 3;

export function checkSubscriptionCount(count: number): void {
  if (count > MAX_OPERATION_SUBSCRIPTIONS)
    throw new TypeError("Cookie subscription limit exceeded: too many entries in one operation");
}

function oversizedName(name: string | undefined): boolean {
  return name !== undefined && Buffer.byteLength(name) > MAX_NAME_BYTES;
}

function matches(record: WakeRecord, item: CookieItem): boolean {
  if (record.name !== undefined && item.name !== record.name) return false;
  const path = new URL(record.url ?? record.scope).pathname;
  return cookiePathMatches(path, item.path);
}

function sameSubscription(scope: string, left: Subscription, right: Subscription): boolean {
  return left.name === right.name && (left.url ?? scope) === (right.url ?? scope);
}

/** Subscriptions passed by the adapter have already been resolved to absolute URLs. */
export class WakeIndex {
  readonly #storage: WakeStorage;
  readonly #scheduler: Scheduler;
  readonly #logger: WakeLogger;
  readonly #failures = new Map<string, number>();
  #sequence = 0;
  readonly #revisions = new Map<string, number>();
  #records = new Map<string, WakeRecord[]>();
  #saved = this.#records;
  // On disk these hints cover a crash after native subscribe. In this process we can wait for its outcome.
  readonly #pending = new WeakSet<WakeRecord>();
  #lastWrite: Promise<void> = Promise.resolve();
  readonly #closed = new AbortController();
  #stalled = false;
  #retryQueued = false;

  constructor(storage: WakeStorage, scheduler: Scheduler, logger: WakeLogger) {
    this.#storage = storage;
    this.#scheduler = scheduler;
    this.#logger = logger;
    let discarded = 0;
    // A holder from a previous process cannot resume. Its native subscription may still exist.
    for (const { pinned: _pinned, ...stored } of storage.read()) {
      // A restored subscription predates every notification in this launch, even after a clock rollback.
      const record = { ...stored, since: 0 };
      const records = this.#records.get(record.scope);
      if (
        oversizedName(record.name) ||
        (records ? records.length >= MAX_SCOPE_SUBSCRIPTIONS : this.#records.size >= MAX_SCOPES)
      ) {
        discarded++;
        continue;
      }
      if (records) records.push(record);
      else this.#records.set(record.scope, [record]);
    }
    if (discarded) logger.warn({ discarded }, "Discarding restored wake hints over the cookie subscription limits");
  }

  checkSubscribe(
    scope: string,
    activeScopes: ReadonlyMap<string, unknown>,
    subscriptions: readonly Subscription[],
  ): void {
    checkSubscriptionCount(subscriptions.length);
    if (subscriptions.some(({ name }) => oversizedName(name)))
      throw new TypeError("Cookie subscription limit exceeded: name exceeds 4096 UTF-8 bytes");
    if (this.#records.has(scope) || activeScopes.has(scope)) return;
    let count = this.#records.size;
    for (const active of activeScopes.keys()) if (!this.#records.has(active)) count++;
    if (count >= MAX_SCOPES) throw new TypeError("Cookie subscription limit exceeded: too many scopes");
  }

  revision(scope: string): number {
    return this.#revisions.get(scope) ?? 0;
  }

  advance(scope: string): void {
    if (this.#records.has(scope)) this.#revisions.set(scope, ++this.#sequence);
    else {
      this.#revisions.delete(scope);
      this.#failures.delete(scope);
    }
  }

  closeWrites(): void {
    this.#closed.abort();
  }

  #withScope(scope: string, records: WakeRecord[]) {
    const next = new Map(this.#records);
    if (records.length) next.set(scope, records);
    else next.delete(scope);
    return next;
  }

  async #save(snapshot: Map<string, WakeRecord[]>): Promise<void> {
    if (this.#saved === snapshot) return;
    await this.#storage.write([...snapshot.values()].flat());
    this.#saved = snapshot;
  }

  async #write(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#closed.signal.aborted) return;
    if (this.#stalled) throw new Error("Cookie wake index write is still pending. Retry later.");
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, this.#closed.signal]);
    const cancelTimer = this.#scheduler.after(WRITE_TIMEOUT_MS, () => {
      if (!this.#stalled) {
        this.#stalled = true;
        void this.#lastWrite.finally(() => {
          this.#stalled = false;
        });
      }
      deadline.abort(new Error("Cookie wake index write timed out. Retry later."));
    });
    const write = this.#lastWrite.then(() => (signal.aborted ? undefined : run(signal)));
    // Only physical settlement releases the writer. An expired caller cannot start a competing replacement.
    this.#lastWrite = write.catch(() => {});
    try {
      await abandonOn(write, signal);
    } catch (error) {
      if (!this.#closed.signal.aborted) throw error;
    } finally {
      cancelTimer();
    }
  }

  async #repair(): Promise<void> {
    if (this.#closed.signal.aborted) return;
    try {
      await this.#save(this.#records);
    } catch {
      this.#logger.warn({ scopeCount: this.#records.size }, "Could not persist the current cookie wake index");
    }
  }

  flushForQuit(): Promise<void> {
    return this.#lastWrite.then(() => this.#repair());
  }

  async #edit(scope: string, records: WakeRecord[]): Promise<void> {
    // The native operation is already committed. Publish its new eligibility even if the disk is unavailable.
    this.#records = this.#withScope(scope, records);
    this.advance(scope);
    try {
      await this.#write(() => this.#save(this.#records));
    } catch {
      this.#logger.warn({ scope }, "Retrying cookie wake index cleanup after a write failure");
      if (!this.#retryQueued) {
        this.#retryQueued = true;
        this.#lastWrite = this.#lastWrite.then(() => {
          this.#retryQueued = false;
          return this.#repair();
        });
      }
    }
  }

  subscribe(scope: string, subscriptions: readonly Subscription[], since: number): Promise<void> {
    const records = [...(this.#records.get(scope) ?? [])];
    const dormant = records[0]?.dormant;
    for (const subscription of subscriptions) {
      const i = records.findIndex((r) => sameSubscription(scope, r, subscription));
      if (i >= 0 && records[i].eligible) continue;
      if (i < 0 && records.length >= MAX_SCOPE_SUBSCRIPTIONS)
        throw new TypeError("Cookie subscription limit exceeded: too many subscriptions for this scope");
      const record = {
        ...(i < 0 ? subscription : records[i]),
        scope,
        since,
        eligible: true,
        ...(dormant && { dormant }),
      };
      this.#pending.add(record);
      if (i < 0) records.push(record);
      else records[i] = record;
    }
    return this.#write(async (signal) => {
      const base = this.#records;
      const next = this.#withScope(scope, records);
      await this.#save(next);
      if (signal.aborted) {
        // This attempt never granted native subscribe. Remove its late hints from disk in the same writer turn.
        await this.#repair();
        return;
      }
      // An unrelated scope can commit a native removal while this write is in flight.
      this.#records = this.#records === base ? next : this.#withScope(scope, records);
      this.advance(scope);
    });
  }

  finishSubscribe(scope: string, result: "success" | "failure" | "expired" | "destroyed"): Promise<void> {
    // Operations are serialized per scope. A failed duplicate must preserve an older successful subscribe.
    const records = this.#records.get(scope) ?? [];
    if (result === "success") {
      this.wakeSucceeded(scope);
      this.advance(scope);
    }
    let changed = false;
    const next = records.map((record) => {
      const pending = this.#pending.delete(record);
      if (result === "success" && record.dormant) {
        changed = true;
        const { dormant: _dormant, ...active } = record;
        return active;
      }
      if (result === "failure" && pending) {
        changed = true;
        return { ...record, eligible: false };
      }
      return record;
    });
    return changed ? this.#edit(scope, next) : Promise.resolve();
  }

  editSubscriptions(scope: string, subscriptions: readonly Subscription[], action: "remove" | "pin"): Promise<void> {
    const current = this.#records.get(scope);
    if (!current) return Promise.resolve();
    const records = current.flatMap((r) => {
      if (!subscriptions.some((s) => sameSubscription(scope, r, s))) return [r];
      if (action === "pin") return [{ ...r, pinned: true }];
      return r.pinned ? [r] : [];
    });
    return this.#edit(scope, records);
  }

  clear(scope: string, action: "remove" | "keep-hints"): Promise<void> {
    const current = this.#records.get(scope);
    if (!current) return Promise.resolve();
    const records = action === "keep-hints" ? current.map((r) => ({ ...r, eligible: false })) : [];
    return this.#edit(scope, records);
  }

  wakeSucceeded(scope: string): void {
    this.#failures.delete(scope);
  }

  recordExhaustion(scope: string, revision: number): boolean {
    if (!this.#records.has(scope) || this.revision(scope) !== revision) return false;
    const count = (this.#failures.get(scope) ?? 0) + 1;
    this.#failures.set(scope, count);
    return count === MAX_EXHAUSTED_CYCLES;
  }

  persistDormancy(scope: string): Promise<void> {
    const records = this.#records.get(scope);
    // A subscribe can succeed or the scope can be removed while this edit waits for its turn.
    if (!records || this.#failures.get(scope) !== MAX_EXHAUSTED_CYCLES) return Promise.resolve();
    return this.#edit(
      scope,
      records.map((record) => ({ ...record, dormant: true })),
    );
  }

  scopes<Item extends CookieItem>(event: CookieChange<Item>): Set<string> {
    const scopes = new Set<string>();
    for (const [scope, records] of this.#records) {
      if (records[0].dormant || this.#failures.get(scope) === MAX_EXHAUSTED_CYCLES) continue;
      const coarseMatch = (item: Item) => records.some((r) => matches(r, item));
      if (event.changed.some(coarseMatch) || event.deleted.some(coarseMatch)) scopes.add(scope);
    }
    return scopes;
  }

  eligibleItems<Item extends CookieItem>(scope: string, event: CookieChange<Item>) {
    const records = (this.#records.get(scope) ?? []).filter(
      (r) => r.eligible && !this.#pending.has(r) && r.since < event.time,
    );
    const eligible = (item: Item) => records.some((r) => matches(r, item));
    return { changed: event.changed.filter(eligible), deleted: event.deleted.filter(eligible) };
  }
}
