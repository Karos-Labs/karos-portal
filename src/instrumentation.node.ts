import { gcpDetector } from "@opentelemetry/resource-detector-gcp";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { GoogleAuth } from "google-auth-library";

/**
 * Google Cloud's native OTLP endpoint for Cloud Trace — the replacement for
 * the archived `@google-cloud/opentelemetry-cloud-trace-exporter` package
 * (deprecated, archived after 2026-10-30; see
 * https://github.com/GoogleCloudPlatform/opentelemetry-operations-js/blob/main/MIGRATION.md).
 * Still direct-to-Cloud-Trace, no Collector (Phase 2 plan decision) — OTLP
 * doesn't require one, it's just a different wire format/endpoint.
 */
const TELEMETRY_OTLP_TRACES_ENDPOINT = "https://telemetry.googleapis.com/v1/traces";

/**
 * Unlike the old TraceExporter (which handled GCP auth internally via
 * google-auth-library), a standard OTLP exporter has no built-in notion of
 * Google credentials — the migration guide's documented pattern is an async
 * `headers()` callback that re-fetches a fresh bearer token from ADC on
 * every export (OAuth2 tokens expire hourly; `authClient.getRequestHeaders()`
 * handles the caching/refresh internally, so `getClient()` is only called
 * once here, not per export).
 *
 * No-ops without GOOGLE_CLOUD_PROJECT (local dev) — skips even attempting
 * ADC instead of failing per-export and spamming stderr.
 */
export async function startNodeTelemetry(): Promise<void> {
  if (!process.env.GOOGLE_CLOUD_PROJECT) return;

  // "environment" reuses the same prep/prod signal FIRESTORE_DATABASE_ID
  // already carries (see src/lib/firebase/admin.ts) rather than introducing
  // a new env var — "prep" named database vs. the project's "(default)".
  const environment = process.env.FIRESTORE_DATABASE_ID === "prep" ? "prep" : "prod";

  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const authClient = await auth.getClient();

  const sdk = new NodeSDK({
    resourceDetectors: [gcpDetector],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "karos-cmo",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }),
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: TELEMETRY_OTLP_TRACES_ENDPOINT,
        async headers(): Promise<Record<string, string>> {
          const rawHeaders = await authClient.getRequestHeaders();
          return Object.fromEntries(rawHeaders.entries());
        },
      }),
    ),
  });
  sdk.start();

  // `BatchSpanProcessor` buffers ~5s of spans before exporting. Without this,
  // every span from the request that was executing when Cloud Run sends
  // SIGTERM on scale-down/redeploy — disproportionately the ones worth
  // having — sits in that buffer and is dropped when the process exits.
  // `void` because SIGTERM handlers can't block the runtime's own shutdown
  // sequence on this; shutdown() has its own internal export timeout.
  process.on("SIGTERM", () => {
    void sdk.shutdown();
  });
}
