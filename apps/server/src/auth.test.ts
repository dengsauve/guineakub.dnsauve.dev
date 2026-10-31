import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { AuthService, googleVerifier } from "./auth";
import { MemoryStore } from "./storage/store";
afterEach(() => vi.restoreAllMocks());
it("cryptographically verifies Google signatures, audience, issuer, expiry and nonce with local test certificates", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  type CertResult = Awaited<
    ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>
  >;
  vi.spyOn(
    OAuth2Client.prototype,
    "getFederatedSignonCertsAsync",
  ).mockResolvedValue({
    certs: {
      test: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    format: "PEM" as CertResult["format"],
  });
  const now = Math.floor(Date.now() / 1000);
  function token(overrides = {}, corrupt = false) {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: "client",
        sub: "synthetic-owner",
        name: "Synthetic Owner",
        exp: now + 3600,
        iat: now,
        nonce: "nonce",
        ...overrides,
      }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), pair.privateKey);
    if (corrupt) signature[0] = signature[0]! ^ 0xff;
    return `${data}.${signature.toString("base64url")}`;
  }
  const verify = googleVerifier("client");
  await expect(verify(token(), "nonce")).resolves.toEqual({
    sub: "synthetic-owner",
    name: "Synthetic Owner",
  });
  for (const claims of [
    { aud: "other" },
    { iss: "https://evil.invalid" },
    { exp: now - 1 },
    { nonce: "wrong" },
  ])
    await expect(verify(token(claims), "nonce")).rejects.toThrow();
  await expect(verify(token({}, true), "nonce")).rejects.toThrow();
});
it("keeps first sign-in pending, only bootstraps the configured owner, persists approval/sessions and revokes logout", async () => {
  let now = Date.now();
  const store = new MemoryStore();
  const verify = async (sub: string) => ({ sub, name: "Synthetic user" });
  const auth = new AuthService(store, verify, "owner", () => now);
  const firstChallenge = auth.challenge();
  const first = await auth.login(firstChallenge.key, "stranger");
  expect(first.actor).toMatchObject({ approved: false, admin: false });
  await expect(auth.login(firstChallenge.key, "stranger")).rejects.toThrow(
    "INVALID_LOGIN_CHALLENGE",
  );
  const owner = await auth.login(auth.challenge().key, "owner");
  expect(owner.actor).toMatchObject({ approved: true, admin: true });
  await expect(auth.approve(first.actor, first.actor.uid)).rejects.toThrow(
    "FORBIDDEN",
  );
  await auth.approve(owner.actor, first.actor.uid);
  expect((await auth.authenticate(first.token)).approved).toBe(true);
  const restarted = new AuthService(store, verify, "owner", () => now);
  expect((await restarted.authenticate(first.token)).uid).toBe(first.actor.uid);
  const sessions = await store.list("sessions/");
  expect(sessions.some((key) => key.includes(first.token))).toBe(false);
  await restarted.logout(first.token);
  await expect(restarted.authenticate(first.token)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  now += 12 * 3600_000;
  await expect(restarted.authenticate(owner.token)).rejects.toThrow(
    "SESSION_EXPIRED",
  );
  await restarted.cleanup();
  expect(await store.list("sessions/")).toHaveLength(0);
});
it("rejects expired login challenges and retains the verified subject instead of a display name for approval", async () => {
  let now = Date.now();
  const auth = new AuthService(
    new MemoryStore(),
    async (sub) => ({ sub, name: "Identical display name" }),
    "owner",
    () => now,
  );
  const challenge = auth.challenge();
  now += 300_001;
  await expect(auth.login(challenge.key, "owner")).rejects.toThrow();
  const owner = await auth.login(auth.challenge().key, "owner");
  const other = await auth.login(auth.challenge().key, "different-sub");
  expect(owner.actor.admin).toBe(true);
  expect(other.actor.admin).toBe(false);
});
