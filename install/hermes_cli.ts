// The Hermes CLI helpers live beside the skill scripts, which run on a box
// without install/ (skills/index-network/scripts/hermes-cli.ts); the
// installer's modules import them from here.
export { hermesBin, hermesExecEnv, hermesRunner } from "../skills/index-network/scripts/hermes-cli";
