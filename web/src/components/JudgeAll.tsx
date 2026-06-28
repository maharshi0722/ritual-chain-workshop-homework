"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import aiJudgeAbi from "@/abi/AIJudgeCommitReveal";
import { contractAddress } from "@/config/contract";
import { ritualChain } from "@/config/wagmi";
import { canJudge, type Bounty } from "@/lib/bounty";
import { useNow } from "@/hooks/useNow";
import { useWriteTx } from "@/hooks/useWriteTx";
import { buildLlmInput } from "@/lib/ritualLlm";
import { Card, CardHeader, CardBody, Button, TxStatus, Notice } from "@/components/ui";

const explorerBase = ritualChain.blockExplorers?.default.url;

export function JudgeAll({
  bountyId,
  bounty,
  revealedAnswers,
  onJudged,
}: {
  bountyId: bigint;
  bounty: Bounty;
  revealedAnswers: Array<{ submitter: string; answer: string }>;
  onJudged: () => void;
}) {
  const { isConnected } = useAccount();
  const now = useNow();
  const tx  = useWriteTx(() => onJudged());

  if (!canJudge(bounty, now / 1000)) return null;
  if (bounty.revealedCount === 0n)   return null;

  async function handleJudge() {
    if (!contractAddress) return;
    const llmInput = buildLlmInput(bounty.rubric, revealedAnswers);
    try {
      await tx.run({
        address: contractAddress,
        abi: aiJudgeAbi,
        functionName: "judgeAll",
        args: [bountyId, llmInput],
        chainId: ritualChain.id,
      });
    } catch { /* surfaced via tx.state */ }
  }

  return (
    <Card>
      <CardHeader
        title="Judge all submissions"
        subtitle={`${bounty.revealedCount} revealed answer(s) ready to be judged together.`}
      />
      <CardBody className="space-y-3">
        <Notice tone="indigo">
          Ritual AI will evaluate all revealed answers in a single batch request using your rubric.
          No answer has an unfair advantage — the commit phase kept them hidden.
        </Notice>
        <Button
          onClick={handleJudge}
          disabled={!isConnected || tx.isBusy}
          className="w-full"
        >
          {tx.isBusy ? "Judging…" : "Judge all answers (Ritual AI)"}
        </Button>
        <TxStatus state={tx.state} error={tx.error} hash={tx.hash} explorerBase={explorerBase} />
      </CardBody>
    </Card>
  );
}
