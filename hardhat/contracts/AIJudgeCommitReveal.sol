// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrecompileConsumer} from "./utils/PrecompileConsumer.sol";

/**
 * @title AIJudgeCommitReveal
 * @notice Privacy-preserving AI Bounty Judge using a commit-reveal scheme.
 *
 * Lifecycle:
 *   1. Owner creates a bounty with a submission deadline and a reveal deadline.
 *   2. Participants submit a commitment hash (keccak256 of answer + salt + sender + bountyId).
 *      Their real answer stays off-chain during this phase.
 *   3. After the submission deadline, participants reveal their answer + salt.
 *      The contract verifies the hash matches. Only verified reveals are eligible.
 *   4. After the reveal deadline, the owner calls judgeAll() — Ritual AI judges every
 *      revealed answer in one batch request.
 *   5. Owner calls finalizeWinner() with the index chosen from the AI review, paying the reward.
 *
 * Privacy guarantee: answers are never on-chain during the submission window, so
 * later entrants cannot copy earlier answers.
 */
contract AIJudgeCommitReveal is PrecompileConsumer {
    // ──────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────

    uint256 public constant MAX_SUBMISSIONS   = 10;
    uint256 public constant MAX_ANSWER_LENGTH = 2_000;

    // ──────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────

    uint256 public nextBountyId = 1;

    struct RevealedSubmission {
        address submitter;
        string  answer;
        bool    revealed;
    }

    struct Bounty {
        address owner;
        string  title;
        string  rubric;
        uint256 reward;
        uint256 submissionDeadline;  // Commit phase closes
        uint256 revealDeadline;      // Reveal phase closes; judging opens after this
        bool    judged;
        bool    finalized;
        bytes   aiReview;
        uint256 winnerIndex;
        // Commitments: participantAddress => commitment hash
        mapping(address => bytes32) commitments;
        // Ordered list of revealed submissions (populated during reveal phase)
        RevealedSubmission[] submissions;
        // Track who has already committed (to enforce one-per-address)
        mapping(address => bool) hasCommitted;
    }

    struct ConvoHistory {
        string storageType;
        string path;
        string secretsName;
    }

    mapping(uint256 => Bounty) public bounties;

    // ──────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        string title,
        uint256 reward,
        uint256 submissionDeadline,
        uint256 revealDeadline
    );

    /// @notice Emitted when a participant locks in their commitment hash.
    ///         The answer is NOT revealed at this point.
    event CommitmentSubmitted(
        uint256 indexed bountyId,
        address indexed submitter,
        bytes32 commitment
    );

    /// @notice Emitted when a valid reveal is accepted and stored for judging.
    event AnswerRevealed(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter
    );

    event AllAnswersJudged(uint256 indexed bountyId, bytes aiReview);

    event WinnerFinalized(
        uint256 indexed bountyId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 reward
    );

    // ──────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────

    modifier onlyOwner(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].owner, "not bounty owner");
        _;
    }

    modifier bountyExists(uint256 bountyId) {
        require(bounties[bountyId].owner != address(0), "bounty not found");
        _;
    }

    // ──────────────────────────────────────────────
    // Owner actions
    // ──────────────────────────────────────────────

    /**
     * @notice Create a new bounty.
     * @param submissionDeadline Unix timestamp when the commit phase ends.
     * @param revealDeadline     Unix timestamp when the reveal phase ends (must be > submissionDeadline).
     */
    function createBounty(
        string calldata title,
        string calldata rubric,
        uint256 submissionDeadline,
        uint256 revealDeadline
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(submissionDeadline > block.timestamp, "submission deadline must be future");
        require(revealDeadline > submissionDeadline, "reveal deadline must be after submission deadline");

        bountyId = nextBountyId++;
        Bounty storage bounty = bounties[bountyId];
        bounty.owner              = msg.sender;
        bounty.title              = title;
        bounty.rubric             = rubric;
        bounty.reward             = msg.value;
        bounty.submissionDeadline = submissionDeadline;
        bounty.revealDeadline     = revealDeadline;
        bounty.winnerIndex        = type(uint256).max;

        emit BountyCreated(
            bountyId,
            msg.sender,
            title,
            msg.value,
            submissionDeadline,
            revealDeadline
        );
    }

    // ──────────────────────────────────────────────
    // Participant actions
    // ──────────────────────────────────────────────

    /**
     * @notice Submit a commitment hash during the commit phase.
     * @dev    Build commitment off-chain:
     *         commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
     *         Including msg.sender and bountyId prevents commitment replay attacks.
     */
    function submitCommitment(
        uint256 bountyId,
        bytes32 commitment
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp < bounty.submissionDeadline, "submission phase closed");
        require(!bounty.judged,   "already judged");
        require(!bounty.finalized,"already finalized");
        require(!bounty.hasCommitted[msg.sender], "already committed");
        require(bounty.submissions.length < MAX_SUBMISSIONS, "too many submissions");
        require(commitment != bytes32(0), "empty commitment");

        bounty.commitments[msg.sender] = commitment;
        bounty.hasCommitted[msg.sender] = true;

        emit CommitmentSubmitted(bountyId, msg.sender, commitment);
    }

    /**
     * @notice Reveal your answer during the reveal phase.
     * @dev    The contract recomputes keccak256(answer, salt, msg.sender, bountyId)
     *         and checks it matches the stored commitment. On success, the answer is
     *         pushed into the submissions array and becomes eligible for judging.
     */
    function revealAnswer(
        uint256 bountyId,
        string calldata answer,
        bytes32 salt
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp >= bounty.submissionDeadline, "reveal phase not started");
        require(block.timestamp <  bounty.revealDeadline,     "reveal phase closed");
        require(!bounty.judged,    "already judged");
        require(!bounty.finalized, "already finalized");
        require(bounty.hasCommitted[msg.sender], "no commitment found");
        require(bytes(answer).length > 0,              "empty answer");
        require(bytes(answer).length <= MAX_ANSWER_LENGTH, "answer too long");

        // Verify commitment
        bytes32 expected = keccak256(
            abi.encodePacked(answer, salt, msg.sender, bountyId)
        );
        require(bounty.commitments[msg.sender] == expected, "commitment mismatch");

        // Prevent double-reveal: zero out the commitment slot
        bounty.commitments[msg.sender] = bytes32(0);
        bounty.hasCommitted[msg.sender] = false; // allow slot re-check in view functions

        uint256 idx = bounty.submissions.length;
        bounty.submissions.push(RevealedSubmission({
            submitter: msg.sender,
            answer:    answer,
            revealed:  true
        }));

        emit AnswerRevealed(bountyId, idx, msg.sender);
    }

    // ──────────────────────────────────────────────
    // Judging
    // ──────────────────────────────────────────────

    /**
     * @notice Judge all revealed submissions in one Ritual LLM batch call.
     * @dev    Only callable by the bounty owner after the reveal deadline.
     *         The owner is responsible for building llmInput that includes
     *         all revealed answers so the AI evaluates them together.
     */
    function judgeAll(
        uint256 bountyId,
        bytes calldata llmInput
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp >= bounty.revealDeadline, "reveal phase still open");
        require(!bounty.judged,    "already judged");
        require(!bounty.finalized, "already finalized");
        require(bounty.submissions.length > 0, "no revealed submissions to judge");

        bytes memory output = _executePrecompile(LLM_INFERENCE_PRECOMPILE, llmInput);

        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(output, (bool, bytes, bytes, string, ConvoHistory));

        require(!hasError, errorMessage);

        bounty.judged    = true;
        bounty.aiReview  = completionData;

        emit AllAnswersJudged(bountyId, completionData);
    }

    /**
     * @notice Owner finalizes the winner after judging. Pays the reward to the winner.
     * @param winnerIndex Index into the revealed submissions array recommended by the AI.
     */
    function finalizeWinner(
        uint256 bountyId,
        uint256 winnerIndex
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.judged,     "not judged yet");
        require(!bounty.finalized, "already finalized");
        require(winnerIndex < bounty.submissions.length, "invalid winner index");

        bounty.finalized   = true;
        bounty.winnerIndex = winnerIndex;

        address winner = bounty.submissions[winnerIndex].submitter;
        uint256 reward = bounty.reward;
        bounty.reward  = 0;

        (bool ok, ) = payable(winner).call{value: reward}("");
        require(ok, "payment failed");

        emit WinnerFinalized(bountyId, winnerIndex, winner, reward);
    }

    // ──────────────────────────────────────────────
    // View helpers
    // ──────────────────────────────────────────────

    function getBounty(
        uint256 bountyId
    )
        external
        view
        bountyExists(bountyId)
        returns (
            address owner,
            string memory title,
            string memory rubric,
            uint256 reward,
            uint256 submissionDeadline,
            uint256 revealDeadline,
            bool judged,
            bool finalized,
            uint256 revealedCount,
            uint256 winnerIndex,
            bytes memory aiReview
        )
    {
        Bounty storage b = bounties[bountyId];
        return (
            b.owner,
            b.title,
            b.rubric,
            b.reward,
            b.submissionDeadline,
            b.revealDeadline,
            b.judged,
            b.finalized,
            b.submissions.length,
            b.winnerIndex,
            b.aiReview
        );
    }

    /**
     * @notice Returns a revealed submission. Answers are only accessible once revealed.
     */
    function getSubmission(
        uint256 bountyId,
        uint256 index
    )
        external
        view
        bountyExists(bountyId)
        returns (address submitter, string memory answer, bool revealed)
    {
        Bounty storage bounty = bounties[bountyId];
        require(index < bounty.submissions.length, "invalid index");
        RevealedSubmission storage s = bounty.submissions[index];
        return (s.submitter, s.answer, s.revealed);
    }

    /**
     * @notice Check whether an address has submitted a commitment (without exposing the hash).
     */
    function hasCommitted(uint256 bountyId, address participant)
        external
        view
        bountyExists(bountyId)
        returns (bool)
    {
        return bounties[bountyId].commitments[participant] != bytes32(0);
    }
}
