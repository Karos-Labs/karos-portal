import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Direct-to-Cloud-Trace export — no OTel Collector (Phase 2 plan decision).
 * No-ops without GOOGLE_CLOUD_PROJECT (local dev): TraceExporter would still
 * try ADC and fail per-export, so skip starting the SDK entirely instead of
 * spamming stderr on every request.
 *
 * "environment" reuses the same prep/prod signal FIRESTORE_DATABASE_ID
 * already carries (see src/lib/firebase/admin.ts) rather than introducing a
 * new env var — "prep" named database vs. the project's "(default)".
 */
if (process.env.GOOGLE_CLOUD_PROJECT) {
  const environment = process.env.FIRESTORE_DATABASE_ID === "prep" ? "prep" : "prod";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "karos-cmo",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }),
    spanProcessor: new BatchSpanProcessor(
      new TraceExporter({ projectId: process.env.GOOGLE_CLOUD_PROJECT }),
    ),
  });
  sdk.start();
}
