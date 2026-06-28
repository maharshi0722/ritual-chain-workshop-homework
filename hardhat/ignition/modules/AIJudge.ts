import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploy the commit-reveal version of the AI Bounty Judge.
 *
 * Usage:
 *   pnpm hardhat ignition deploy ignition/modules/AIJudge.ts --network ritual
 */
const AIJudgeModule = buildModule("AIJudgeCommitReveal", (m) => {
  const aiJudge = m.contract("AIJudgeCommitReveal");
  return { aiJudge };
});

export default AIJudgeModule;
