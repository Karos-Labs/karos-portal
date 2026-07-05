import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeStringEqual } from "./webhooks/sign.js";

/**
 * App-level service token header. Kept OFF `Authorization` on purpose: when the
 * service runs behind Cloud Run IAM (--no-allow-unauthenticated), the platform
 * sends a Google-signed ID token in `Authorization` (validated + consumed by
 * the Cloud Run edge). The app token rides its own header so both layers coexist
 * ("IAM + bearer"). Falls back to `Authorization: Bearer` for local dev, where
 * there is no IAM in front and existing tooling still uses it.
 */
export const SERVICE_TOKEN_HEADER = "x-karos-service-token";

export function makeBearerAuth(tokens: string[]) {
  return async function bearerAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const custom = request.headers[SERVICE_TOKEN_HEADER];
    const authz = request.headers.authorization;
    const token =
      (typeof custom === "string" && custom.length > 0 && custom) ||
      (authz?.startsWith("Bearer ") ? authz.slice("Bearer ".length) : undefined);
    if (!token || !tokens.some((t) => timingSafeStringEqual(t, token))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
