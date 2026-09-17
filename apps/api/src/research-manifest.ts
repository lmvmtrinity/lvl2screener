import { freezeResearchManifest } from "./backtests/research-manifest.js";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("Usage: research-manifest <plan.json> <new-manifest.json>");
  process.exitCode = 1;
} else {
  try {
    const manifest = await freezeResearchManifest(args[0]!, args[1]!);
    console.log(
      JSON.stringify({ sha256: manifest.sha256, coverage: manifest.coverage }),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Manifest creation failed",
    );
    process.exitCode = 1;
  }
}
