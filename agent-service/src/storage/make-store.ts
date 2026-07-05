import type { ServiceConfig } from "../config.js";
import type { ArtifactStore } from "./artifact-store.js";
import { LocalArtifactStore } from "./local.js";
import { GcsArtifactStore } from "./gcs.js";

export function makeArtifactStore(config: ServiceConfig): ArtifactStore {
  if (config.artifactStore === "gcs") {
    if (!config.gcsBucket) throw new Error("gcsBucket missing");
    return new GcsArtifactStore(config.gcsBucket, config.artifactsDir);
  }
  return new LocalArtifactStore(config.artifactsDir, config.publicBaseUrl);
}
