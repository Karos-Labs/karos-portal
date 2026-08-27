/**
 * AU68 gate proof — DELIBERATELY BROKEN.
 *
 * This file exists to make CI red so we can observe branch protection refusing
 * a merge into main. A required status check that has never been seen blocking
 * anything is indistinguishable from no check at all.
 *
 * The PR carrying this is closed and the branch deleted immediately after the
 * refusal is observed. If you are reading this on a real branch, something went
 * wrong — delete it.
 */
export const gateProof: number = "this is a string, not a number";
