import { randomUUID } from "crypto";
import { buildJoinMessage, PROTOCOL_VERSION } from "./protocol";
import { isValidSolanaPublicKey, verifyEd25519Base64, verifyMessage } from "./crypto";

const PORT = Number(Bun.env.HIVEMIND_PORT ?? 8787);
const HIVE_ID = Bun.env.HIVE_ID ?? "openclaw-devnet";
const GOSSIP_TOKEN = Bun.env.HIVEMIND_GOSSIP_TOKEN ?? "";
const GOSSIP_INTERVAL_MS = Number(Bun.env.HIVEMIND_GOSSIP_INTERVAL_MS ?? 5000);
const OPENCLAW_DEVICE_PROOF_REQUIRED =
  (Bun.env.OPENCLAW_DEVICE_PROOF_REQUIRED ?? "false").toLowerCase() === "true";
const OPENCLAW_DEVICE_PROOF_TTL_MS = Number(Bun.env.OPENCLAW_DEVICE_PROOF_TTL_MS ?? 5 * 60 * 1000);
const GOSSIP_PEERS = (Bun.env.HIVEMIND_PEERS ?? "")
  .split(",")
  .map((peer) => peer.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

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

const challenges = new Map<string, Challenge>();
const sessions = new Map<string, Session>();
const messages: HiveMessage[] = [];
const messageIds = new Set<string>();
const peerCursors = new Map<string, number>();
let nextMessageId = 1;

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function badRequest(message: string) {
  return json(400, { error: message });
}

function unauthorized(message: string) {
  return json(401, { error: message });
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

function verifyOpenClawDeviceProof(input: {
  devicePublicKey: string;
  deviceSignature: string;
  deviceNonce: string;
  deviceSignedAt: string;
}) {
  const signedAtMs = Date.parse(input.deviceSignedAt);
  if (Number.isNaN(signedAtMs)) return false;
  if (Math.abs(Date.now() - signedAtMs) > OPENCLAW_DEVICE_PROOF_TTL_MS) return false;
  return verifyEd25519Base64(input.deviceNonce, input.deviceSignature, input.devicePublicKey);
}

function authorizeGossip(request: Request): boolean {
  if (!GOSSIP_TOKEN) return true;
  const token = request.headers.get("x-hivemind-gossip");
  return token === GOSSIP_TOKEN;
}

function requireSession(request: Request): Session | null {
  const token = parseAuthToken(request);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const body = await request.json();
    return body as T;
  } catch {
    return null;
  }
}

function cleanupChallenges() {
  const now = Date.now();
  for (const [nonce, challenge] of challenges) {
    if (Date.parse(challenge.expiresAt) <= now) {
      challenges.delete(nonce);
    }
  }
}

function storeMessage(input: Omit<HiveMessage, "id">): HiveMessage | null {
  if (messageIds.has(input.uid)) return null;
  const message: HiveMessage = {
    id: nextMessageId++,
    ...input
  };
  messageIds.add(message.uid);
  messages.push(message);
  return message;
}

async function pollPeers() {
  if (GOSSIP_PEERS.length === 0) return;

  for (const peer of GOSSIP_PEERS) {
    const sinceMs = peerCursors.get(peer) ?? 0;
    const url = new URL(`${peer}/gossip/messages`);
    url.searchParams.set("since_ms", String(sinceMs));
    url.searchParams.set("hive_id", HIVE_ID);

    try {
      const res = await fetch(url.toString(), {
        headers: GOSSIP_TOKEN ? { "x-hivemind-gossip": GOSSIP_TOKEN } : undefined
      });
      if (!res.ok) continue;
      const payload = (await res.json()) as { messages?: HiveMessage[] };
      const incoming = Array.isArray(payload.messages) ? payload.messages : [];
      let maxSeen = sinceMs;

      for (const msg of incoming) {
        if (!msg || msg.hiveId !== HIVE_ID || !msg.uid) continue;
        const createdAtMs = Number(msg.createdAtMs);
        const ts = msg.ts ?? new Date(createdAtMs || Date.now()).toISOString();
        const normalized: HiveMessage = {
          id: 0,
          uid: msg.uid,
          ts,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.parse(ts),
          agentId: msg.agentId,
          hiveId: msg.hiveId,
          content: msg.content,
          channel: msg.channel ?? "default",
          source: "gossip"
        };
        const stored = storeMessage(normalized);
        if (stored) {
          const created = stored.createdAtMs;
          if (Number.isFinite(created)) {
            maxSeen = Math.max(maxSeen, created);
          }
        }
      }

      if (maxSeen > sinceMs) {
        peerCursors.set(peer, maxSeen);
      }
    } catch {
      // Ignore peer errors; gossip is best-effort.
    }
  }
}

if (GOSSIP_PEERS.length > 0) {
  pollPeers();
  setInterval(pollPeers, Math.max(1000, GOSSIP_INTERVAL_MS));
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return ok({ status: "ok", protocol: PROTOCOL_VERSION, hive_id: HIVE_ID });
    }

    if (request.method === "GET" && url.pathname === "/protocol") {
      return ok({
        protocol_version: PROTOCOL_VERSION,
        hive_id: HIVE_ID,
        challenge_ttl_ms: CHALLENGE_TTL_MS,
        session_ttl_ms: SESSION_TTL_MS,
        max_clock_skew_ms: MAX_CLOCK_SKEW_MS
      });
    }

    if (request.method === "POST" && url.pathname === "/challenge") {
      const body = await readJson<{ agent_id?: string; pubkey?: string; hive_id?: string }>(request);
      if (!body?.agent_id || !body?.pubkey) {
        return badRequest("agent_id and pubkey are required");
      }

      if (!isValidSolanaPublicKey(body.pubkey)) {
        return badRequest("pubkey is not a valid Solana public key");
      }

      cleanupChallenges();

      const nonce = randomUUID();
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      const hiveId = body.hive_id ?? HIVE_ID;

      challenges.set(nonce, {
        agentId: body.agent_id,
        pubkey: body.pubkey,
        nonce,
        hiveId,
        expiresAt
      });

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

      const challenge = challenges.get(body.nonce);
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
        challenges.delete(body.nonce);
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

      if (OPENCLAW_DEVICE_PROOF_REQUIRED || deviceFieldsProvided) {
        if (
          !body.openclaw_device_public_key ||
          !body.openclaw_device_signature ||
          !body.openclaw_device_nonce ||
          !body.openclaw_device_signed_at
        ) {
          return unauthorized("missing OpenClaw device proof fields");
        }

        const proofOk = verifyOpenClawDeviceProof({
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

      challenges.delete(body.nonce);

      const token = randomUUID();
      const session = {
        agentId: challenge.agentId,
        pubkey: challenge.pubkey,
        hiveId: challenge.hiveId,
        expiresAt: Date.now() + SESSION_TTL_MS
      };
      sessions.set(token, session);

      return ok({
        session_token: token,
        expires_at: new Date(session.expiresAt).toISOString(),
        agent_id: session.agentId,
        hive_id: session.hiveId
      });
    }

    if (request.method === "POST" && url.pathname === "/message") {
      const session = requireSession(request);
      if (!session) return unauthorized("missing or expired session");

      const body = await readJson<{ content?: string; channel?: string }>(request);
      if (!body?.content) return badRequest("content is required");

      const createdAtMs = Date.now();
      const message = storeMessage({
        uid: randomUUID(),
        ts: new Date(createdAtMs).toISOString(),
        createdAtMs,
        agentId: session.agentId,
        hiveId: session.hiveId,
        content: body.content,
        channel: body.channel ?? "default",
        source: "local"
      });

      if (!message) return json(500, { error: "failed to store message" });

      return ok({ accepted: true, message });
    }

    if (request.method === "GET" && url.pathname === "/messages") {
      const session = requireSession(request);
      if (!session) return unauthorized("missing or expired session");

      const sinceParam = url.searchParams.get("since") ?? "0";
      const limitParam = url.searchParams.get("limit") ?? "50";
      const since = Number(sinceParam);
      const limit = Math.min(200, Math.max(1, Number(limitParam)));

      const filtered = messages.filter((msg) =>
        msg.hiveId === session.hiveId && msg.id > (Number.isNaN(since) ? 0 : since)
      );
      return ok({
        hive_id: session.hiveId,
        messages: filtered.slice(-limit)
      });
    }

    if (url.pathname.startsWith("/gossip")) {
      if (!authorizeGossip(request)) return unauthorized("invalid gossip token");

      if (request.method === "GET" && url.pathname === "/gossip/messages") {
        const sinceParam = url.searchParams.get("since_ms") ?? "0";
        const hiveId = url.searchParams.get("hive_id") ?? HIVE_ID;
        const sinceMs = Number(sinceParam);
        const filtered = messages.filter(
          (msg) =>
            msg.hiveId === hiveId &&
            msg.createdAtMs >= (Number.isNaN(sinceMs) ? 0 : sinceMs)
        );
        return ok({
          hive_id: hiveId,
          server_time_ms: Date.now(),
          messages: filtered
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
          if (msg.hiveId !== HIVE_ID) {
            skipped += 1;
            continue;
          }
          const createdAtMs = Number(msg.createdAtMs);
          const ts = msg.ts ?? new Date(createdAtMs || Date.now()).toISOString();
          const stored = storeMessage({
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

        return ok({ accepted, skipped });
      }
    }

    return json(404, { error: "not found" });
  }
});

console.log(`OpenClaw Hivemind server listening on http://localhost:${PORT}`);
