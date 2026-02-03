export const PROTOCOL_VERSION = "OPENCLAW_HIVEMIND_V1" as const;

export type JoinMessageInput = {
  agentId: string;
  pubkey: string;
  nonce: string;
  hiveId: string;
  challengeExpiresAt: string;
  timestamp: string;
};

export function buildJoinMessage(input: JoinMessageInput): string {
  return [
    PROTOCOL_VERSION,
    input.agentId,
    input.pubkey,
    input.nonce,
    input.hiveId,
    input.challengeExpiresAt,
    input.timestamp
  ].join("\n");
}
