import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNodeTelemetry } = await import("./instrumentation.node");
    await startNodeTelemetry();
  }
}

/**
 * Structured stderr line for uncaught request errors — feeds Cloud Logging →
 * bi_logs_export. `error` is typed `unknown` by Next's actual runtime type
 * (InstrumentationOnRequestError) despite the docs describing it as
 * `{ digest: string } & Error` — narrow defensively rather than trust that.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { logStructured } = await import("@/lib/telemetry/structured-log");
  const message = error instanceof Error ? error.message : String(error);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  logStructured("ERROR", message, {
    digest,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
  });
};
