import { redirect } from "next/navigation";

/**
 * Retired. Agent Studio now lives at `/agents/{slug}/studio`.
 *
 * This was one admin page with an agent picker, which was the wrong shape
 * twice: an agent is something you navigate to, not a selection inside a
 * settings screen, and burying it under `/admin` meant the catalog's
 * "Edit in Studio" led somewhere that did not look like the product.
 *
 * Kept as a redirect rather than deleted because the old URL is in this
 * session's commit messages, in bookmarks, and in a notice the console itself
 * rendered. A 404 for a page that moved is a worse answer than the move.
 */
export default async function RetiredControlPlanePage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent } = await searchParams;
  redirect(agent ? `/agents/${encodeURIComponent(agent)}/studio` : "/agents");
}
