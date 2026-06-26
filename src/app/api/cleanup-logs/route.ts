import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BATCH_SIZE = 400; // well under the 500-op Firestore batch limit

/** Batch-delete all documents in a collection where timestamp < cutoff. */
async function purgeBefore(collectionName: string, cutoff: number): Promise<number> {
  const db = adminDb();
  let deleted = 0;
  while (true) {
    const snap = await db
      .collection(collectionName)
      .where("timestamp", "<", cutoff)
      .limit(BATCH_SIZE)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.docs.length;
  }
  return deleted;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const cutoff = Date.now() - RETENTION_MS;
  const [usageDeleted, errorDeleted] = await Promise.all([
    purgeBefore("usageLogs", cutoff),
    purgeBefore("errorLogs", cutoff),
  ]);

  return NextResponse.json({
    ok: true,
    cutoffDate: new Date(cutoff).toISOString(),
    usageLogsDeleted: usageDeleted,
    errorLogsDeleted: errorDeleted,
  });
}
