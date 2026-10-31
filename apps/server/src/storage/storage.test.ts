import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { AzureBlobStore } from "./azure";
import { FileStore } from "./file";
import { Conflict, MAX_DOCUMENT_BYTES } from "./store";
afterEach(() => vi.restoreAllMocks());
it("uses Azure create-only, ETag conditional updates/deletes and single-upload writes against an existing container", async () => {
  const upload = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue({});
  const download = vi.fn().mockImplementation(async () => ({
    etag: "etag-1",
    readableStreamBody: Readable.from([Buffer.from('{"revision":1}')]),
  }));
  const container = {
    getBlockBlobClient: () => ({ upload }),
    getBlobClient: () => ({ delete: remove, download }),
    async *listBlobsFlat() {
      yield { name: "rooms/a.json" };
    },
  };
  vi.spyOn(BlobServiceClient.prototype, "getContainerClient").mockReturnValue(
    container as unknown as ContainerClient,
  );
  const store = new AzureBlobStore(
    "https://synthetic.blob.core.windows.net",
    "test",
  );
  await store.write("rooms/a.json", { revision: 1 }, null);
  expect(upload.mock.calls[0]![2]).toMatchObject({
    conditions: { ifNoneMatch: "*" },
  });
  await store.write("rooms/a.json", { revision: 2 }, "etag-1");
  expect(upload.mock.calls[1]![2]).toMatchObject({
    conditions: { ifMatch: "etag-1" },
  });
  expect(await store.read("rooms/a.json")).toEqual({
    etag: "etag-1",
    value: { revision: 1 },
  });
  await store.delete("rooms/a.json", "etag-1");
  expect(remove).toHaveBeenCalledWith({ conditions: { ifMatch: "etag-1" } });
  expect(await store.list("rooms/")).toEqual(["rooms/a.json"]);
  await expect(
    store.write("rooms/a.json", "x".repeat(MAX_DOCUMENT_BYTES), null),
  ).rejects.toThrow("DOCUMENT_TOO_LARGE");
  expect(
    () => new AzureBlobStore("http://synthetic.invalid", "test"),
  ).toThrow();
});
it("treats Azure 404 as absent, propagates unavailable storage and rejects malformed persisted JSON", async () => {
  const download = vi.fn().mockRejectedValue({ statusCode: 404 });
  vi.spyOn(BlobServiceClient.prototype, "getContainerClient").mockReturnValue({
    getBlobClient: () => ({ download }),
  } as unknown as ContainerClient);
  const store = new AzureBlobStore(
    "https://synthetic.blob.core.windows.net",
    "test",
  );
  expect(await store.read("rooms/a.json")).toBeNull();
  download.mockRejectedValue(new Error("offline"));
  await expect(store.read("rooms/a.json")).rejects.toThrow("offline");
  download.mockResolvedValue({
    etag: "e",
    readableStreamBody: Readable.from([Buffer.from("invalid")]),
  });
  await expect(store.read("rooms/a.json")).rejects.toThrow();
});
it("persists private local documents atomically and rejects conflicting writers and path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "guineakub-store-"));
  try {
    const store = new FileStore(root);
    await store.write("rooms/a.json", { revision: 0 }, null);
    const doc = await store.read("rooms/a.json");
    const writes = await Promise.allSettled(
      [1, 2].map((revision) =>
        store.write("rooms/a.json", { revision }, doc!.etag),
      ),
    );
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" && rejected.reason instanceof Conflict,
    ).toBe(true);
    expect((await new FileStore(root).read("rooms/a.json"))?.value).not.toEqual(
      { revision: 0 },
    );
    await expect(store.read("../escape.json")).rejects.toThrow(
      "INVALID_STORAGE_KEY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
