import type { CookieChange, CookieItem, Subscription, WakeRecord, WakeStorage } from "./contracts.ts";

function matches(record: WakeRecord, item: CookieItem): boolean {
  if (record.name !== undefined && item.name !== record.name) return false;
  const path = new URL(record.url ?? record.scope).pathname;
  return (
    path === item.path || (path.startsWith(item.path) && (item.path.endsWith("/") || path[item.path.length] === "/"))
  );
}

function sameSubscription(scope: string, left: Subscription, right: Subscription): boolean {
  return left.name === right.name && (left.url ?? scope) === (right.url ?? scope);
}

/** Subscriptions passed by the adapter have already been resolved to absolute URLs. */
export class WakeIndex {
  readonly #storage: WakeStorage;
  readonly #revisions = new Map<string, number>();
  readonly #records = new Map<string, WakeRecord[]>();
  #lastWrite: Promise<void> = Promise.resolve();

  constructor(storage: WakeStorage) {
    this.#storage = storage;
    // A holder from a previous process cannot resume. Its native subscription may still exist.
    for (const { pinned: _pinned, ...record } of storage.read()) {
      const records = this.#records.get(record.scope);
      if (records) records.push(record);
      else this.#records.set(record.scope, [record]);
    }
  }

  revision(scope: string): number {
    return this.#revisions.get(scope) ?? 0;
  }

  advance(scope: string): void {
    this.#revisions.set(scope, this.revision(scope) + 1);
  }

  #publish(scope: string, records: WakeRecord[]): void {
    if (records.length) this.#records.set(scope, records);
    else this.#records.delete(scope);
    this.advance(scope);
  }

  #write(scope: string, records: WakeRecord[], publish: "immediately" | "after-write"): Promise<void> {
    if (publish === "immediately") this.#publish(scope, records);
    // Scopes have independent owners but share one file. Build each snapshot at the head
    // of the writer queue so a failed subscribe cannot leak into another scope's write.
    const write = this.#lastWrite.then(async () => {
      const snapshot = new Map(this.#records);
      snapshot.set(scope, records);
      await this.#storage.write([...snapshot.values()].flat());
      if (publish === "after-write") this.#publish(scope, records);
      return;
    });
    this.#lastWrite = write.catch(() => {});
    return write;
  }

  subscribe(scope: string, subscriptions: readonly Subscription[], since: number): Promise<void> {
    const records = [...(this.#records.get(scope) ?? [])];
    for (const subscription of subscriptions) {
      const i = records.findIndex((r) => sameSubscription(scope, r, subscription));
      if (i < 0) records.push({ ...subscription, scope, since, eligible: true });
      else if (!records[i].eligible) records[i] = { ...records[i], since, eligible: true };
    }
    return this.#write(scope, records, "after-write");
  }

  editSubscriptions(scope: string, subscriptions: readonly Subscription[], action: "remove" | "pin"): Promise<void> {
    const records = (this.#records.get(scope) ?? []).flatMap((r) => {
      if (!subscriptions.some((s) => sameSubscription(scope, r, s))) return [r];
      if (action === "pin") return [{ ...r, pinned: true }];
      return r.pinned ? [r] : [];
    });
    return this.#write(scope, records, "immediately");
  }

  clear(scope: string, action: "remove" | "keep-hints"): Promise<void> {
    const records =
      action === "keep-hints" ? (this.#records.get(scope) ?? []).map((r) => ({ ...r, eligible: false })) : [];
    return this.#write(scope, records, "immediately");
  }

  scopes<Item extends CookieItem>(event: CookieChange<Item>): Set<string> {
    const scopes = new Set<string>();
    for (const [scope, records] of this.#records) {
      const coarseMatch = (item: Item) => records.some((r) => matches(r, item));
      if (event.changed.some(coarseMatch) || event.deleted.some(coarseMatch)) scopes.add(scope);
    }
    return scopes;
  }

  eligibleItems<Item extends CookieItem>(scope: string, event: CookieChange<Item>) {
    const records = (this.#records.get(scope) ?? []).filter((r) => r.eligible && r.since < event.time);
    const eligible = (item: Item) => records.some((r) => matches(r, item));
    return { changed: event.changed.filter(eligible), deleted: event.deleted.filter(eligible) };
  }
}
