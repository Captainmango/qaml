#!/usr/bin/env bun
import { EXIT_ERROR, main } from "@/cli.ts";

// Thin entry: the CLI contract (commands, flags, output streams, exit codes)
// lives in src/cli.ts. `bun run qaml …` and `bun run index.ts …` both land
// here; main() returns the exit code instead of exiting so it stays testable.
main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_ERROR);
  });
