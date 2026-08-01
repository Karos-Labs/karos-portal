import { getCurrentUser } from "@/lib/auth";
import { getClient, getAsset } from "@/lib/data";
import { isAssetContentVisibleToClient } from "@/lib/asset-visibility";
import { canViewClient } from "@/lib/client-visibility";
import {
  buildSimulationPersonas,
  runSimulation,
  type SimulationArtifact,
} from "@/lib/simulation-engine";
import { CREDIT_COSTS } from "@/lib/credits";
import { chargeClientModelCall, refundClientModelCall } from "@/lib/client-model-charge";
import type { Asset, Client } from "@/lib/types";

export const maxDuration = 60;

function inferBusinessModel(client: Client): "B2B" | "B2C" | "MIXED" | null {
  const hay = `${client.industry ?? ""} ${client.category ?? ""} ${client.description ?? ""}`.toLowerCase();
  const b2bHint = /\bb2b\b|enterprise|procurement|compliance|saas|software|platform|agency|consulting|services/.test(hay);
  const b2cHint = /\bb2c\b|consumer|retail|ecommerce|shopper|lifestyle|fashion|beauty|food|travel/.test(hay);
  if (b2bHint && b2cHint) return "MIXED";
  if (b2bHint) return "B2B";
  if (b2cHint) return "B2C";
  return null;
}

function inferPostFormat(asset: Asset): string {
  const channels = (asset.channels ?? []).map((c) => c.toLowerCase());
  const slides = Array.isArray(asset.meta?.slides) ? asset.meta.slides : [];
  const isCarousel = slides.length > 1;
  const body = `${asset.title} ${asset.content}`.toLowerCase();

  if (asset.type === "article") return "Long-form article / technical blog";
  if (asset.type === "email") return "Newsletter issue / marketing email";
  if (asset.type === "instagram_post") {
    return isCarousel ? "Instagram carousel post" : "Instagram image post";
  }
  if (asset.type === "social_post") {
    if (channels.includes("linkedin")) return isCarousel ? "LinkedIn carousel post" : "LinkedIn social post";
    if (channels.includes("instagram")) return isCarousel ? "Instagram carousel post" : "Instagram social post";
    if (channels.includes("tiktok")) return "Short explainer video / TikTok script";
    if (channels.includes("youtube")) return "Short explainer video / YouTube short";
    if (/\bvideo|reel|tiktok|shorts|script\b/.test(body)) return "Short explainer video script";
    return isCarousel ? "Social media carousel post" : "Social media post";
  }
  if (asset.type === "note" && /\bvideo|reel|script|walkthrough|demo\b/.test(body)) {
    return "Short explainer video script";
  }
  return asset.type.replace(/_/g, " ");
}

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
  // A3, THE CHURN RULE, ON THE ONE SURFACE THAT BYPASSED IT.
  //
  // Every read path a client has runs assets through the archive/library
  // projections; this API did not, so a client could hand it the id of a
  // FUTURE-DATED post and read content the calendar deliberately withholds —
  // and once this route started charging, they were billed 5 credits for the
  // leak. `isAssetContentVisibleToClient` is the predicate those projections
  // already use; asking it here rather than writing a second visibility test is
  // the point (a second answer is how this rule got a hole in the first place).
  //
  // BEFORE the charge, deliberately: a client refused for visibility must not
  // pay. The 404 matches the "asset not found" shape above so the refusal does
  // not confirm that a hidden asset exists.
  if (user.role === "CLIENT_USER" && !isAssetContentVisibleToClient(asset, Date.now())) {
    return Response.json({ error: "Asset not found" }, { status: 404 });
  }

  // STAFF SCOPE, the same hole one surface over: the only role test above is the
  // CLIENT_USER branch, so an employee 404'd on /clients/[id] pages could still
  // read any client's asset through this API. Same predicate the pages use.
  if (user.role === "KAROS_EMPLOYEE" && !canViewClient(user, client)) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  if (!asset.content?.trim()) {
    return Response.json({ error: "This asset has no content to simulate." }, { status: 422 });
  }

  const artifact: SimulationArtifact = {
    title: asset.title,
    content: asset.content,
    type: asset.type,
    format: inferPostFormat(asset),
    channels: asset.channels,
  };
  const businessModel = inferBusinessModel(client);
  const simCtx = {
    clientId,
    clientName: client.name,
    industry: client.industry ?? null,
    category: client.category ?? null,
    toneOfVoice: client.brandVoice ?? null,
    targetMarket: client.description ?? null,
    businessModel,
  };

  // ── Charge ──
  // One press runs a persona planner plus one call per persona — up to five
  // Haiku calls — and it ran free, on any asset, as often as the client liked.
  //
  // PRICED AT `CREDIT_COSTS.taskExecution` (5): the existing rate for one
  // in-process AI run, which is the nearest operation this app already prices.
  // Charged FLAT rather than per persona on purpose — the panel size is chosen
  // by the planner model, so a per-persona price could not be quoted before the
  // client pressed the button, and five is the top of the range it can pick.
  const simulationCharge = {
    user,
    clientId,
    amount: CREDIT_COSTS.taskExecution,
    operation: "ai_tool" as const,
    // Client copy: the ledger feed renders ungated to a CLIENT_USER.
    reason: `Audience simulation · ${asset.title.slice(0, 80)}`,
  };
  const { denied, chargedAt } = await chargeClientModelCall(simulationCharge);
  if (denied !== null) return Response.json({ error: denied }, { status: 402 });

  // Unlike simulatePersona (which has a 3-tier fallback), persona planning is a
  // single model call with no rescue tier — a transient failure here must degrade
  // to a clean error response, not an unhandled throw / generic 500.
  let personas;
  try {
    personas = await buildSimulationPersonas(artifact, simCtx);
  } catch {
    await refundClientModelCall(
      simulationCharge,
      chargedAt,
      "Refund · audience simulation could not run",
    );
    return Response.json(
      { error: "Couldn't generate the audience panel for this asset. Please try again." },
      { status: 502 },
    );
  }

  const results = await runSimulation(artifact, personas, simCtx);

  // runSimulation never throws — it settles each persona and returns failures as
  // `error` entries — so "did this work" cannot be read off a catch. A panel
  // where EVERY persona failed is a panel the client cannot read a single
  // verdict from, and they are not paying for it. A partial panel is a real
  // result and stays charged.
  if (results.length === 0 || results.every((r) => r.error)) {
    await refundClientModelCall(
      simulationCharge,
      chargedAt,
      "Refund · audience simulation returned no verdicts",
    );
  }

  return Response.json({ assetId: asset.id, results });
}
