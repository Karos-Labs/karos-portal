import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getClient, getNewsletterConfig, listContextItems } from "@/lib/data";
import { mergeNewsletterConfig } from "@/lib/newsletter/defaults";
import { Icon } from "@/components/icon";
import { NewsletterQuestionnaire } from "@/components/newsletter-questionnaire";

/**
 * Onboarding questionnaire surface — Milestone 1 of the native newsletter+blog port.
 * Collects the three engine inputs for a client: brand (Bucket A) + content foundation
 * (Bucket B) into newsletterConfigs/{clientId}, and reference/image uploads (Bucket C)
 * into the existing ContextItem collection, tagged by purpose.
 */
export default async function NewsletterOnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser(["admin", "employee"]);
  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  const [stored, contextItems] = await Promise.all([
    getNewsletterConfig(id),
    listContextItems({ clientId: id }),
  ]);
  const config = mergeNewsletterConfig(client, stored);
  const references = contextItems.filter((c) => c.purpose === "newsletter_reference");
  const imagePool = contextItems.filter((c) => c.purpose === "image_pool");

  return (
    <>
      <Link
        href={`/clients/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> Back to {client.name}
      </Link>

      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Newsletter &amp; blog setup</h1>
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">e11</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          The one-time onboarding intake for {client.name}. It produces the engine&apos;s three
          inputs: the brand and identity, the editorial foundation, and the voice-anchor uploads.
        </p>
      </div>

      <NewsletterQuestionnaire
        clientId={id}
        config={config}
        references={references}
        imagePool={imagePool}
      />
    </>
  );
}
