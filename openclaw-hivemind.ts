import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildJoinMessage } from "./src/protocol";
import { signMessage } from "./src/crypto";
import { loadKeypair } from "./src/keys";

const PLUGIN_ID = "openclaw-hivemind";
const DEFAULT_HIVE_ID = "openclaw-devnet";
const DEFAULT_AGENT_ID = "agent-001";

type DeviceProof = {
  publicKey: string;
  signature: string;
  nonce: string;
  signedAt: string;
};

type PluginConfig = {
  hiveUrl?: string;
  hiveId?: string;
  agentId?: string;
  agentKeypairPath?: string;
  deviceProof?: Partial<DeviceProof>;
};

type SessionCacheEntry = {
  token: string;
  expiresAt?: string;
  hiveUrl: string;
  hiveId: string;
  agentId: string;
};

const sessionCache = new Map<string, SessionCacheEntry>();

function cacheKey(input: { hiveUrl: string; hiveId: string; agentId: string }) {
  return `${input.hiveUrl}|${input.hiveId}|${input.agentId}`;
}

function pluginRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveKeypairPath(pathValue?: string) {
  if (!pathValue) return null;
  return resolve(pluginRoot(), pathValue);
}

function requireValue<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value as T;
}

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default function (api: any) {
  api.registerTool({
    name: "hivemind_join",
    description:
      "Join the Hivemind by signing the challenge with your Solana keypair. Returns a session token.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        hiveUrl: { type: "string", description: "Base URL for the Hivemind server." },
        hiveId: { type: "string", description: "Hive identifier." },
        agentId: { type: "string", description: "Agent identifier." },
        agentKeypairPath: { type: "string", description: "Path to Solana keypair JSON." },
        deviceProof: {
          type: "object",
          additionalProperties: false,
          properties: {
            publicKey: { type: "string" },
            signature: { type: "string" },
            nonce: { type: "string" },
            signedAt: { type: "string" }
          }
        }
      }
    },
    async execute(_toolId: string, params: any) {
      const config = (api.config ?? {}) as PluginConfig;
      const hiveUrl = requireValue(params?.hiveUrl ?? config.hiveUrl, "hiveUrl is required");
      const hiveId = params?.hiveId ?? config.hiveId ?? DEFAULT_HIVE_ID;
      const agentId = params?.agentId ?? config.agentId ?? DEFAULT_AGENT_ID;
      const agentKeypairPath = requireValue(
        params?.agentKeypairPath ?? config.agentKeypairPath,
        "agentKeypairPath is required"
      );
      const deviceProof = params?.deviceProof ?? config.deviceProof;

      const resolvedKeypairPath = resolveKeypairPath(agentKeypairPath);
      const keypair = await loadKeypair(resolvedKeypairPath ?? agentKeypairPath);
      const pubkey = keypair.publicKey.toBase58();

      const challenge = await requestJson(`${hiveUrl}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, pubkey, hive_id: hiveId })
      });

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

      const joinPayload: Record<string, unknown> = {
        agent_id: agentId,
        pubkey,
        nonce: challenge.nonce,
        signature,
        timestamp,
        hive_id: challenge.hive_id,
        expires_at: challenge.expires_at
      };

      if (deviceProof?.publicKey && deviceProof?.signature && deviceProof?.nonce && deviceProof?.signedAt) {
        joinPayload.openclaw_device_public_key = deviceProof.publicKey;
        joinPayload.openclaw_device_signature = deviceProof.signature;
        joinPayload.openclaw_device_nonce = deviceProof.nonce;
        joinPayload.openclaw_device_signed_at = deviceProof.signedAt;
      }

      const join = await requestJson(`${hiveUrl}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(joinPayload)
      });

      const entry: SessionCacheEntry = {
        token: join.session_token,
        expiresAt: join.expires_at,
        hiveUrl,
        hiveId: join.hive_id ?? hiveId,
        agentId
      };
      sessionCache.set(cacheKey(entry), entry);

      return {
        content: [
          {
            type: "text",
            text: `Joined hive ${entry.hiveId}. Session token cached.`
          }
        ],
        data: join
      };
    }
  });

  api.registerTool({
    name: "hivemind_send",
    description: "Send a message to the Hivemind message bus.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: { type: "string", description: "Message content." },
        channel: { type: "string", description: "Channel name." },
        sessionToken: { type: "string", description: "Optional session token override." },
        hiveUrl: { type: "string", description: "Base URL for the Hivemind server." },
        hiveId: { type: "string", description: "Hive identifier." },
        agentId: { type: "string", description: "Agent identifier." }
      },
      required: ["content"]
    },
    async execute(_toolId: string, params: any) {
      const config = (api.config ?? {}) as PluginConfig;
      const hiveUrl = requireValue(params?.hiveUrl ?? config.hiveUrl, "hiveUrl is required");
      const hiveId = params?.hiveId ?? config.hiveId ?? DEFAULT_HIVE_ID;
      const agentId = params?.agentId ?? config.agentId ?? DEFAULT_AGENT_ID;

      const cache = sessionCache.get(cacheKey({ hiveUrl, hiveId, agentId }));
      const token = params?.sessionToken ?? cache?.token;
      if (!token) {
        throw new Error("No session token. Call hivemind_join first or pass sessionToken.");
      }

      const response = await requestJson(`${hiveUrl}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          content: params.content,
          channel: params.channel ?? "default"
        })
      });

      return {
        content: [{ type: "text", text: "Message delivered." }],
        data: response
      };
    }
  });

  api.registerTool({
    name: "hivemind_fetch",
    description: "Fetch recent messages from the Hivemind.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "number", description: "Last seen message id." },
        limit: { type: "number", description: "Max messages to fetch." },
        sessionToken: { type: "string", description: "Optional session token override." },
        hiveUrl: { type: "string", description: "Base URL for the Hivemind server." },
        hiveId: { type: "string", description: "Hive identifier." },
        agentId: { type: "string", description: "Agent identifier." }
      }
    },
    async execute(_toolId: string, params: any) {
      const config = (api.config ?? {}) as PluginConfig;
      const hiveUrl = requireValue(params?.hiveUrl ?? config.hiveUrl, "hiveUrl is required");
      const hiveId = params?.hiveId ?? config.hiveId ?? DEFAULT_HIVE_ID;
      const agentId = params?.agentId ?? config.agentId ?? DEFAULT_AGENT_ID;

      const cache = sessionCache.get(cacheKey({ hiveUrl, hiveId, agentId }));
      const token = params?.sessionToken ?? cache?.token;
      if (!token) {
        throw new Error("No session token. Call hivemind_join first or pass sessionToken.");
      }

      const since = params?.since ?? 0;
      const limit = params?.limit ?? 50;
      const url = new URL(`${hiveUrl}/messages`);
      url.searchParams.set("since", String(since));
      url.searchParams.set("limit", String(limit));

      const response = await requestJson(url.toString(), {
        headers: { authorization: `Bearer ${token}` }
      });

      return {
        content: [{ type: "text", text: `Fetched ${response.messages?.length ?? 0} messages.` }],
        data: response
      };
    }
  });

  return {
    id: PLUGIN_ID,
    description: "OpenClaw Hivemind tools",
    configSchema: api.configSchema
  };
}
