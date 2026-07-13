import { getCurrentUser } from "@/lib/auth";
import { getClient, getAsset } from "@/lib/data";
import {
  runSimulation,
  selectPersonasForIndustry,
  type SimulationArtifact,
} from "@/lib/simulation-engine";

export const maxDuration = 60;

/**
 * Pre-Flight Impact Simulation — run one asset's artifact past the synthetic
 * persona panel and return every persona's verdict. On-demand (triggered from
 * the "Audience Simulation" tab), one round-trip: the engine dispatches all
 * personas in parallel server-side and this returns them together, each entry
 * carrying its own verdict OR error so the UI degrades gracefully.
 *
 * The artifact content is read from Firestore by asset id (never trusted from
 * the client), and the asset is verified to belong to the client in the path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { assetId?: string };
  if (!body.assetId) {
    return Response.json({ error: "assetId is required" }, { status: 400 });
  }

  const [client, asset] = await Promise.all([getClient(clientId), getAsset(body.assetId)]);
  if (!client) return Response.json({ error: "Client not found" }, { status: 404 });
  if (!asset || asset.clientId !== clientId) {
    return Response.json({ error: "Asset not found" }, { status: 404 });
  }
  if (!asset.content?.trim()) {
    return Response.json({ error: "This asset has no content to simulate." }, { status: 422 });
  }

  const artifact: SimulationArtifact = {
    title: asset.title,
    content: asset.content,
    type: asset.type,
  };
  const personas = selectPersonasForIndustry(client.industry);

  const results = await runSimulation(artifact, personas, {
    clientId,
    clientName: client.name,
    industry: client.industry,
  });

  return Response.json({ assetId: asset.id, results });
}
