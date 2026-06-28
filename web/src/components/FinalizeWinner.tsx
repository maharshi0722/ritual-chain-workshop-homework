"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import aiJudgeAbi from "@/abi/AIJudgeCommitReveal";
import { contractAddress } from "@/config/contract";
import { ritualChain } from "@/config/wagmi";
import type { Bounty } from "@/lib/bounty";
import { useWriteTx } from "@/hooks/useWriteTx";
import type { JudgeResult } from "@/lib/aiReview";
import { Card, CardHeader, CardBody, Field, Input, Button, TxStatus, Notice } from "@/components/ui";

const explorerBase = ritualChain.blockExplorers?.default.url;

export function FinalizeWinner({
  bountyId,
  bounty,
  judge,
  onFinalized,
}: {
  bountyId: bigint;
  bounty: Bounty;
  judge?: JudgeResult | null;
  onFinalized: () => void;
}) {
  const { isConnected } = useAccount();
  const [winnerIndex, setWinnerIndex] = useState(
    judge?.winnerIndex !== undefined ? String(judge.winnerIndex) : ""
  );
  const tx = useWriteTx(() => onFinalized());

  if (!bounty.judged || bounty.finalized) return null;

  async function handleFinalize(e: React.FormEvent) {
    e.preventDefault();
    const idx = parseInt(winnerIndex, 10);
    if (!Number.isFinite(idx) || idx < 0 || !contractAddress) return;
    try {
      await tx.run({
        address: contractAddress,
        abi: aiJudgeAbi,
        functionName: "finalizeWinner",
        args: [bountyId, BigInt(idx)],
        chainId: ritualChain.id,
      });
    } catch { /* surfaced via tx.state */ }
  }

  return (
    <Card>
      <CardHeader
        title="Finalize winner"
        subtitle="Review the AI recommendation, then pay out the reward."
      />
      <CardBody>
        {judge?.winnerIndex !== undefined && (
          <Notice tone="indigo">
            AI recommends submission <strong>#{judge.winnerIndex}</strong>.{" "}
            {judge.summary}
          </Notice>
        )}
        <form onSubmit={handleFinalize} className="mt-3 space-y-3">
          <Field label="Winner index" hint="Index from the revealed submissions list.">
            <Input
              type="number"
              min="0"
              value={winnerIndex}
              onChange={(e) => setWinnerIndex(e.target.value)}
              placeholder="0"
            />
          </Field>
          <Button
            type="submit"
            disabled={!isConnected || !winnerIndex || tx.isBusy}
            className="w-full"
          >
            {tx.isBusy ? "Finalizing…" : "Finalize & pay winner"}
          </Button>
          <TxStatus state={tx.state} error={tx.error} hash={tx.hash} explorerBase={explorerBase} />
        </form>
      </CardBody>
    </Card>
  );
}
