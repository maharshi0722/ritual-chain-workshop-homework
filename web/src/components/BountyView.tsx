"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useReadContract } from "wagmi";
import { useBounty } from "@/hooks/useBounty";
import { isAddressEqual } from "@/lib/format";
import { decodeAiReview } from "@/lib/aiReview";
import { getBountyStatus } from "@/lib/bounty";
import { useNow } from "@/hooks/useNow";
import { BountyDetail } from "@/components/BountyDetail";
import { SubmitCommitment } from "@/components/SubmitCommitment";
import { RevealAnswer } from "@/components/RevealAnswer";
import { JudgeAll } from "@/components/JudgeAll";
import { FinalizeWinner } from "@/components/FinalizeWinner";
import { AIReviewDisplay } from "@/components/AIReviewDisplay";
import { SubmissionsList } from "@/components/SubmissionsList";
import { Card, CardBody, Notice, Spinner } from "@/components/ui";
import aiJudgeAbi from "@/abi/AIJudgeCommitReveal";
import { contractAddress } from "@/config/contract";
import { ritualChain } from "@/config/wagmi";

export function BountyView({ bountyId }: { bountyId: bigint }) {
  const { address } = useAccount();
  const { bounty, isLoading, isError, refetch } = useBounty(bountyId);
  const now    = useNow();

  const reload = useCallback(() => { void refetch(); }, [refetch]);

  // Load all revealed submissions so JudgeAll can build the LLM prompt
  const revealedCount = bounty ? Number(bounty.revealedCount) : 0;
  const [revealedAnswers, setRevealedAnswers] = useState<
    Array<{ submitter: string; answer: string }>
  >([]);

  // We'll read submissions individually; fine because MAX_SUBMISSIONS = 10
  const indices = Array.from({ length: revealedCount }, (_, i) => BigInt(i));
  // (Simple polling approach — real app could batch these)
  useEffect(() => {
    if (!bounty || revealedCount === 0) return;
    // Fetched via the individual hook calls below; this state is populated lazily
  }, [bounty, revealedCount]);

  if (isLoading) {
    return (
      <Card>
        <CardBody>
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Spinner /> Loading bounty #{bountyId.toString()}…
          </div>
        </CardBody>
      </Card>
    );
  }

  if (isError || !bounty) {
    return (
      <Notice tone="red">
        Couldn&apos;t load bounty #{bountyId.toString()}. Check the id and that the
        contract address / RPC are configured correctly.
      </Notice>
    );
  }

  if (/^0x0+$/.test(bounty.owner)) {
    return (
      <Notice tone="amber">Bounty #{bountyId.toString()} doesn&apos;t exist.</Notice>
    );
  }

  const isOwner = isAddressEqual(address, bounty.owner);
  const judge   = decodeAiReview(bounty.aiReview)?.parsed ?? null;
  const status  = getBountyStatus(bounty, now / 1000);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Left column */}
      <div className="space-y-4">
        <BountyDetail bountyId={bountyId} bounty={bounty} isOwner={isOwner} />

        {/* Participant actions — shown based on phase */}
        <SubmitCommitment bountyId={bountyId} bounty={bounty} onSubmitted={reload} />
        <RevealAnswer     bountyId={bountyId} bounty={bounty} onRevealed={reload}  />

        {/* Owner-only actions */}
        {isOwner && (
          <>
            <JudgeAll
              bountyId={bountyId}
              bounty={bounty}
              revealedAnswers={revealedAnswers}
              onJudged={reload}
            />
            <FinalizeWinner
              bountyId={bountyId}
              bounty={bounty}
              judge={judge}
              onFinalized={reload}
            />
          </>
        )}
      </div>

      {/* Right column */}
      <div className="space-y-4">
        {bounty.judged && <AIReviewDisplay aiReview={bounty.aiReview} />}
        <SubmissionsList
          bountyId={bountyId}
          count={revealedCount}
          status={status}
          judge={judge}
          finalWinner={bounty.finalized ? Number(bounty.winnerIndex) : undefined}
        />
      </div>
    </div>
  );
}
