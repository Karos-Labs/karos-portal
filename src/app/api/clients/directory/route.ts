import { NextResponse } from "next/server";
import { listClients } from "@/lib/data";

// Reads Firestore at runtime — never prerender or cache (keep the company list fresh).
export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated directory of existing companies — powers the company-name autocomplete
 * on the signup form so a client joining an EXISTING company picks the canonical record (which
 * skips the onboarding intel report) instead of typing a near-duplicate name.
 *
 * Deliberately minimal: returns only the id + display name of active clients, never contact
 * emails, websites, or any internal detail.
 */
export async function GET() {
  try {
    const clients = await listClients();
    const directory = clients
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, name: c.name }));
    return NextResponse.json({ clients: directory });
  } catch {
    // Autocomplete is a convenience — never block the signup page if the lookup fails.
    return NextResponse.json({ clients: [] });
  }
}
