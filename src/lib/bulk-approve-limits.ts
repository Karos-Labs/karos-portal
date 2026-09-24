/**
 * The most drafts one press may approve.
 *
 * Past this the reviewer is not reviewing, and every row is a Firestore write
 * plus a possible platform call. Its own module because `bulk-approve-actions`
 * is `"use server"`, where every export is a public endpoint — a constant
 * exported from there is a server action that returns a number.
 */
export const MAX_BULK_APPROVE = 25;
