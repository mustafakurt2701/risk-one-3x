import { stopPaperTrader } from "@/lib/paperTrader";

export const runtime = "nodejs";

export async function POST() {
  return Response.json(stopPaperTrader());
}
