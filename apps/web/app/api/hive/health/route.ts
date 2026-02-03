import { fetchHealth } from "@/lib/hivemind";

export const runtime = "nodejs";

export async function GET() {
  try {
    const health = await fetchHealth();
    return Response.json({ ok: true, ...health });
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
