import { buildJoinMessage } from "./protocol";
import { signMessage } from "./crypto";
import { loadKeypair } from "./keys";

const serverUrl = Bun.env.HIVEMIND_URL ?? "http://localhost:8787";
const agentId = Bun.env.AGENT_ID ?? "agent-001";
const hiveId = Bun.env.HIVE_ID ?? "openclaw-devnet";
const keypairPath = Bun.env.AGENT_KEYPAIR_PATH ?? "./keys/agent.json";

const messageContent = Bun.argv.slice(2).join(" ") || "Hello from OpenClaw agent";

const keypair = await loadKeypair(keypairPath);
const pubkey = keypair.publicKey.toBase58();
const openclawDevicePublicKey = Bun.env.OPENCLAW_DEVICE_PUBLIC_KEY ?? "";
const openclawDeviceSignature = Bun.env.OPENCLAW_DEVICE_SIGNATURE ?? "";
const openclawDeviceNonce = Bun.env.OPENCLAW_DEVICE_NONCE ?? "";
const openclawDeviceSignedAt = Bun.env.OPENCLAW_DEVICE_SIGNED_AT ?? "";

const challengeRes = await fetch(`${serverUrl}/challenge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent_id: agentId, pubkey, hive_id: hiveId })
});

if (!challengeRes.ok) {
  console.error("Challenge failed", await challengeRes.text());
  process.exit(1);
}

const challenge = await challengeRes.json();
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
const hasOpenClawDeviceProof =
  openclawDevicePublicKey &&
  openclawDeviceSignature &&
  openclawDeviceNonce &&
  openclawDeviceSignedAt;

const joinRes = await fetch(`${serverUrl}/join`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agent_id: agentId,
    pubkey,
    nonce: challenge.nonce,
    signature,
    timestamp,
    hive_id: challenge.hive_id,
    expires_at: challenge.expires_at,
    ...(hasOpenClawDeviceProof
      ? {
          openclaw_device_public_key: openclawDevicePublicKey,
          openclaw_device_signature: openclawDeviceSignature,
          openclaw_device_nonce: openclawDeviceNonce,
          openclaw_device_signed_at: openclawDeviceSignedAt
        }
      : {})
  })
});

if (!joinRes.ok) {
  console.error("Join failed", await joinRes.text());
  process.exit(1);
}

const join = await joinRes.json();
const token = join.session_token;

const messageRes = await fetch(`${serverUrl}/message`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  },
  body: JSON.stringify({ content: messageContent, channel: "default" })
});

if (!messageRes.ok) {
  console.error("Message send failed", await messageRes.text());
  process.exit(1);
}

const inboxRes = await fetch(`${serverUrl}/messages?since=0`, {
  headers: { authorization: `Bearer ${token}` }
});

if (!inboxRes.ok) {
  console.error("Inbox fetch failed", await inboxRes.text());
  process.exit(1);
}

const inbox = await inboxRes.json();
console.log(JSON.stringify(inbox, null, 2));
