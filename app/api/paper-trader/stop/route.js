import { stopPaperTrader } from "@/lib/paperTrader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(stopPaperTrader());
}
