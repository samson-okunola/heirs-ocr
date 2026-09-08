import { assertRequiredEnv } from "@/lib/env";

/**
 * Runs once when the server starts, before any request is handled. Config problems
 * belong here: a missing variable should stop the process with a message naming the
 * file to create, not surface later as a confusing proxy failure.
 */
export function register(): void {
  // Only the Node runtime reads the filesystem-backed env; the edge runtime gets a
  // different (smaller) process.env and would report false positives here.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  assertRequiredEnv();
}
