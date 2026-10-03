import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  act,
  BROWSER_ACTIONS,
  type BrowserSessionLike,
  connectBrowser,
  disconnectBrowser,
  screenshot,
  snapshotState,
} from "@/browser/connection.ts";
import { assertSteelReachable } from "@/steel/health.ts";
import { SteelSessionManager } from "@/steel/session-manager.ts";
import { loadSteelConfig } from "@/utils/config.ts";

const TARGET_URL = "https://www.saucedemo.com";
const USERNAME = "standard_user";
const ELEMENTS_TO_PRINT = 10;

/**
 * Live smoke test for the browser connection (needs `bun run steel:up`, no
 * API keys required locally): create a Steel session, attach browser-use
 * over CDP, snapshot the Sauce Demo login page, type the username by element
 * index, confirm it stuck, and save a screenshot to runs/smoke/.
 *
 * No local Chromium is launched (Steel owns the browser) and zero generative
 * LLM calls are made — snapshot + registry actions only.
 */
async function main(): Promise<void> {
  const steel = loadSteelConfig();
  await assertSteelReachable(steel.baseUrl);

  const manager = new SteelSessionManager(steel);
  const handle = await manager.create();
  console.log(
    `Session ${handle.id} created — watch live at ${handle.viewerUrl}`,
  );

  let session: BrowserSessionLike | null = null;
  try {
    session = await connectBrowser(handle);
    console.log("browser-use attached over CDP.");

    await act(session, BROWSER_ACTIONS.navigate, { url: TARGET_URL });
    const snapshot = await snapshotState(session);
    console.log(`\n${snapshot.title} — ${snapshot.url}`);
    console.log(
      `${snapshot.elements.length} indexed elements; first ${ELEMENTS_TO_PRINT}:`,
    );
    for (const el of snapshot.elements.slice(0, ELEMENTS_TO_PRINT)) {
      const label = [el.name, el.text].filter(Boolean).join(" / ");
      console.log(
        `  [${el.index}] <${el.tag}>${el.role ? ` role=${el.role}` : ""} ${label}`,
      );
    }

    const username = snapshot.elements.find(
      (el) => el.attributes.id === "user-name",
    );
    if (!username) {
      throw new Error("username input (#user-name) not found in snapshot");
    }
    await act(session, BROWSER_ACTIONS.inputText, {
      index: username.index,
      text: USERNAME,
    });
    console.log(`\nTyped "${USERNAME}" into element [${username.index}].`);

    // Re-snapshot to prove state extraction still works after an action…
    const reSnapshot = await snapshotState(session);
    if (!reSnapshot.elements.some((el) => el.attributes.id === "user-name")) {
      throw new Error("username input missing from the re-snapshot");
    }
    // …but confirm the value via the live DOM property: the snapshot exposes
    // HTML attributes, and typing only sets the `value` property.
    const check = await act(session, BROWSER_ACTIONS.evaluate, {
      code: "document.querySelector('#user-name')?.value ?? null",
    });
    const actual = JSON.stringify(check.extracted_content ?? "");
    if (!actual.includes(USERNAME)) {
      throw new Error(
        `username value did not stick — evaluate returned ${actual}`,
      );
    }
    console.log("Re-snapshot + live value confirm the username stuck.");

    const dir = join("runs", "smoke");
    await mkdir(dir, { recursive: true });
    const file = join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-saucedemo.png`,
    );
    await writeFile(file, await screenshot(session));
    console.log(`Screenshot saved to ${file}`);
  } finally {
    if (session) await disconnectBrowser(session);
    await handle.release();
    console.log("Steel session released.");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
