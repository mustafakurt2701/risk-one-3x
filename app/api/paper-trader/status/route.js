import { getPaperTraderState } from "@/lib/paperTrader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getPaperTraderState());
}
