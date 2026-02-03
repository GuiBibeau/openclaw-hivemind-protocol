import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFile } from "fs/promises";
import { resolve } from "path";

const encoder = new TextEncoder();

export type HiveMessage = {
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

type Session = {
  token: string;
  expiresAt: string;
  hiveId: string;
  agentId: string;
};

let cachedSession: Session | null = null;

function env(name: string, fallback?: string) {
  return process.env[name] ?? fallback;
}

function buildJoinMessage(input: {
  agentId: string;
  pubkey: string;
  nonce: string;
  hiveId: string;
  challengeExpiresAt: string;
  timestamp: string;
}) {
  return [
    "OPENCLAW_HIVEMIND_V1",
    input.agentId,
    input.pubkey,
    input.nonce,
    input.hiveId,
    input.challengeExpiresAt,
    input.timestamp
  ].join("\n");
}

function signMessage(message: string, keypair: Keypair): string {
  const msgBytes = encoder.encode(message);
  const signature = nacl.sign.detached(msgBytes, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

async function loadKeypair(): Promise<Keypair> {
  const json = env("HIVEMIND_KEYPAIR_JSON");
  if (json) {
    const secret = Uint8Array.from(JSON.parse(json));
    return Keypair.fromSecretKey(secret);
  }

  const path = env("HIVEMIND_KEYPAIR_PATH");
  if (!path) {
    throw new Error("Missing HIVEMIND_KEYPAIR_JSON or HIVEMIND_KEYPAIR_PATH");
  }

  const resolved = resolve(process.cwd(), path);
  const raw = await readFile(resolved, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function sessionValid(session: Session | null) {
  if (!session) return false;
  const expiresMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > Date.now() + 5000;
}

export async function ensureSession(): Promise<Session> {
  if (sessionValid(cachedSession)) return cachedSession as Session;

  const hiveUrl = env("HIVEMIND_URL");
  if (!hiveUrl) throw new Error("Missing HIVEMIND_URL");
  const hiveId = env("HIVEMIND_HIVE_ID", "openclaw-devnet") as string;
  const agentId = env("HIVEMIND_AGENT_ID", "dashboard-001") as string;

  const keypair = await loadKeypair();
  const pubkey = keypair.publicKey.toBase58();

  const challenge = await requestJson<{ nonce: string; hive_id: string; expires_at: string }>(
    `${hiveUrl}/challenge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, pubkey, hive_id: hiveId })
    }
  );

  const timestamp = new Date().toISOString();
  const joinMessage = buildJoinMessage({
    agentId,
    pubkey,
    nonce: challenge.nonce,
    hiveId: challenge.hive_id,
    challengeExpiresAt: challenge.expires_at,
    timestamp
  });

  const signature = signMessage(joinMessage, keypair);

  const joinPayload: Record<string, string> = {
    agent_id: agentId,
    pubkey,
    nonce: challenge.nonce,
    signature,
    timestamp,
    hive_id: challenge.hive_id,
    expires_at: challenge.expires_at
  };

  const devicePublicKey = env("OPENCLAW_DEVICE_PUBLIC_KEY");
  const deviceSignature = env("OPENCLAW_DEVICE_SIGNATURE");
  const deviceNonce = env("OPENCLAW_DEVICE_NONCE");
  const deviceSignedAt = env("OPENCLAW_DEVICE_SIGNED_AT");

  if (devicePublicKey && deviceSignature && deviceNonce && deviceSignedAt) {
    joinPayload.openclaw_device_public_key = devicePublicKey;
    joinPayload.openclaw_device_signature = deviceSignature;
    joinPayload.openclaw_device_nonce = deviceNonce;
    joinPayload.openclaw_device_signed_at = deviceSignedAt;
  }

  const join = await requestJson<{ session_token: string; expires_at: string; hive_id: string }>(
    `${hiveUrl}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinPayload)
    }
  );

  cachedSession = {
    token: join.session_token,
    expiresAt: join.expires_at,
    hiveId: join.hive_id ?? hiveId,
    agentId
  };

  return cachedSession;
}

export async function fetchMessages(options?: { since?: number; limit?: number }) {
  const session = await ensureSession();
  const hiveUrl = env("HIVEMIND_URL") as string;
  const since = options?.since ?? 0;
  const limit = options?.limit ?? 100;

  const url = new URL(`${hiveUrl}/messages`);
  url.searchParams.set("since", String(since));
  url.searchParams.set("limit", String(limit));

  const response = await requestJson<{ messages: HiveMessage[] }>(url.toString(), {
    headers: { authorization: `Bearer ${session.token}` }
  });

  return {
    session,
    messages: response.messages ?? []
  };
}

export async function fetchHealth() {
  const hiveUrl = env("HIVEMIND_URL") as string;
  return requestJson<{ status: string; protocol: string; hive_id: string }>(`${hiveUrl}/health`);
}

export async function fetchProtocol() {
  const hiveUrl = env("HIVEMIND_URL") as string;
  return requestJson<{ protocol_version: string; hive_id: string; challenge_ttl_ms: number }>(
    `${hiveUrl}/protocol`
  );
}
