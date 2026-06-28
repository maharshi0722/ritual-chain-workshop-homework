import type { Address } from "viem";

// ─── Commit-Reveal Bounty type ─────────────────────────────────────────────

/** Parsed shape of the `getBounty` tuple return from AIJudgeCommitReveal. */
export type Bounty = {
  owner:              Address;
  title:              string;
  rubric:             string;
  reward:             bigint;
  submissionDeadline: bigint;   // Was `deadline` in original contract
  revealDeadline:     bigint;   // New: reveal phase deadline
  judged:             boolean;
  finalized:          boolean;
  revealedCount:      bigint;   // Was `submissionCount` (now only counts revealed)
  winnerIndex:        bigint;
  aiReview:           `0x${string}`;
};

/** getBounty returns a positional tuple — map it to a named object. */
export function parseBounty(
  raw: readonly [
    Address,
    string,
    string,
    bigint,
    bigint,
    bigint,
    boolean,
    boolean,
    bigint,
    bigint,
    `0x${string}`,
  ],
): Bounty {
  const [
    owner,
    title,
    rubric,
    reward,
    submissionDeadline,
    revealDeadline,
    judged,
    finalized,
    revealedCount,
    winnerIndex,
    aiReview,
  ] = raw;
  return {
    owner,
    title,
    rubric,
    reward,
    submissionDeadline,
    revealDeadline,
    judged,
    finalized,
    revealedCount,
    winnerIndex,
    aiReview,
  };
}

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Bounty status covers the new three-phase lifecycle:
 *   committing → revealing → judging_ready → judged → finalized
 */
export type BountyStatus =
  | "committing"      // Before submissionDeadline — participants submit hashes
  | "revealing"       // After submissionDeadline, before revealDeadline — reveal phase
  | "judging_ready"   // After revealDeadline, not yet judged
  | "judged"
  | "finalized";

export function getBountyStatus(b: Bounty, nowSeconds = Date.now() / 1000): BountyStatus {
  if (b.finalized) return "finalized";
  if (b.judged)    return "judged";
  const sub = Number(b.submissionDeadline);
  const rev = Number(b.revealDeadline);
  if (nowSeconds < sub) return "committing";
  if (nowSeconds < rev) return "revealing";
  return "judging_ready";
}

export const STATUS_META: Record<
  BountyStatus,
  { label: string; tone: "green" | "amber" | "indigo" | "zinc" | "sky" }
> = {
  committing:    { label: "Commit phase open",  tone: "green"  },
  revealing:     { label: "Reveal phase open",  tone: "sky"    },
  judging_ready: { label: "Ready for judging",  tone: "amber"  },
  judged:        { label: "Judged",             tone: "indigo" },
  finalized:     { label: "Finalized",          tone: "zinc"   },
};

/** Can a participant still submit a commitment? */
export function canCommit(b: Bounty, nowSeconds = Date.now() / 1000): boolean {
  return !b.judged && !b.finalized && nowSeconds < Number(b.submissionDeadline);
}

/** Can a participant reveal their answer right now? */
export function canReveal(b: Bounty, nowSeconds = Date.now() / 1000): boolean {
  return (
    !b.judged &&
    !b.finalized &&
    nowSeconds >= Number(b.submissionDeadline) &&
    nowSeconds < Number(b.revealDeadline)
  );
}

/** Is the bounty ready for the owner to call judgeAll? */
export function canJudge(b: Bounty, nowSeconds = Date.now() / 1000): boolean {
  return !b.judged && !b.finalized && nowSeconds >= Number(b.revealDeadline);
}

// Keep backwards-compatible export so older references don't break during migration.
export const canSubmit = canCommit;
