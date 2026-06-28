# Privacy-Preserving AI Bounty Judge

## Overview

This repository extends the Ritual Workshop AI Bounty Judge with a **commit-reveal** scheme so that answers stay hidden during the submission phase. Later participants can never read earlier submissions and copy them — only hashes are public until the reveal phase is over.

---

## New Bounty Lifecycle

```
Create bounty
  │ (reward locked in contract)
  ▼
Phase 1 – Commit  (before submissionDeadline)
  Each participant calls submitCommitment(bountyId, hash)
  hash = keccak256(answer + salt + senderAddress + bountyId)
  The real answer never touches the chain in this phase.
  │
  ▼ submissionDeadline passes
Phase 2 – Reveal  (before revealDeadline)
  Each participant calls revealAnswer(bountyId, answer, salt)
  The contract verifies keccak256(answer, salt, sender, bountyId) == stored hash.
  Valid reveals are appended to the submissions array for judging.
  │
  ▼ revealDeadline passes
Phase 3 – Judge  (owner only)
  Owner calls judgeAll(bountyId, llmInput)
  Ritual AI evaluates ALL revealed answers in one batch request.
  Result stored as aiReview on-chain.
  │
  ▼
Phase 4 – Finalize  (owner only)
  Owner calls finalizeWinner(bountyId, winnerIndex)
  Contract pays bounty reward to the winner's address.
```

---

## Contracts

| File | Description |
|------|-------------|
| `hardhat/contracts/AIJudgeCommitReveal.sol` | New commit-reveal contract (homework) |
| `hardhat/contracts/AIJudge.sol` | Original workshop contract (public submissions) |

### Key functions

```solidity
// Phase 1
function submitCommitment(uint256 bountyId, bytes32 commitment) external;

// Phase 2
function revealAnswer(uint256 bountyId, string calldata answer, bytes32 salt) external;

// Phase 3 (owner only, after revealDeadline)
function judgeAll(uint256 bountyId, bytes calldata llmInput) external;

// Phase 4 (owner only, after judging)
function finalizeWinner(uint256 bountyId, uint256 winnerIndex) external;
```

### Commitment formula

```solidity
bytes32 commitment = keccak256(
    abi.encodePacked(answer, salt, msg.sender, bountyId)
);
```

Including `msg.sender` and `bountyId` prevents replay attacks where an attacker copies another participant's commitment and submits it as their own.

---

## Tests

```bash
cd hardhat
pnpm install
pnpm hardhat test
```

The test file at `hardhat/test/AIJudgeCommitReveal.test.ts` covers:

- **Valid commit** → CommitmentSubmitted event emitted, hasCommitted returns true
- **Double commit** → reverts with "already committed"
- **Empty commitment** → reverts with "empty commitment"
- **Commit after deadline** → reverts with "submission phase closed"
- **Valid reveal** → AnswerRevealed event emitted, answer stored on-chain
- **Wrong answer** → reverts with "commitment mismatch"
- **Wrong salt** → reverts with "commitment mismatch"
- **Double reveal** → reverts with "no commitment found"
- **Reveal without commitment** → reverts with "no commitment found"
- **Reveal before submission deadline** → reverts with "reveal phase not started"
- **judgeAll/finalizeWinner** → documented as a test plan (requires Ritual testnet)

---

## Architecture Note — Commit-Reveal vs Ritual-Native Encrypted Submissions

### Commit-reveal (Required Track — implemented here)

**How it works:** Participants hash their answer off-chain and submit only the hash. After the submission window closes they reveal the plaintext. The contract verifies the hash, then allows the AI to judge all revealed answers together.

**Privacy boundary:** Answers are hidden *during the submission phase*. Once the reveal phase opens and a participant calls `revealAnswer`, their answer is public on-chain — before AI judging happens. Any participant who revealed early can be seen by other participants who haven't revealed yet.

**Strengths:** Works on any EVM chain, no trusted third party, deterministic verification.

**Limitation:** Answers become public before judging concludes. A late revealer could theoretically tailor their reveal strategy (though not their answer, which was committed).

---

### Ritual-Native Encrypted Submissions (Advanced Track — design)

**How it works:**

1. Each participant encrypts their answer for the Ritual TEE executor's public key before submitting. Only the ciphertext (or an IPFS reference to the ciphertext) is stored on-chain.
2. The contract stores `encryptedAnswerRef` + `encryptedAnswerHash` per submission.
3. When the owner calls `judgeAll()`, the Ritual TEE executor:
   - Decrypts all submissions *inside* the TEE (plaintext never leaves the secure enclave).
   - Passes the decrypted answers to the LLM in a single batch request.
   - Returns the AI judgement result, a winner index, and a `revealedAnswersHash` (hash of the plaintext bundle).
4. After judging, the plaintext bundle can be published (e.g. to IPFS) so the community can verify the AI's work. The on-chain `revealedAnswersHash` acts as the commitment.

**What is stored where:**

| Data | Location |
|------|----------|
| Ciphertext of each answer | On-chain (small) or IPFS (large) |
| Hash of ciphertext | On-chain |
| Plaintext answers during judging | TEE memory only |
| AI review output | On-chain |
| Final plaintext bundle (post-judging) | IPFS, hash committed on-chain |

**Privacy boundary:** Plaintext answers are *never* public until after judging is complete. This is a strictly stronger guarantee than commit-reveal.

**Strengths:** Even the bounty owner cannot read submissions before judging. The AI is the first entity that sees all answers together.

**Diagram:**

```
Participant
  │ encrypt(answer, TEE_pubkey)
  ▼
Contract: store ciphertext / IPFS ref
                │
  ── reveal deadline passes ──
                │
                ▼
Owner → judgeAll()
                │
                ▼
        Ritual TEE Executor
         ┌──────────────────────┐
         │ decrypt(ciphertexts) │
         │ → LLM(all answers)   │
         │ → result + hash      │
         └──────────────────────┘
                │
                ▼
Contract: store aiReview, revealedAnswersHash
                │
                ▼
Owner → finalizeWinner(winnerIndex)
Winner paid, plaintext bundle published to IPFS
```

---

## Reflection

**What should be public, hidden, and AI-decided vs human-decided in a bounty system?**

The rubric and bounty title should always be public — participants cannot write relevant answers without knowing what is being judged. The reward amount should also be public so participants can assess whether the effort is worthwhile. However, individual answers must stay hidden until submissions close; if earlier answers are visible, later participants gain an unfair information advantage, which undermines the purpose of a competition.

The AI is well-suited to the mechanical task of scoring answers against the rubric consistently and at scale. It removes human bias from the ranking step and can process all answers in a single pass without favoring any individual. However, the final payout decision — who receives the reward — should always require human (owner) confirmation. The AI output is a recommendation, not a binding instruction; the owner verifies it makes sense before calling `finalizeWinner`. This human-in-the-loop step is important both for catching edge cases (e.g. the AI misreads an answer) and for assigning legal and ethical responsibility clearly to a human who signed the transaction.

In short: public rubric, hidden answers, AI-ranked results, human-finalized winner.

---

## Deploying

```bash
cd hardhat
cp .env.example .env   # add PRIVATE_KEY and RPC_URL
pnpm hardhat ignition deploy ignition/modules/AIJudge.ts --network ritual
```

Set `NEXT_PUBLIC_CONTRACT_ADDRESS` in `web/.env.local` to the deployed address, then:

```bash
cd web
pnpm install
pnpm dev
```
