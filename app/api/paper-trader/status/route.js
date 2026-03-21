import { getPaperTraderState } from "@/lib/paperTrader";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(getPaperTraderState());
}
