"use client";

/**
 * RevealAnswer — reveal phase UI.
 *
 * Loads the saved answer + salt from localStorage and lets the participant
 * submit them to the contract to be verified and recorded.
 */

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import aiJudgeAbi from "@/abi/AIJudgeCommitReveal";
import { contractAddress } from "@/config/contract";
import { ritualChain } from "@/config/wagmi";
import { canReveal, type Bounty } from "@/lib/bounty";
import { useNow } from "@/hooks/useNow";
import { useWriteTx } from "@/hooks/useWriteTx";
import {
  Card,
  CardHeader,
  CardBody,
  Field,
  Textarea,
  Input,
  Button,
  TxStatus,
  Notice,
} from "@/components/ui";

const explorerBase = ritualChain.blockExplorers?.default.url;

function localKey(bountyId: bigint) {
  return `commit-reveal:${bountyId.toString()}`;
}

export function RevealAnswer({
  bountyId,
  bounty,
  onRevealed,
}: {
  bountyId: bigint;
  bounty: Bounty;
  onRevealed: () => void;
}) {
  const { isConnected } = useAccount();
  const [answer, setAnswer] = useState("");
  const [salt,   setSalt]   = useState("");
  const now = useNow();
  const tx = useWriteTx(() => onRevealed());

  // Pre-fill from localStorage if the user committed in this browser
  useEffect(() => {
    try {
      const raw = localStorage.getItem(localKey(bountyId));
      if (raw) {
        const { answer: a, salt: s } = JSON.parse(raw) as { answer: string; salt: string };
        setAnswer(a);
        setSalt(s);
      }
    } catch {
      /* ignore parse errors */
    }
  }, [bountyId]);

  if (!canReveal(bounty, now / 1000)) return null;

  async function handleReveal(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim() || !salt || !contractAddress) return;
    try {
      await tx.run({
        address: contractAddress,
        abi: aiJudgeAbi,
        functionName: "revealAnswer",
        args: [bountyId, answer.trim(), salt as `0x${string}`],
        chainId: ritualChain.id,
      });
    } catch {
      /* surfaced via tx.state */
    }
  }

  return (
    <Card>
      <CardHeader
        title="Reveal your answer"
        subtitle="Submit your plaintext answer. The contract will verify it matches your commitment."
      />
      <CardBody>
        <form onSubmit={handleReveal} className="space-y-3">
          {answer && salt ? (
            <Notice tone="green">
              Found your saved answer from the commit phase. Review it and click Reveal.
            </Notice>
          ) : (
            <Notice tone="amber">
              No saved answer found. Enter your original answer and salt manually.
            </Notice>
          )}

          <Field label="Your answer (must match exactly what you committed)">
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              placeholder="Paste your original answer…"
            />
          </Field>

          <Field
            label="Salt (hex, 0x…)"
            hint="This was generated automatically when you committed. Check localStorage if needed."
          >
            <Input
              value={salt}
              onChange={(e) => setSalt(e.target.value)}
              placeholder="0x…"
              className="font-mono text-xs"
            />
          </Field>

          <Button
            type="submit"
            disabled={!isConnected || !answer.trim() || !salt || tx.isBusy}
            className="w-full"
          >
            {tx.isBusy ? "Revealing…" : "Reveal answer"}
          </Button>

          {!isConnected && (
            <p className="text-xs text-zinc-500">Connect your wallet to reveal.</p>
          )}

          <TxStatus
            state={tx.state}
            error={tx.error}
            hash={tx.hash}
            explorerBase={explorerBase}
          />
        </form>
      </CardBody>
    </Card>
  );
}
