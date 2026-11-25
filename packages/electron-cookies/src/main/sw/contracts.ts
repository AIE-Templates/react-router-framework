import type { Subscription } from "../../shared.ts";
export type { Subscription, SubscriptionOperation as Operation } from "../../shared.ts";

export interface WakeRecord extends Subscription {
  readonly scope: string;
  readonly since: number;
  readonly pinned?: boolean;
  readonly eligible: boolean;
}

export interface WakeStorage {
  read(): readonly WakeRecord[];
  write(records: readonly WakeRecord[]): Promise<void>;
}

export interface Scheduler {
  now(): number;
  /** Returns a function that cancels this one-shot timer. */
  after(ms: number, callback: () => void): () => void;
}

export interface WakeLogger {
  warn(fields: { scope: string; operationId?: string; eventId?: string }, message: string): void;
}

/** Numeric IDs are worker version IDs. Frames use a document-lifetime string ID. */
export type OwnerId = string | number;

export interface CookieItem {
  readonly name: string;
  readonly path: string;
}

export interface ChangeItems<Item extends CookieItem> {
  readonly changed: readonly Item[];
  readonly deleted: readonly Item[];
}

export interface CookieChange<Item extends CookieItem> extends ChangeItems<Item> {
  /** Uses the same persistent time base as Scheduler.now(). */
  readonly time: number;
}

export interface EventRef {
  readonly versionId: number;
  readonly eventId: string;
}

export interface WorkerPort<Item extends CookieItem> {
  readonly versionId: number;
  readonly scope: string;
  startTask(): { end(): void };
  /** Worker checks active identity and native subscriptions, then reports started, nack or ack. */
  send(event: ChangeItems<Item> & { eventId: string }): void;
  finish(eventId: string): void;
}

export interface NativePort<Item extends CookieItem> {
  /** null is a definitive missing registration. Reject for transient wake failures. */
  startWorkerForScope(scope: string): Promise<WorkerPort<Item> | null>;
}

export interface CookieWorkerOptions<Item extends CookieItem> {
  storage: WakeStorage;
  scheduler: Scheduler;
  taskTimeoutMs?: number;
  logger: WakeLogger;
  native: NativePort<Item>;
}
