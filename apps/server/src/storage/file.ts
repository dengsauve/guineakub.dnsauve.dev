import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Conflict,
  KeyedQueue,
  MAX_DOCUMENT_BYTES,
  encodeDocument,
  type DocumentStore,
  type StoredDocument,
} from "./store";
/** Single-process development store only; never use container disk in production. */
export class FileStore implements DocumentStore {
  private readonly queue = new KeyedQueue();
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9/_-]+\.json$/.test(key) || key.includes(".."))
      throw new Error("INVALID_STORAGE_KEY");
    return join(this.root, Buffer.from(key).toString("base64url") + ".json");
  }
  async read(key: string): Promise<StoredDocument | null> {
    try {
      const data = await readFile(this.path(key));
      if (data.length > MAX_DOCUMENT_BYTES + 1024)
        throw new Error("DOCUMENT_TOO_LARGE");
      const parsed: unknown = JSON.parse(data.toString());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("etag" in parsed) ||
        typeof parsed.etag !== "string" ||
        !("value" in parsed)
      )
        throw new Error("CORRUPT_STORAGE");
      return { etag: parsed.etag, value: parsed.value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async write(key: string, value: unknown, expected: string | null) {
    return this.queue.run("files", async () => {
      const current = await this.read(key);
      if ((current?.etag ?? null) !== expected) throw new Conflict();
      encodeDocument(value);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, randomUUID() + ".tmp");
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ etag: randomUUID(), value }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.path(key));
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  }
  async delete(key: string, expected: string) {
    return this.queue.run("files", async () => {
      if ((await this.read(key))?.etag !== expected) throw new Conflict();
      await unlink(this.path(key));
    });
  }
  async list(prefix: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return (await readdir(this.root))
      .filter((name) => name.endsWith(".json"))
      .map((name) => Buffer.from(name.slice(0, -5), "base64url").toString())
      .filter((key) => key.startsWith(prefix));
  }
}
