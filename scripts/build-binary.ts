#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { Command, InvalidArgumentError } from "commander";

/**
 * Builds standalone QAML executables via `Bun.build({ compile: true })` so the
 * CLI and the MCP server run on machines without Bun installed.
 *
 *   bun run build                     # dist/qaml for this platform
 *   bun run build:mcp                 # dist/qaml-mcp
 *   bun run build:all                 # both
 *   bun run scripts/build-binary.ts --target bun-windows-x64   # cross-compile
 *
 * Two bundler quirks are handled here rather than in src/, because both come
 * from browser-use/playwright and only bite inside a compiled executable:
 *
 * 1. `browser-use/dist/dom/service.js` reads its DOM-extraction script from
 *    disk at module scope, next to itself. Inside an executable every module
 *    shares the entrypoint's virtual directory, so that path does not exist —
 *    the script text is inlined into the module at build time.
 * 2. `playwright-core` lazily `require()`s `chromium-bidi` for its BiDi
 *    transport. It is not installed (QAML connects over CDP through Steel), so
 *    the specifier is marked external instead of resolved.
 *
 * Everything else is plain bundling: no assets, no native addons. `canvas` and
 * the other heavy browser-use optional deps sit behind subpaths this project
 * never imports, so they stay out of the graph. Minification is deliberately
 * not offered: browser-use derives identifiers from function and class names at
 * runtime, so a minified bundle dies with `Event el does not end with Event`
 * before the first snapshot.
 *
 * CI: this script is the single build entry point for the eventual GitHub
 * Actions matrix — one job per OS calling `bun run build:all` (native target),
 * or a single job cross-compiling with `--target` per platform.
 */

const PROJECT_ROOT = resolve(import.meta.dir, "..");

/** Executables this script can produce, by entrypoint. */
const ENTRIES = {
  cli: { entrypoint: "index.ts", name: "qaml" },
  mcp: { entrypoint: "src/mcp/server.ts", name: "qaml-mcp" },
} as const;

type EntryId = keyof typeof ENTRIES;

const ENTRY_IDS = Object.keys(ENTRIES) as EntryId[];

/** Targets Bun can cross-compile for; see `bun build --help`. */
const KNOWN_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

const TARGET_PATTERN = /^bun-(darwin|linux|windows)-(x64|arm64)(-[a-z0-9]+)*$/;

interface BuildRequest {
  entries: EntryId[];
  target?: Bun.Build.CompileTarget;
  outDir: string;
  bytecode: boolean;
  verify: boolean;
}

/**
 * Inlines browser-use's DOM-extraction script into the module that reads it,
 * because that read cannot succeed from an executable's virtual filesystem.
 * Fails loudly if the upstream read changes shape (browser-use upgrade) rather
 * than shipping a binary that dies on the first snapshot.
 */
function inlineBrowserUseDomTree(): BunPlugin {
  const serviceFilter = /browser-use[\\/]dist[\\/]dom[\\/]service\.js$/;
  const domTreeRead =
    /const DOM_TREE_SCRIPT = [\s\S]*?new URL\(\s*['"]\.\/dom_tree\/index\.js['"],\s*import\.meta\.url\s*\)[\s\S]*?;/;

  return {
    name: "qaml-inline-browser-use-dom-tree",
    setup(build) {
      build.onLoad({ filter: serviceFilter }, async (args) => {
        const source = await Bun.file(args.path).text();
        const scriptPath = join(dirname(args.path), "dom_tree", "index.js");
        const script = await Bun.file(scriptPath).text();
        const contents = source.replace(
          domTreeRead,
          // Function form: the script text is full of `$` sequences that a
          // plain replacement string would interpret as patterns.
          () => `const DOM_TREE_SCRIPT = ${JSON.stringify(script)};`,
        );
        if (contents === source) {
          throw new Error(
            `browser-use's DOM tree script read no longer matches the expected shape in ${args.path} — update domTreeRead in scripts/build-binary.ts.`,
          );
        }
        return { contents, loader: "js" };
      });
    },
  };
}

/** Keeps playwright-core's optional BiDi transport out of the bundle. */
function externalizeChromiumBidi(): BunPlugin {
  return {
    name: "qaml-external-chromium-bidi",
    setup(build) {
      build.onResolve({ filter: /^chromium-bidi(\/|$)/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

function binaryName(entry: EntryId, target?: string): string {
  const { name } = ENTRIES[entry];
  return target?.startsWith("bun-windows") ? `${name}.exe` : name;
}

/** True when a build for `target` produces an executable this machine can run. */
function isHostTarget(target?: string): boolean {
  if (!target) return true;
  const { platform, arch } = process;
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return target.startsWith(`bun-${os}-${cpu}`);
}

async function buildBinary(
  entry: EntryId,
  request: BuildRequest,
): Promise<string> {
  const { entrypoint } = ENTRIES[entry];
  const outfile = resolve(
    PROJECT_ROOT,
    request.outDir,
    binaryName(entry, request.target),
  );
  await mkdir(dirname(outfile), { recursive: true });

  const startedAt = performance.now();
  const result = await Bun.build({
    entrypoints: [resolve(PROJECT_ROOT, entrypoint)],
    target: "bun",
    compile: request.target ? { target: request.target, outfile } : { outfile },
    bytecode: request.bytecode,
    plugins: [inlineBrowserUseDomTree(), externalizeChromiumBidi()],
  });

  if (!result.success) {
    const detail = result.logs
      .map((log) => String(log))
      .join("\n")
      .trim();
    throw new Error(`compiling ${entrypoint} failed:\n${detail}`);
  }

  const bytes = (await Bun.file(outfile).stat()).size;
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `built ${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MB, ${seconds}s${
      request.target ? `, ${request.target}` : ""
    })`,
  );
  return outfile;
}

/**
 * Runs a built executable to prove it boots: `--help` for the CLI (exit 0), and
 * an MCP `initialize` handshake for the server. Skipped when cross-compiling,
 * since the artifact cannot run here.
 */
async function verifyBinary(entry: EntryId, outfile: string): Promise<void> {
  if (entry === "cli") {
    const proc = Bun.spawn([outfile, "--help"], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${outfile} --help exited ${exitCode}:\n${stderr.trim()}`,
      );
    }
    return;
  }

  const proc = Bun.spawn([outfile], {
    cwd: PROJECT_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "qaml-build-verify", version: "0.0.0" },
    },
  };
  proc.stdin.write(`${JSON.stringify(request)}\n`);
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => proc.kill(), 15_000);
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('"result"')) break;
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
    proc.kill();
    await proc.exited.catch(() => {});
  }

  if (!buffered.includes('"result"')) {
    throw new Error(
      `${outfile} did not answer an MCP initialize request (got: ${buffered.trim() || "nothing"})`,
    );
  }
}

function parseTarget(value: string): Bun.Build.CompileTarget {
  const target = value.startsWith("bun-") ? value : `bun-${value}`;
  if (!TARGET_PATTERN.test(target)) {
    throw new InvalidArgumentError(
      `Unknown target "${value}". Known targets: ${KNOWN_TARGETS.join(", ")}.`,
    );
  }
  return target as Bun.Build.CompileTarget;
}

function parseEntries(value: string): EntryId[] {
  if (value === "all") return ENTRY_IDS;
  const wanted = value.split(",").map((part) => part.trim());
  for (const entry of wanted) {
    if (!ENTRY_IDS.includes(entry as EntryId)) {
      throw new InvalidArgumentError(
        `Unknown entry "${entry}". Expected one of: ${[...ENTRY_IDS, "all"].join(", ")}.`,
      );
    }
  }
  return wanted as EntryId[];
}

async function main(): Promise<void> {
  const program = new Command()
    .name("build-binary")
    .description("Compile standalone QAML executables (no Bun needed to run).")
    .option(
      "--entry <entry>",
      `what to build: ${[...ENTRY_IDS, "all"].join(", ")} (comma-separated)`,
      parseEntries,
      ["cli"] as EntryId[],
    )
    .option(
      "--target <target>",
      `cross-compile target (${KNOWN_TARGETS.join(", ")})`,
      parseTarget,
    )
    .option("--out-dir <dir>", "where to write executables", "dist")
    .option("--bytecode", "precompile to bytecode for faster cold start")
    .option("--no-verify", "skip booting the built executable")
    .showHelpAfterError("(build-binary --help for usage)");

  await program.parseAsync();
  const options = program.opts<{
    entry: EntryId[];
    target?: Bun.Build.CompileTarget;
    outDir: string;
    bytecode: boolean;
    verify: boolean;
  }>();

  const request: BuildRequest = {
    entries: options.entry,
    target: options.target,
    outDir: options.outDir,
    bytecode: options.bytecode,
    verify: options.verify,
  };

  if (request.bytecode && !isHostTarget(request.target)) {
    console.warn(
      "warning: --bytecode is only supported for the host platform; the build may fail or fall back to source",
    );
  }

  for (const entry of request.entries) {
    const outfile = await buildBinary(entry, request);
    if (request.verify && isHostTarget(request.target)) {
      await verifyBinary(entry, outfile);
      console.log(`verified ${outfile}`);
    } else if (request.verify) {
      console.log(`skipped verify for ${outfile} (cross-compiled)`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
