import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import {
  MAX_DOCUMENT_BYTES,
  encodeDocument,
  type DocumentStore,
} from "./store";
/** Uses an existing container. This adapter does not provision any resources. */
export class AzureBlobStore implements DocumentStore {
  private readonly container: ContainerClient;
  constructor(accountUrl: string, container: string) {
    const url = new URL(accountUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("INVALID_STORAGE_URL");
    this.container = new BlobServiceClient(
      accountUrl,
      new DefaultAzureCredential(),
    ).getContainerClient(container);
  }
  async read(key: string) {
    try {
      const response = await this.container.getBlobClient(key).download();
      const stream = response.readableStreamBody;
      if (!stream || !response.etag)
        throw new Error("INVALID_STORAGE_RESPONSE");
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_DOCUMENT_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
        chunks.push(bytes);
      }
      return {
        value: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        etag: response.etag,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
  async write(key: string, value: unknown, expected: string | null) {
    const bytes = encodeDocument(value);
    await this.container.getBlockBlobClient(key).upload(bytes, bytes.length, {
      conditions:
        expected === null ? { ifNoneMatch: "*" } : { ifMatch: expected },
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }
  async delete(key: string, expected: string) {
    await this.container
      .getBlobClient(key)
      .delete({ conditions: { ifMatch: expected } });
  }
  async list(prefix: string) {
    const keys: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix }))
      keys.push(blob.name);
    return keys;
  }
}
