"use server";

import { getCustomAgent, listJobs } from "@/lib/data";
import { CREDIT_COSTS } from "@/lib/credits";
import { calibrateLaunchPrice, type LaunchCalibration } from "@/lib/credit-reporting";
import { requireStaff } from "./_shared";

/**
 * What a setup run actually costs relative to a normal run, measured across
 * EVERY client this lab agent has run for (§6.3).
 *
 * On demand rather than on render, deliberately. The measurement is
 * cross-client by definition — one client rarely has enough launches to mean
 * anything — and the only way to read jobs across clients is a full-collection
 * scan. Paying for that on every staff page load, to render a number nobody
 * asked for yet, is the wrong trade; a staff member pressing "measure" is a
 * clear signal that they want it now.
 *
 * Staff-only: this is USD cost data, not a client-facing number.
 */
export async function getLaunchCalibrationAction(
  customAgentId: string,
): Promise<{ calibration?: LaunchCalibration; creditCost?: number; error?: string }> {
  await requireStaff();
  const agent = await getCustomAgent(customAgentId);
  if (!agent) return { error: "Agent not found." };

  // Every job this agent has ever run, for any client. `customAgentId` is the
  // authoritative link on modern jobs; historic ones matched by name only, and
  // those are exactly the untyped runs the calibration already excludes, so
  // there is nothing to recover by matching loosely here.
  const jobs = (await listJobs()).filter((job) => job.customAgentId === customAgentId);
  const creditCost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  return { calibration: calibrateLaunchPrice({ jobs, creditCost }), creditCost };
}
