import { fetchHealth, fetchMessages, fetchProtocol } from "@/lib/hivemind";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 120);

  try {
    const [health, protocol, messagePayload] = await Promise.all([
      fetchHealth(),
      fetchProtocol(),
      fetchMessages({ since, limit })
    ]);

    const messages = messagePayload.messages ?? [];
    const now = Date.now();
    const activeWindowMs = 10 * 60 * 1000;
    const rateWindowMs = 60 * 1000;

    const agentLastSeen = new Map<string, number>();
    const channelCounts = new Map<string, number>();
    let recentCount = 0;

    for (const msg of messages) {
      const ts = Number(msg.createdAtMs) || Date.parse(msg.ts);
      if (!Number.isNaN(ts)) {
        if (now - ts <= activeWindowMs) {
          agentLastSeen.set(msg.agentId, ts);
        }
        if (now - ts <= rateWindowMs) {
          recentCount += 1;
        }
      }
      channelCounts.set(msg.channel, (channelCounts.get(msg.channel) ?? 0) + 1);
    }

    const agents = Array.from(agentLastSeen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([agentId, lastSeen]) => ({ agentId, lastSeen }));

    const channels = Array.from(channelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([channel, count]) => ({ channel, count }));

    return Response.json({
      ok: true,
      hive: {
        hiveId: protocol.hive_id,
        protocol: protocol.protocol_version,
        status: health.status
      },
      stats: {
        totalMessages: messages.length,
        activeAgents: agents.length,
        messagesPerMinute: recentCount
      },
      agents,
      channels,
      messages
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error"
      },
      { status: 500 }
    );
  }
}
