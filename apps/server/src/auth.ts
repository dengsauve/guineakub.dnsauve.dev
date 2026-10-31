import { randomBytes, randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import {
  commit,
  digest,
  KeyedQueue,
  type DocumentStore,
} from "./storage/store";
import { ensure, ServiceError } from "./errors";
export interface GoogleIdentity {
  sub: string;
  name: string;
}
export type VerifyGoogle = (
  credential: string,
  nonce: string,
) => Promise<GoogleIdentity>;
export function googleVerifier(audience: string): VerifyGoogle {
  const client = new OAuth2Client(audience);
  return async (credential, nonce) => {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience,
    });
    const payload = ticket.getPayload();
    ensure(
      payload &&
        ["accounts.google.com", "https://accounts.google.com"].includes(
          payload.iss,
        ) &&
        payload.aud === audience &&
        payload.exp * 1000 > Date.now() &&
        payload.nonce === nonce &&
        payload.sub,
      "INVALID_GOOGLE_TOKEN",
      401,
    );
    return {
      sub: payload.sub,
      name: (payload.name || "Family member").slice(0, 80),
    };
  };
}
const accountSchema = z.strictObject({
  uid: z.string().uuid(),
  sub: z.string().min(1).max(255),
  name: z.string().min(1).max(80),
  approved: z.boolean(),
});
const directorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  accounts: z.array(accountSchema).max(256),
});
const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  uid: z.string().uuid(),
  expiresAt: z.number().int().positive(),
});
type Account = z.infer<typeof accountSchema>;
function parseDirectory(value: unknown) {
  const directory = directorySchema.parse(value);
  ensure(
    new Set(directory.accounts.map((account) => account.uid)).size ===
      directory.accounts.length &&
      new Set(directory.accounts.map((account) => account.sub)).size ===
        directory.accounts.length,
    "CORRUPT_DIRECTORY",
    503,
  );
  return directory;
}
export interface Actor {
  uid: string;
  name: string;
  approved: boolean;
  admin: boolean;
  expiresAt: number;
}
export class AuthService {
  private readonly queue = new KeyedQueue();
  private readonly challenges = new Map<
    string,
    { nonce: string; expiresAt: number }
  >();
  constructor(
    private readonly store: DocumentStore,
    private readonly verify: VerifyGoogle,
    private readonly ownerSub: string,
    private readonly now = Date.now,
  ) {
    ensure(ownerSub.length > 0, "ADMIN_GOOGLE_SUB_REQUIRED", 503);
  }
  challenge() {
    for (const [key, value] of this.challenges)
      if (value.expiresAt <= this.now()) this.challenges.delete(key);
    ensure(this.challenges.size < 1000, "RATE_LIMITED", 429);
    const key = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    this.challenges.set(digest(key), {
      nonce,
      expiresAt: this.now() + 5 * 60_000,
    });
    return { key, nonce };
  }
  async login(challengeKey: string, credential: string) {
    const key = digest(challengeKey);
    const challenge = this.challenges.get(key);
    this.challenges.delete(key);
    ensure(
      challenge && challenge.expiresAt > this.now(),
      "INVALID_LOGIN_CHALLENGE",
      401,
    );
    let identity: GoogleIdentity;
    try {
      identity = await this.verify(credential, challenge.nonce);
    } catch {
      throw new ServiceError("INVALID_GOOGLE_TOKEN", 401);
    }
    ensure(
      identity.sub.length > 0 && identity.sub.length <= 255,
      "INVALID_GOOGLE_TOKEN",
      401,
    );
    const account = await this.queue.run("directory", async () => {
      const document = await this.store.read("accounts/family.json");
      const directory = document
        ? parseDirectory(document.value)
        : { schemaVersion: 1 as const, accounts: [] as Account[] };
      let account = directory.accounts.find(
        (account) => account.sub === identity.sub,
      );
      if (!account) {
        ensure(directory.accounts.length < 256, "ENROLLMENT_FULL", 503);
        account = {
          uid: randomUUID(),
          sub: identity.sub,
          name: identity.name.trim().slice(0, 80) || "Family member",
          approved: identity.sub === this.ownerSub,
        };
        directory.accounts.push(account);
      } else {
        account.name = identity.name.trim().slice(0, 80) || "Family member";
      }
      await commit(
        this.store,
        "accounts/family.json",
        directory,
        document?.etag ?? null,
      );
      return account;
    });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + 12 * 60 * 60_000;
    await commit(
      this.store,
      `sessions/${digest(token)}.json`,
      { schemaVersion: 1, uid: account.uid, expiresAt },
      null,
    );
    return { token, actor: this.actor(account, expiresAt) };
  }
  private actor(account: Account, expiresAt: number): Actor {
    return {
      uid: account.uid,
      name: account.name,
      approved: account.approved || account.sub === this.ownerSub,
      admin: account.sub === this.ownerSub,
      expiresAt,
    };
  }
  async authenticate(token: string): Promise<Actor> {
    ensure(/^[A-Za-z0-9_-]{43}$/.test(token), "UNAUTHENTICATED", 401);
    const document = await this.store.read(`sessions/${digest(token)}.json`);
    ensure(document, "UNAUTHENTICATED", 401);
    const session = sessionSchema.parse(document.value);
    ensure(session.expiresAt > this.now(), "SESSION_EXPIRED", 401);
    const directory = await this.store.read("accounts/family.json");
    ensure(directory, "UNAUTHENTICATED", 401);
    const account = parseDirectory(directory.value).accounts.find(
      (account) => account.uid === session.uid,
    );
    ensure(account, "UNAUTHENTICATED", 401);
    return this.actor(account, session.expiresAt);
  }
  async logout(token: string) {
    const key = `sessions/${digest(token)}.json`;
    const document = await this.store.read(key);
    if (document) await this.store.delete(key, document.etag);
  }
  async listAccounts(actor: Actor) {
    ensure(actor.admin, "FORBIDDEN", 403);
    const directory = await this.store.read("accounts/family.json");
    return parseDirectory(directory?.value).accounts.map((account) => ({
      uid: account.uid,
      name: account.name,
      approved: account.approved || account.sub === this.ownerSub,
    }));
  }
  async approve(actor: Actor, uid: string) {
    ensure(actor.admin, "FORBIDDEN", 403);
    await this.queue.run("directory", async () => {
      const document = await this.store.read("accounts/family.json");
      ensure(document, "NOT_FOUND", 404);
      const directory = parseDirectory(document.value);
      const account = directory.accounts.find((account) => account.uid === uid);
      ensure(account, "NOT_FOUND", 404);
      account.approved = true;
      await commit(
        this.store,
        "accounts/family.json",
        directory,
        document.etag,
      );
    });
  }
  async cleanup() {
    for (const key of await this.store.list("sessions/")) {
      const document = await this.store.read(key);
      if (
        document &&
        sessionSchema.parse(document.value).expiresAt <= this.now()
      )
        await this.store.delete(key, document.etag);
    }
  }
}
