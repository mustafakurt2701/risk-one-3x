import { startPaperTrader } from "@/lib/paperTrader";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const state = await startPaperTrader({
      initialBalanceSol: Number(body.initialBalanceSol) || 1,
      solUsd: Number(body.solUsd) || 130,
      intervalSeconds: Number(body.intervalSeconds) || 10
    });
    return Response.json(state);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
