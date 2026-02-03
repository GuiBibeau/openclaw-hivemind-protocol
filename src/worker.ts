import { buildJoinMessage, PROTOCOL_VERSION } from "./protocol";
import { isValidSolanaPublicKey, verifyEd25519Base64, verifyMessage } from "./crypto";

export interface Env {
  HIVEMIND: DurableObjectNamespace;
  HIVE_ID?: string;
  HIVEMIND_GOSSIP_TOKEN?: string;
  HIVEMIND_GOSSIP_INTERVAL_MS?: string;
  HIVEMIND_PEERS?: string;
  OPENCLAW_DEVICE_PROOF_REQUIRED?: string;
  OPENCLAW_DEVICE_PROOF_TTL_MS?: string;
}

const DEFAULT_HIVE_ID = "openclaw-devnet";

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function ok(data: unknown) {
  return json(200, data);
}

function parseAuthToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

async function readBodyText(request: Request): Promise<string | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  try {
    return await request.text();
  } catch {
    return null;
  }
}

function parseHiveFromToken(token: string | null, fallback: string): string {
  if (!token) return fallback;
  const parts = token.split(".");
  if (parts.length < 2) return fallback;
  return parts[0] || fallback;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hiveFallback = env.HIVE_ID ?? DEFAULT_HIVE_ID;

    if (request.method === "GET" && url.pathname === "/health") {
      return ok({ status: "ok", protocol: PROTOCOL_VERSION, hive_id: hiveFallback });
    }

    if (request.method === "GET" && url.pathname === "/protocol") {
      return ok({
        protocol_version: PROTOCOL_VERSION,
        hive_id: hiveFallback,
        challenge_ttl_ms: 2 * 60 * 1000,
        session_ttl_ms: 24 * 60 * 60 * 1000,
        max_clock_skew_ms: 2 * 60 * 1000
      });
    }

    let hiveId = hiveFallback;
    let bodyText: string | null = null;

    if (request.method === "POST" && ["/challenge", "/join", "/gossip/push"].includes(url.pathname)) {
      bodyText = await readBodyText(request);
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText) as { hive_id?: string };
          hiveId = parsed.hive_id ?? hiveId;
        } catch {
          // Ignore malformed JSON; DO will validate.
        }
      }
    } else if (url.pathname === "/gossip/messages") {
      hiveId = url.searchParams.get("hive_id") ?? hiveId;
    } else if (url.pathname === "/message" || url.pathname === "/messages") {
      hiveId = parseHiveFromToken(parseAuthToken(request), hiveId);
    }

    const doId = env.HIVEMIND.idFromName(hiveId);
    const stub = env.HIVEMIND.get(doId);
    const headers = new Headers(request.headers);
    headers.set("x-hive-id", hiveId);

    const forwardRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: bodyText ?? (request.method === "GET" || request.method === "HEAD" ? undefined : request.body)
    });

    return stub.fetch(forwardRequest);
  }
};

type Challenge = {
  agentId: string;
  pubkey: string;
  nonce: string;
  hiveId: string;
  expiresAt: string;
};

type Session = {
  agentId: string;
  pubkey: string;
  hiveId: string;
  expiresAt: number;
};

type HiveMessage = {
  id: number;
  uid: string;
  ts: string;
  createdAtMs: number;
  agentId: string;
  hiveId: string;
  content: string;
  channel: string;
  source: "local" | "gossip";
};

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MESSAGE_KEY_WIDTH = 12;
const MAX_MESSAGES_LIMIT = 200;
const MAX_GOSSIP_BATCH = 500;

function messageKey(id: number) {
  return `msg:${String(id).padStart(MESSAGE_KEY_WIDTH, "0")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function badRequest(message: string) {
  return json(400, { error: message });
}

function unauthorized(message: string) {
  return json(401, { error: message });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function parseAuthTokenStrict(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

export class HivemindHive {
  private state: DurableObjectState;
  private env: Env;
  private hiveId: string;
  private gossipPeers: string[];
  private gossipToken: string;
  private gossipIntervalMs: number;
  private deviceProofRequired: boolean;
  private deviceProofTtlMs: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.hiveId = env.HIVE_ID ?? DEFAULT_HIVE_ID;
    this.gossipPeers = (env.HIVEMIND_PEERS ?? "")
      .split(",")
      .map((peer) => peer.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    this.gossipToken = env.HIVEMIND_GOSSIP_TOKEN ?? "";
    this.gossipIntervalMs = Number(env.HIVEMIND_GOSSIP_INTERVAL_MS ?? 5000);
    this.deviceProofRequired = (env.OPENCLAW_DEVICE_PROOF_REQUIRED ?? "false").toLowerCase() === "true";
    this.deviceProofTtlMs = Number(env.OPENCLAW_DEVICE_PROOF_TTL_MS ?? 5 * 60 * 1000);
  }

  private async ensureAlarm() {
    if (this.gossipPeers.length === 0) return;
    const next = Date.now() + Math.max(1000, this.gossipIntervalMs);
    await this.state.storage.setAlarm(next);
  }

  private authorizeGossip(request: Request): boolean {
    if (!this.gossipToken) return true;
    const token = request.headers.get("x-hivemind-gossip");
    return token === this.gossipToken;
  }

  private async requireSession(request: Request): Promise<Session | null> {
    const token = parseAuthTokenStrict(request);
    if (!token) return null;
    const session = await this.state.storage.get<Session>(`session:${token}`);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      await this.state.storage.delete(`session:${token}`);
      return null;
    }
    return session;
  }

  private async cleanupChallenges() {
    const now = Date.now();
    const list = await this.state.storage.list<Challenge>({ prefix: "challenge:" });
    const expired: string[] = [];
    for (const [key, challenge] of list) {
      if (Date.parse(challenge.expiresAt) <= now) {
        expired.push(key);
      }
    }
    if (expired.length > 0) {
      await this.state.storage.delete(expired);
    }
  }

  private async nextMessageId(): Promise<number> {
    const key = "meta:nextMessageId";
    const current = (await this.state.storage.get<number>(key)) ?? 1;
    await this.state.storage.put(key, current + 1);
    return current;
  }

  private async storeMessage(input: Omit<HiveMessage, "id">): Promise<HiveMessage | null> {
    const uidKey = `uid:${input.uid}`;
    const existing = await this.state.storage.get(uidKey);
    if (existing) return null;

    const id = await this.nextMessageId();
    const message: HiveMessage = { id, ...input };
    await this.state.storage.put({
      [messageKey(id)]: message,
      [uidKey]: id
    });
    return message;
  }

  private verifyOpenClawDeviceProof(input: {
    devicePublicKey: string;
    deviceSignature: string;
    deviceNonce: string;
    deviceSignedAt: string;
  }): boolean {
    const signedAtMs = Date.parse(input.deviceSignedAt);
    if (Number.isNaN(signedAtMs)) return false;
    if (Math.abs(Date.now() - signedAtMs) > this.deviceProofTtlMs) return false;
    return verifyEd25519Base64(input.deviceNonce, input.deviceSignature, input.devicePublicKey);
  }

  private async pollPeers() {
    if (this.gossipPeers.length === 0) return;

    for (const peer of this.gossipPeers) {
      const cursorKey = `peer:${peer}:cursor`;
      const sinceMs = (await this.state.storage.get<number>(cursorKey)) ?? 0;
      const url = new URL(`${peer}/gossip/messages`);
      url.searchParams.set("since_ms", String(sinceMs));
      url.searchParams.set("hive_id", this.hiveId);

      try {
        const res = await fetch(url.toString(), {
          headers: this.gossipToken ? { "x-hivemind-gossip": this.gossipToken } : undefined
        });
        if (!res.ok) continue;
        const payload = (await res.json()) as { messages?: HiveMessage[] };
        const incoming = Array.isArray(payload.messages) ? payload.messages : [];
        let maxSeen = sinceMs;

        for (const msg of incoming) {
          if (!msg || msg.hiveId !== this.hiveId || !msg.uid) continue;
          const createdAtMs = Number(msg.createdAtMs);
          const ts = msg.ts ?? new Date(createdAtMs || Date.now()).toISOString();
          const stored = await this.storeMessage({
            uid: msg.uid,
            ts,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.parse(ts),
            agentId: msg.agentId,
            hiveId: msg.hiveId,
            content: msg.content,
            channel: msg.channel ?? "default",
            source: "gossip"
          });

          if (stored) {
            const created = stored.createdAtMs;
            if (Number.isFinite(created)) {
              maxSeen = Math.max(maxSeen, created);
            }
          }
        }

        if (maxSeen > sinceMs) {
          await this.state.storage.put(cursorKey, maxSeen);
        }
      } catch {
        // Ignore peer errors.
      }
    }
  }

  async alarm() {
    await this.pollPeers();
    await this.ensureAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hiveHeader = request.headers.get("x-hive-id");
    if (hiveHeader) this.hiveId = hiveHeader;

    if (request.method === "POST" && url.pathname === "/challenge") {
      const body = await readJson<{ agent_id?: string; pubkey?: string; hive_id?: string }>(request);
      if (!body?.agent_id || !body?.pubkey) {
        return badRequest("agent_id and pubkey are required");
      }

      if (!isValidSolanaPublicKey(body.pubkey)) {
        return badRequest("pubkey is not a valid Solana public key");
      }

      await this.cleanupChallenges();

      const nonce = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      const hiveId = body.hive_id ?? this.hiveId;

      const challenge: Challenge = {
        agentId: body.agent_id,
        pubkey: body.pubkey,
        nonce,
        hiveId,
        expiresAt
      };

      await this.state.storage.put(`challenge:${nonce}`, challenge);

      await this.ensureAlarm();
      return ok({
        protocol_version: PROTOCOL_VERSION,
        nonce,
        hive_id: hiveId,
        expires_at: expiresAt
      });
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const body = await readJson<{
        agent_id?: string;
        pubkey?: string;
        nonce?: string;
        signature?: string;
        timestamp?: string;
        hive_id?: string;
        expires_at?: string;
        openclaw_device_public_key?: string;
        openclaw_device_signature?: string;
        openclaw_device_nonce?: string;
        openclaw_device_signed_at?: string;
      }>(request);

      if (!body?.agent_id || !body?.pubkey || !body?.nonce || !body?.signature || !body?.timestamp) {
        return badRequest("agent_id, pubkey, nonce, signature, timestamp are required");
      }

      const challenge = await this.state.storage.get<Challenge>(`challenge:${body.nonce}`);
      if (!challenge) return unauthorized("challenge not found or expired");

      if (challenge.agentId !== body.agent_id || challenge.pubkey !== body.pubkey) {
        return unauthorized("challenge does not match agent_id or pubkey");
      }

      if (challenge.hiveId !== (body.hive_id ?? challenge.hiveId)) {
        return unauthorized("hive_id mismatch");
      }

      if (challenge.expiresAt !== (body.expires_at ?? challenge.expiresAt)) {
        return unauthorized("expires_at mismatch");
      }

      const challengeExpiry = Date.parse(challenge.expiresAt);
      if (Number.isNaN(challengeExpiry) || challengeExpiry < Date.now()) {
        await this.state.storage.delete(`challenge:${body.nonce}`);
        return unauthorized("challenge expired");
      }

      const timestampMs = Date.parse(body.timestamp);
      if (Number.isNaN(timestampMs)) {
        return badRequest("timestamp must be an ISO string");
      }

      if (Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
        return unauthorized("timestamp outside allowed clock skew");
      }

      const deviceFieldsProvided = Boolean(
        body.openclaw_device_public_key ||
          body.openclaw_device_signature ||
          body.openclaw_device_nonce ||
          body.openclaw_device_signed_at
      );

      if (this.deviceProofRequired || deviceFieldsProvided) {
        if (
          !body.openclaw_device_public_key ||
          !body.openclaw_device_signature ||
          !body.openclaw_device_nonce ||
          !body.openclaw_device_signed_at
        ) {
          return unauthorized("missing OpenClaw device proof fields");
        }

        const proofOk = this.verifyOpenClawDeviceProof({
          devicePublicKey: body.openclaw_device_public_key,
          deviceSignature: body.openclaw_device_signature,
          deviceNonce: body.openclaw_device_nonce,
          deviceSignedAt: body.openclaw_device_signed_at
        });
        if (!proofOk) return unauthorized("invalid OpenClaw device proof");
      }

      const message = buildJoinMessage({
        agentId: challenge.agentId,
        pubkey: challenge.pubkey,
        nonce: challenge.nonce,
        hiveId: challenge.hiveId,
        challengeExpiresAt: challenge.expiresAt,
        timestamp: body.timestamp
      });

      const valid = verifyMessage(message, body.signature, challenge.pubkey);
      if (!valid) return unauthorized("invalid signature");

      await this.state.storage.delete(`challenge:${body.nonce}`);

      const token = `${challenge.hiveId}.${crypto.randomUUID()}`;
      const session: Session = {
        agentId: challenge.agentId,
        pubkey: challenge.pubkey,
        hiveId: challenge.hiveId,
        expiresAt: Date.now() + SESSION_TTL_MS
      };

      await this.state.storage.put(`session:${token}`, session);

      await this.ensureAlarm();
      return ok({
        session_token: token,
        expires_at: new Date(session.expiresAt).toISOString(),
        agent_id: session.agentId,
        hive_id: session.hiveId
      });
    }

    if (request.method === "POST" && url.pathname === "/message") {
      const session = await this.requireSession(request);
      if (!session) return unauthorized("missing or expired session");

      const body = await readJson<{ content?: string; channel?: string }>(request);
      if (!body?.content) return badRequest("content is required");

      const createdAtMs = Date.now();
      const message = await this.storeMessage({
        uid: crypto.randomUUID(),
        ts: new Date(createdAtMs).toISOString(),
        createdAtMs,
        agentId: session.agentId,
        hiveId: session.hiveId,
        content: body.content,
        channel: body.channel ?? "default",
        source: "local"
      });

      if (!message) return json(500, { error: "failed to store message" });

      await this.ensureAlarm();
      return ok({ accepted: true, message });
    }

    if (request.method === "GET" && url.pathname === "/messages") {
      const session = await this.requireSession(request);
      if (!session) return unauthorized("missing or expired session");

      const sinceParam = url.searchParams.get("since") ?? "0";
      const limitParam = url.searchParams.get("limit") ?? "50";
      const since = Number(sinceParam);
      const limit = Math.min(MAX_MESSAGES_LIMIT, Math.max(1, Number(limitParam)));

      const list = await this.state.storage.list<HiveMessage>({
        prefix: "msg:",
        limit,
        reverse: true
      });

      const messages: HiveMessage[] = [];
      for (const [, msg] of list) {
        if (msg.id > (Number.isNaN(since) ? 0 : since)) {
          messages.push(msg);
        }
      }
      messages.reverse();

      return ok({
        hive_id: session.hiveId,
        messages
      });
    }

    if (url.pathname.startsWith("/gossip")) {
      if (!this.authorizeGossip(request)) return unauthorized("invalid gossip token");

      if (request.method === "GET" && url.pathname === "/gossip/messages") {
        const sinceParam = url.searchParams.get("since_ms") ?? "0";
        const limitParam = url.searchParams.get("limit") ?? String(MAX_GOSSIP_BATCH);
        const sinceMs = Number(sinceParam);
        const limit = Math.min(MAX_GOSSIP_BATCH, Math.max(1, Number(limitParam)));

        const list = await this.state.storage.list<HiveMessage>({ prefix: "msg:", limit, reverse: true });
        const messages: HiveMessage[] = [];
        for (const [, msg] of list) {
          if (msg.createdAtMs >= (Number.isNaN(sinceMs) ? 0 : sinceMs)) {
            messages.push(msg);
          }
        }
        messages.reverse();

        return ok({
          hive_id: this.hiveId,
          server_time_ms: Date.now(),
          messages
        });
      }

      if (request.method === "POST" && url.pathname === "/gossip/push") {
        const body = await readJson<{ messages?: HiveMessage[] }>(request);
        const incoming = Array.isArray(body?.messages) ? body?.messages : [];
        let accepted = 0;
        let skipped = 0;

        for (const msg of incoming) {
          if (!msg || !msg.uid || !msg.agentId || !msg.hiveId || !msg.content) {
            skipped += 1;
            continue;
          }
          if (msg.hiveId !== this.hiveId) {
            skipped += 1;
            continue;
          }
          const createdAtMs = Number(msg.createdAtMs);
          const ts = msg.ts ?? new Date(createdAtMs || Date.now()).toISOString();
          const stored = await this.storeMessage({
            uid: msg.uid,
            ts,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.parse(ts),
            agentId: msg.agentId,
            hiveId: msg.hiveId,
            content: msg.content,
            channel: msg.channel ?? "default",
            source: "gossip"
          });
          if (stored) accepted += 1;
          else skipped += 1;
        }

        await this.ensureAlarm();
        return ok({ accepted, skipped });
      }
    }

    return json(404, { error: "not found" });
  }
}
