import type { ClientIntegration } from "@/lib/types";
import { PLATFORM_REGISTRY } from "@/lib/integrations/platforms";

/**
 * An integration stripped of everything secret — OAuth tokens, pasted API keys and
 * employee-seat tokens stay on the server. Props cross into the RSC payload, so
 * anything here is readable by the end user whether or not the UI renders it.
 *
 * Deliberately a Pick (allowlist), not an Omit: a field added to ClientIntegration
 * later must be opted in here rather than silently shipped to the browser.
 */
export type IntegrationView = Pick<
  ClientIntegration,
  "id" | "clientId" | "platform" | "accountName" | "autoPublish" | "status" | "method"
> & {
  /** Non-secret (text) credential fields only, keyed as in PLATFORM_REGISTRY. */
  credentials: Record<string, string>;
  /** Which secret fields are stored, so the form can show "leave blank to keep". */
  secretsSet: string[];
};

/**
 * Strips secrets from raw ClientIntegration docs before they cross into any
 * client component's props. Shared by every surface that lists a client's
 * integrations (settings page, onboarding wizard) so the allowlist logic only
 * lives in one place.
 *
 * Allowlist, not denylist: the OAuth flow writes keys the registry never
 * declares (`refreshToken` on most providers), so anything undeclared is
 * treated as secret.
 */
export function sanitizeIntegrations(integrations: ClientIntegration[]): IntegrationView[] {
  return integrations.map((i) => {
    const fields = PLATFORM_REGISTRY.find((p) => p.id === i.platform)?.fields ?? [];
    const publicKeys = fields.filter((f) => f.type !== "password").map((f) => f.key);
    const secretKeys = fields.filter((f) => f.type === "password").map((f) => f.key);
    return {
      id: i.id,
      clientId: i.clientId,
      platform: i.platform,
      accountName: i.accountName,
      autoPublish: i.autoPublish,
      status: i.status,
      method: i.method,
      credentials: Object.fromEntries(
        publicKeys
          .filter((k) => i.credentials?.[k] !== undefined)
          .map((k) => [k, i.credentials[k]]),
      ),
      secretsSet: secretKeys.filter((k) => !!i.credentials?.[k]),
    };
  });
}
