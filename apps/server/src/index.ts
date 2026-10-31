import { createApplication } from "./app";
import { googleVerifier } from "./auth";
import { FileStore } from "./storage/file";
import { AzureBlobStore } from "./storage/azure";
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const origins = (
  process.env.ALLOWED_ORIGINS ??
  (production ? "" : "http://localhost:5173,http://127.0.0.1:5173")
)
  .split(",")
  .filter(Boolean);
for (const origin of origins) {
  const url = new URL(origin);
  if (url.origin !== origin || (production && url.protocol !== "https:"))
    throw new Error("Invalid ALLOWED_ORIGINS");
}
if (!origins.length) throw new Error("ALLOWED_ORIGINS is required");
if (
  production &&
  (!process.env.AZURE_STORAGE_ACCOUNT_URL ||
    !process.env.AZURE_STORAGE_CONTAINER ||
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.ADMIN_GOOGLE_SUB)
)
  throw new Error("Production configuration is incomplete");
const store = process.env.AZURE_STORAGE_ACCOUNT_URL
  ? new AzureBlobStore(
      process.env.AZURE_STORAGE_ACCOUNT_URL,
      process.env.AZURE_STORAGE_CONTAINER || "guineakub",
    )
  : new FileStore(process.env.SERVER_DATA_DIR ?? ".local-data");
try {
  const application = await createApplication({
    store,
    allowedOrigins: origins,
    secureCookies: production,
    ...(process.env.GOOGLE_CLIENT_ID && process.env.ADMIN_GOOGLE_SUB
      ? {
          verifyGoogle: googleVerifier(process.env.GOOGLE_CLIENT_ID),
          ownerSub: process.env.ADMIN_GOOGLE_SUB,
        }
      : {}),
    log: (event) => console.error(JSON.stringify(event)),
  });
  application.server.on("error", () => {
    console.error(JSON.stringify({ event: "listen_failed" }));
    process.exitCode = 1;
    void application.close().catch(() => undefined);
  });
  application.server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () =>
    console.log(JSON.stringify({ event: "server_listening", port })),
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void application.close().catch(() => {
        console.error(JSON.stringify({ event: "shutdown_failed" }));
        process.exitCode = 1;
      });
    });
} catch {
  console.error(
    JSON.stringify({ event: "startup_failed", code: "SERVICE_UNAVAILABLE" }),
  );
  process.exitCode = 1;
}
