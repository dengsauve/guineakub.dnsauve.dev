import { createHash, randomUUID } from "node:crypto";
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export interface StoredDocument {
  value: unknown;
  etag: string;
}
export interface DocumentStore {
  read(key: string): Promise<StoredDocument | null>;
  write(key: string, value: unknown, expected: string | null): Promise<void>;
  delete(key: string, expected: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export class Conflict extends Error {}
export function encodeDocument(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
  return bytes;
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class KeyedQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
}
/** Resolve an ambiguous successful write by reading it back before acknowledging. */
export async function commit(
  store: DocumentStore,
  key: string,
  value: unknown,
  expected: string | null,
): Promise<void> {
  encodeDocument(value);
  try {
    await store.write(key, value, expected);
  } catch (error) {
    const actual = await store.read(key);
    if (
      actual &&
      digest(JSON.stringify(actual.value)) === digest(JSON.stringify(value))
    )
      return;
    throw error;
  }
}
/** For injected tests only. The executable never selects an in-memory store. */
export class MemoryStore implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();
  async read(key: string) {
    return structuredClone(this.documents.get(key) ?? null);
  }
  async write(key: string, value: unknown, expected: string | null) {
    if ((this.documents.get(key)?.etag ?? null) !== expected)
      throw new Conflict();
    encodeDocument(value);
    this.documents.set(key, {
      etag: randomUUID(),
      value: structuredClone(value),
    });
  }
  async delete(key: string, expected: string) {
    if (this.documents.get(key)?.etag !== expected) throw new Conflict();
    this.documents.delete(key);
  }
  async list(prefix: string) {
    return [...this.documents.keys()].filter((key) => key.startsWith(prefix));
  }
}
