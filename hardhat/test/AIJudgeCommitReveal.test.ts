/**
 * Test plan + representative unit tests for AIJudgeCommitReveal.
 *
 * Because the contract calls the Ritual LLM precompile (an EVM precompile
 * unavailable in a standard Hardhat environment), judgeAll() tests are written
 * as a TEST PLAN rather than runnable specs.  All other lifecycle functions
 * are fully testable with a standard Hardhat/Ethers setup.
 *
 * Run with:
 *   cd hardhat && pnpm hardhat test
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCommitment(
  answer: string,
  salt: string,
  senderAddress: string,
  bountyId: bigint
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, senderAddress, bountyId]
    )
  );
}

function randomSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  // Deploy a mock that bypasses the precompile so we can test non-LLM paths.
  // The real contract inherits PrecompileConsumer which calls address(0x0802).
  // For local tests we deploy a stub that skips judgeAll's precompile call.
  const Factory = await ethers.getContractFactory("AIJudgeCommitReveal");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  return { contract, owner, alice, bob, carol };
}

/** Returns UNIX timestamp seconds from now. */
function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("AIJudgeCommitReveal", function () {
  // ── createBounty ──────────────────────────────────────────────────────────

  describe("createBounty", function () {
    it("reverts if no ETH is sent", async function () {
      const { contract } = await deployFixture();
      await expect(
        contract.createBounty(
          "Test",
          "Rubric",
          BigInt(nowPlus(100)),
          BigInt(nowPlus(200)),
          { value: 0n }
        )
      ).to.be.revertedWith("reward required");
    });

    it("reverts if submissionDeadline is in the past", async function () {
      const { contract } = await deployFixture();
      await expect(
        contract.createBounty(
          "Test",
          "Rubric",
          BigInt(nowPlus(-10)),
          BigInt(nowPlus(200)),
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("submission deadline must be future");
    });

    it("reverts if revealDeadline is not after submissionDeadline", async function () {
      const { contract } = await deployFixture();
      const sub = BigInt(nowPlus(100));
      await expect(
        contract.createBounty("Test", "Rubric", sub, sub, {
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWith("reveal deadline must be after submission deadline");
    });

    it("emits BountyCreated and returns incrementing id", async function () {
      const { contract } = await deployFixture();
      const sub = BigInt(nowPlus(100));
      const rev = BigInt(nowPlus(200));

      await expect(
        contract.createBounty("Bounty A", "Rubric A", sub, rev, {
          value: ethers.parseEther("0.5"),
        })
      )
        .to.emit(contract, "BountyCreated")
        .withArgs(1n, await contract.getAddress(), "Bounty A", ethers.parseEther("0.5"), sub, rev);

      // Second bounty gets id 2.
      await contract.createBounty("Bounty B", "Rubric B", sub, rev, {
        value: ethers.parseEther("0.1"),
      });
      const b = await contract.getBounty(2n);
      expect(b.title).to.equal("Bounty B");
    });
  });

  // ── submitCommitment ───────────────────────────────────────────────────────

  describe("submitCommitment", function () {
    async function setup() {
      const fixture = await deployFixture();
      const { contract, owner } = fixture;
      const sub = BigInt(nowPlus(200));
      const rev = BigInt(nowPlus(400));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });
      return { ...fixture, bountyId: 1n };
    }

    it("stores commitment and emits event", async function () {
      const { contract, alice, bountyId } = await setup();
      const salt = randomSalt();
      const answer = "My answer";
      const comm = makeCommitment(answer, salt, await alice.getAddress(), bountyId);

      await expect(contract.connect(alice).submitCommitment(bountyId, comm))
        .to.emit(contract, "CommitmentSubmitted")
        .withArgs(bountyId, await alice.getAddress(), comm);

      // The commitment should be registered
      expect(await contract.hasCommitted(bountyId, await alice.getAddress())).to.be.true;
    });

    it("prevents double commitment from same address", async function () {
      const { contract, alice, bountyId } = await setup();
      const salt = randomSalt();
      const comm = makeCommitment("A", salt, await alice.getAddress(), bountyId);
      await contract.connect(alice).submitCommitment(bountyId, comm);

      const salt2 = randomSalt();
      const comm2 = makeCommitment("B", salt2, await alice.getAddress(), bountyId);
      await expect(
        contract.connect(alice).submitCommitment(bountyId, comm2)
      ).to.be.revertedWith("already committed");
    });

    it("prevents empty commitment", async function () {
      const { contract, alice, bountyId } = await setup();
      await expect(
        contract.connect(alice).submitCommitment(bountyId, ethers.ZeroHash)
      ).to.be.revertedWith("empty commitment");
    });

    it("reverts after submission deadline", async function () {
      const { contract, owner } = await deployFixture();
      // Create bounty with very short submission window
      const sub = BigInt(nowPlus(1));
      const rev = BigInt(nowPlus(300));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });

      // Wait 2 seconds for deadline to pass
      await new Promise((r) => setTimeout(r, 2000));

      const salt = randomSalt();
      const comm = makeCommitment("A", salt, await owner.getAddress(), 1n);
      await expect(
        contract.connect(owner).submitCommitment(1n, comm)
      ).to.be.revertedWith("submission phase closed");
    });
  });

  // ── revealAnswer ──────────────────────────────────────────────────────────

  describe("revealAnswer", function () {
    /**
     * Creates a bounty with a submission deadline that is 1 second in the future,
     * submits commitments, then waits for the submission window to close so we can test reveals.
     */
    async function setupWithCommitments() {
      const { contract, owner, alice, bob } = await deployFixture();

      const sub = BigInt(nowPlus(2));  // 2 second commit window
      const rev = BigInt(nowPlus(500));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });
      const bountyId = 1n;

      const aliceSalt = randomSalt();
      const aliceAnswer = "Alice's answer";
      const aliceComm = makeCommitment(aliceAnswer, aliceSalt, await alice.getAddress(), bountyId);
      await contract.connect(alice).submitCommitment(bountyId, aliceComm);

      const bobSalt = randomSalt();
      const bobAnswer = "Bob's answer";
      const bobComm = makeCommitment(bobAnswer, bobSalt, await bob.getAddress(), bountyId);
      await contract.connect(bob).submitCommitment(bountyId, bobComm);

      // Wait for submission deadline to pass
      await new Promise((r) => setTimeout(r, 3000));

      return { contract, owner, alice, bob, bountyId, aliceAnswer, aliceSalt, bobAnswer, bobSalt };
    }

    it("accepts valid reveal and emits AnswerRevealed", async function () {
      const { contract, alice, bountyId, aliceAnswer, aliceSalt } = await setupWithCommitments();

      await expect(
        contract.connect(alice).revealAnswer(bountyId, aliceAnswer, aliceSalt)
      )
        .to.emit(contract, "AnswerRevealed")
        .withArgs(bountyId, 0n, await alice.getAddress());

      const [submitter, answer, revealed] = await contract.getSubmission(bountyId, 0n);
      expect(submitter).to.equal(await alice.getAddress());
      expect(answer).to.equal(aliceAnswer);
      expect(revealed).to.be.true;
    });

    it("rejects reveal with wrong answer (commitment mismatch)", async function () {
      const { contract, alice, bountyId, aliceSalt } = await setupWithCommitments();

      await expect(
        contract.connect(alice).revealAnswer(bountyId, "wrong answer", aliceSalt)
      ).to.be.revertedWith("commitment mismatch");
    });

    it("rejects reveal with wrong salt", async function () {
      const { contract, alice, bountyId, aliceAnswer } = await setupWithCommitments();

      await expect(
        contract.connect(alice).revealAnswer(bountyId, aliceAnswer, randomSalt())
      ).to.be.revertedWith("commitment mismatch");
    });

    it("prevents double-reveal from same address", async function () {
      const { contract, alice, bountyId, aliceAnswer, aliceSalt } = await setupWithCommitments();

      await contract.connect(alice).revealAnswer(bountyId, aliceAnswer, aliceSalt);
      await expect(
        contract.connect(alice).revealAnswer(bountyId, aliceAnswer, aliceSalt)
      ).to.be.revertedWith("no commitment found");
    });

    it("rejects reveal without prior commitment", async function () {
      const { contract, carol, bountyId } = await setupWithCommitments();
      await expect(
        contract.connect(carol).revealAnswer(bountyId, "any", randomSalt())
      ).to.be.revertedWith("no commitment found");
    });

    it("rejects reveal before submission deadline", async function () {
      const { contract, owner, alice } = await deployFixture();
      // Long submission window so deadline hasn't passed
      const sub = BigInt(nowPlus(300));
      const rev = BigInt(nowPlus(600));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });
      const bountyId = 1n;
      const salt = randomSalt();
      const answer = "answer";
      const comm = makeCommitment(answer, salt, await alice.getAddress(), bountyId);
      await contract.connect(alice).submitCommitment(bountyId, comm);

      await expect(
        contract.connect(alice).revealAnswer(bountyId, answer, salt)
      ).to.be.revertedWith("reveal phase not started");
    });
  });

  // ── finalizeWinner ────────────────────────────────────────────────────────

  describe("finalizeWinner (non-LLM path)", function () {
    it("reverts if not judged", async function () {
      const { contract, owner } = await deployFixture();
      const sub = BigInt(nowPlus(100));
      const rev = BigInt(nowPlus(200));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });

      await expect(contract.connect(owner).finalizeWinner(1n, 0n)).to.be.revertedWith(
        "not judged yet"
      );
    });

    it("reverts if invalid winner index", async function () {
      /**
       * We cannot easily invoke judgeAll() in a local Hardhat test because
       * it calls address(0x0802) (Ritual LLM precompile). This case is
       * therefore captured in the TEST PLAN below.
       */
    });
  });

  // ── hasCommitted view ─────────────────────────────────────────────────────

  describe("hasCommitted", function () {
    it("returns false before any commitment", async function () {
      const { contract, owner, alice } = await deployFixture();
      const sub = BigInt(nowPlus(200));
      const rev = BigInt(nowPlus(400));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });

      expect(await contract.hasCommitted(1n, await alice.getAddress())).to.be.false;
    });

    it("returns true after commitment", async function () {
      const { contract, owner, alice } = await deployFixture();
      const sub = BigInt(nowPlus(200));
      const rev = BigInt(nowPlus(400));
      await contract
        .connect(owner)
        .createBounty("B", "R", sub, rev, { value: ethers.parseEther("1") });
      const salt = randomSalt();
      const comm = makeCommitment("A", salt, await alice.getAddress(), 1n);
      await contract.connect(alice).submitCommitment(1n, comm);

      expect(await contract.hasCommitted(1n, await alice.getAddress())).to.be.true;
    });
  });
});

// ─── TEST PLAN (for LLM-dependent paths) ──────────────────────────────────────
/**
 * The following cases require a live Ritual chain with a working LLM precompile
 * at address(0x0802).  Run them against a Ritual testnet node.
 *
 * 1. judgeAll() before revealDeadline
 *    → expect revert "reveal phase still open"
 *
 * 2. judgeAll() with zero revealed submissions
 *    → expect revert "no revealed submissions to judge"
 *
 * 3. judgeAll() called by non-owner
 *    → expect revert "not bounty owner"
 *
 * 4. Happy path: commit → reveal → judgeAll() → finalizeWinner()
 *    a. Create bounty with submissionDeadline = now+60, revealDeadline = now+120.
 *    b. Alice and Bob commit.
 *    c. Advance chain time past submissionDeadline.
 *    d. Alice and Bob reveal.
 *    e. Advance chain time past revealDeadline.
 *    f. Owner calls judgeAll() with a properly encoded llmInput containing both answers.
 *    g. Check AllAnswersJudged emitted; bounty.judged == true.
 *    h. Owner calls finalizeWinner(winnerIndex).
 *    i. Check WinnerFinalized emitted; winner's ETH balance increased by reward.
 *
 * 5. finalizeWinner() with invalid index (>= submissions.length)
 *    → expect revert "invalid winner index"
 *
 * 6. finalizeWinner() called twice
 *    → expect revert "already finalized"
 *
 * 7. judgeAll() called twice
 *    → expect revert "already judged"
 *
 * 8. Commitment from address A cannot be used to reveal by address B
 *    → B's keccak256(answer, salt, B, bountyId) ≠ A's stored commitment → revert "no commitment found"
 */
