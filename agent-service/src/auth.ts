import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeStringEqual } from "./webhooks/sign.js";

export function makeBearerAuth(tokens: string[]) {
  return async function bearerAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token || !tokens.some((t) => timingSafeStringEqual(t, token))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
