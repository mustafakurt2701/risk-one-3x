import { sendCurrentSignalsToTelegram } from "@/lib/paperTrader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return Response.json(await sendCurrentSignalsToTelegram());
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
