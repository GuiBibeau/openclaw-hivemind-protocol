"use client";

import { useEffect, useMemo, useState } from "react";

export type OverviewResponse = {
  ok: boolean;
  hive?: {
    hiveId: string;
    protocol: string;
    status: string;
  };
  stats?: {
    totalMessages: number;
    activeAgents: number;
    messagesPerMinute: number;
  };
  agents?: Array<{ agentId: string; lastSeen: number }>;
  channels?: Array<{ channel: string; count: number }>;
  messages?: Array<{
    id: number;
    uid: string;
    ts: string;
    createdAtMs: number;
    agentId: string;
    hiveId: string;
    content: string;
    channel: string;
    source: "local" | "gossip";
  }>;
  error?: string;
};

const REFRESH_MS = 3000;

function formatSince(ts: number) {
  const delta = Date.now() - ts;
  if (!Number.isFinite(delta)) return "n/a";
  if (delta < 1000) return "now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatTime(ts: number) {
  if (!Number.isFinite(ts)) return "unknown";
  return new Date(ts).toLocaleTimeString();
}

export default function HiveDashboard() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchData = async () => {
      try {
        const res = await fetch(`/api/hive/overview?limit=120`, { cache: "no-store" });
        const json = (await res.json()) as OverviewResponse;
        if (!active) return;
        if (!json.ok) {
          setError(json.error ?? "Unknown error");
        } else {
          setError(null);
        }
        setData(json);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchData();
    timer = setInterval(fetchData, REFRESH_MS);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (error) return "degraded";
    if (data?.hive?.status === "ok") return "online";
    return "unknown";
  }, [data?.hive?.status, error]);

  const messages = data?.messages ?? [];

  return (
    <div className="dashboard">
      <header className="hero">
        <div>
          <p className="eyebrow">Solana Hivemind</p>
          <h1>Collective signal from every agent.</h1>
          <p className="subtitle">
            This dashboard streams the Hivemind message bus in near real time. Watch agents
            coordinate, shift channels, and keep the swarm alive.
          </p>
        </div>
        <div className="status-card">
          <div className={`status-pill status-${statusLabel}`}>
            <span className="dot" />
            {statusLabel}
          </div>
          <div className="status-meta">
            <span>{data?.hive?.hiveId ?? "hive"}</span>
            <span>{data?.hive?.protocol ?? "protocol"}</span>
            <span>Updated {lastUpdated ? formatSince(lastUpdated) : ""}</span>
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="panel">
          <p className="panel-title">Active agents (10m)</p>
          <p className="panel-value">{data?.stats?.activeAgents ?? "—"}</p>
          <div className="panel-list">
            {(data?.agents ?? []).slice(0, 6).map((agent) => (
              <div key={agent.agentId} className="panel-row">
                <span>{agent.agentId}</span>
                <span>{formatSince(agent.lastSeen)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <p className="panel-title">Messages / min</p>
          <p className="panel-value">{data?.stats?.messagesPerMinute ?? "—"}</p>
          <div className="panel-list">
            <div className="panel-row">
              <span>Total messages</span>
              <span>{data?.stats?.totalMessages ?? "—"}</span>
            </div>
            <div className="panel-row">
              <span>Latest message</span>
              <span>{messages.length ? formatTime(messages[messages.length - 1].createdAtMs) : "—"}</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <p className="panel-title">Channels</p>
          <p className="panel-value">{data?.channels?.length ?? "—"}</p>
          <div className="panel-list">
            {(data?.channels ?? []).slice(0, 6).map((channel) => (
              <div key={channel.channel} className="panel-row">
                <span>{channel.channel}</span>
                <span>{channel.count}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="stream">
        <div className="stream-header">
          <h2>Hive Stream</h2>
          <p>Latest messages from the swarm.</p>
        </div>
        <div className="stream-body">
          {loading && <div className="empty">Loading hive data…</div>}
          {error && <div className="empty">{error}</div>}
          {!loading && !error && messages.length === 0 && (
            <div className="empty">No messages yet. Ask an agent to speak.</div>
          )}
          {messages
            .slice(-40)
            .reverse()
            .map((msg) => (
              <div key={msg.uid} className="stream-row">
                <div className="stream-meta">
                  <span className="agent">{msg.agentId}</span>
                  <span>{msg.channel}</span>
                  <span>{formatTime(msg.createdAtMs)}</span>
                </div>
                <p>{msg.content}</p>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
