"use client";

/**
 * SubmitCommitment — commit phase UI.
 *
 * The participant types their answer and an optional salt. The component
 * computes the commitment hash client-side (keccak256 of answer + salt +
 * sender + bountyId) and submits ONLY the hash to the contract.
 *
 * The plaintext answer is stored in localStorage keyed by bountyId so the
 * participant can reveal it in the next phase without re-typing it.
 */

import { useState } from "react";
import { useAccount } from "wagmi";
import { keccak256, encodePacked, hexlify, randomBytes } from "viem";
import aiJudgeAbi from "@/abi/AIJudgeCommitReveal";
import { contractAddress } from "@/config/contract";
import { ritualChain } from "@/config/wagmi";
import { canCommit, type Bounty } from "@/lib/bounty";
import { useNow } from "@/hooks/useNow";
import { useWriteTx } from "@/hooks/useWriteTx";
import {
  Card,
  CardHeader,
  CardBody,
  Field,
  Textarea,
  Button,
  TxStatus,
  Notice,
} from "@/components/ui";

const explorerBase = ritualChain.blockExplorers?.default.url;

function localKey(bountyId: bigint) {
  return `commit-reveal:${bountyId.toString()}`;
}

export function SubmitCommitment({
  bountyId,
  bounty,
  onSubmitted,
}: {
  bountyId: bigint;
  bounty: Bounty;
  onSubmitted: () => void;
}) {
  const { address, isConnected } = useAccount();
  const [answer, setAnswer]   = useState("");
  const [saved,  setSaved]    = useState(false);
  const now = useNow();
  const tx = useWriteTx(() => {
    setSaved(true);
    onSubmitted();
  });

  if (!canCommit(bounty, now / 1000)) return null;

  async function handleCommit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim() || !contractAddress || !address) return;

    // Generate a random 32-byte salt
    const salt = hexlify(randomBytes(32)) as `0x${string}`;

    // Compute commitment = keccak256(answer, salt, sender, bountyId)
    const commitment = keccak256(
      encodePacked(
        ["string", "bytes32", "address", "uint256"],
        [answer.trim(), salt, address, bountyId]
      )
    );

    // Persist answer + salt so the user can reveal later
    localStorage.setItem(
      localKey(bountyId),
      JSON.stringify({ answer: answer.trim(), salt })
    );

    try {
      await tx.run({
        address: contractAddress,
        abi: aiJudgeAbi,
        functionName: "submitCommitment",
        args: [bountyId, commitment],
        chainId: ritualChain.id,
      });
    } catch {
      /* surfaced via tx.state */
    }
  }

  return (
    <Card>
      <CardHeader
        title="Submit a commitment"
        subtitle="Your answer stays hidden until the reveal phase. We store it locally so you can reveal later."
      />
      <CardBody>
        <form onSubmit={handleCommit} className="space-y-3">
          <Notice tone="amber">
            <strong>Privacy note:</strong> your answer is <em>not</em> sent to the blockchain yet.
            Only a hash is stored on-chain. Make sure you reveal before the reveal deadline.
          </Notice>

          <Field label="Your answer">
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              placeholder="Write your full submission here…"
            />
          </Field>

          <Button
            type="submit"
            disabled={!isConnected || !answer.trim() || tx.isBusy}
            className="w-full"
          >
            {tx.isBusy ? "Committing…" : "Commit answer (hidden)"}
          </Button>

          {!isConnected && (
            <p className="text-xs text-zinc-500">Connect your wallet to commit.</p>
          )}

          <TxStatus
            state={tx.state}
            error={tx.error}
            hash={tx.hash}
            explorerBase={explorerBase}
          />

          {saved && (
            <Notice tone="green">
              Commitment recorded. Your answer is saved locally — come back during the reveal phase to
              submit it.
            </Notice>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
