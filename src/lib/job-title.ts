/**
 * How a job's title carries the client's name, in ONE place.
 *
 * Every submit path writes `${agentName}${JOB_TITLE_CLIENT_SEPARATOR}${clientName}`
 * so a staff list can tell two clients' runs apart. The delivery handler then
 * strips that suffix again, because inside a client's own workspace every item
 * belongs to them and half of every title was their own company name.
 *
 * The strip used to look for an em dash while all three builders wrote a plain
 * hyphen, so it never fired — for any run, from any path. Separator and strip
 * now come from here so the two cannot drift apart again.
 */
export const JOB_TITLE_CLIENT_SEPARATOR = " - ";

/** The job title for a run of `agentName` against `clientName`. */
export function jobTitleForClient(agentName: string, clientName: string): string {
  return `${agentName}${JOB_TITLE_CLIENT_SEPARATOR}${clientName}`;
}

/**
 * The deliverable's title: the job title with its appended " - <client>" gone.
 *
 * Matches only that exact prefix — never a blind split on the separator, since
 * an agent or client name may legitimately contain one. The job doc keeps its
 * full title.
 */
export function assetTitleFromJobTitle(jobTitle: string, agentName?: string | null): string {
  if (!agentName) return jobTitle;
  return jobTitle.startsWith(agentName + JOB_TITLE_CLIENT_SEPARATOR) ? agentName : jobTitle;
}
