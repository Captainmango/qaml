import type { JsonValue } from "@typesafe-ai/sdk";
import type { BrowserSnapshot, SnapshotElement } from "@/browser/connection.ts";

/**
 * Page state → Jev state (stage 05). Turns the raw stage-03 extraction into
 * the capped, capability-classified element table the decision questions are
 * built from, in the jev-ultrafast `[i] role  name · value` shape.
 *
 * Rules:
 *
 * - Visible elements only; the table is capped at SNAPSHOT_ELEMENT_CAP
 *   (~100) to bound input tokens. When the cap bites, in-viewport elements
 *   are kept first (an agent that can only click what it sees) and the
 *   truncation is recorded so the loop can put it in the trace and Jev can
 *   see `elements_truncated` in its state.
 * - Every indexed element is a click candidate: browser-use only indexes
 *   interactive elements, so the selector_map membership IS the clickability
 *   signal. Typeable/selectable are narrower classifications computed here.
 * - Password inputs never contribute a `value` (attributes can carry one) —
 *   secrets stay out of Jev state, traces, and reports.
 */

export const SNAPSHOT_ELEMENT_CAP = 100;
/** Display caps — one table row must stay scannable in a few tokens. */
const NAME_CHAR_CAP = 120;
const VALUE_CHAR_CAP = 80;

/** The element shape sent to Jev (exactly these fields — token budget). */
export interface IndexedElement {
  index: number;
  role: string;
  name: string;
  value?: string;
}

/** IndexedElement plus what QAML code (executor, masking) needs locally. */
export interface AgentElement extends IndexedElement {
  tag: string;
  /** input[type=password] — typed text must be masked in traces. */
  password: boolean;
  /** Accepts typed text (text-like input, textarea, textbox role). */
  typeable: boolean;
  /** Native select / combobox / listbox — SELECT operation candidate. */
  selectable: boolean;
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: AgentElement[];
  /** True when the visible-element count exceeded SNAPSHOT_ELEMENT_CAP. */
  truncated: boolean;
  /** Elements dropped from the raw snapshot (invisible + over the cap). */
  omittedCount: number;
}

/** Input types that receive text; everything else is click-only. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "range",
  "color",
  "hidden",
]);
const TYPEABLE_TAGS = new Set(["textarea"]);
const TYPEABLE_ROLES = new Set(["textbox", "searchbox"]);
const SELECTABLE_TAGS = new Set(["select"]);
const SELECTABLE_ROLES = new Set(["combobox", "listbox"]);

function capText(text: string, cap: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap - 1)}…` : collapsed;
}

/** `input[type=text]` → "input-text"; explicit role attribute wins. */
function displayRole(element: SnapshotElement): string {
  if (element.role) return element.role;
  const type = element.attributes.type?.trim();
  if (element.tag === "input" && type) return `input-${type}`;
  return element.tag;
}

function toAgentElement(element: SnapshotElement): AgentElement {
  const role = displayRole(element);
  const type = element.attributes.type?.trim().toLowerCase() ?? "";
  const password = element.tag === "input" && type === "password";
  const typeable =
    TYPEABLE_TAGS.has(element.tag) ||
    TYPEABLE_ROLES.has(element.role ?? "") ||
    (element.tag === "input" && !NON_TEXT_INPUT_TYPES.has(type));
  const selectable =
    SELECTABLE_TAGS.has(element.tag) ||
    SELECTABLE_ROLES.has(element.role ?? "");
  // Attribute-based name first (stage 03), own text as the fallback — a
  // <button>Login</button> has no name attribute but must still read "Login".
  const name = capText(element.name ?? element.text ?? "", NAME_CHAR_CAP);
  // Skip the value when it IS the name (e.g. <input type=submit value=Login>
  // — stage 03 already fell back to `value` for the name): "[i] role Login ·
  // Login" would just waste Jev's tokens.
  const rawValue = password ? undefined : element.attributes.value?.trim();
  const value = rawValue ? capText(rawValue, VALUE_CHAR_CAP) : undefined;

  return {
    index: element.index,
    role,
    name,
    ...(value !== undefined && value !== name && { value }),
    tag: element.tag,
    password,
    typeable,
    selectable,
    inViewport: element.isInViewport,
  };
}

/**
 * Builds the per-cycle page snapshot: one raw stage-03 snapshot in, one
 * capped + classified table out. Pure — no browser access, so the "atomic
 * per cycle" rule is the loop's job (one snapshotState() feeding both the
 * question and target validation).
 */
export function buildPageSnapshot(snapshot: BrowserSnapshot): PageSnapshot {
  const visible = snapshot.elements
    .filter((element) => element.isVisible)
    .sort((a, b) => a.index - b.index);
  const hiddenCount = snapshot.elements.length - visible.length;

  let kept = visible;
  if (visible.length > SNAPSHOT_ELEMENT_CAP) {
    // Prefer what the agent can actually see right now; fill the remaining
    // budget with off-screen elements, then restore document order.
    const inViewport = visible.filter((element) => element.isInViewport);
    const offscreen = visible.filter((element) => !element.isInViewport);
    kept = [
      ...inViewport.slice(0, SNAPSHOT_ELEMENT_CAP),
      ...offscreen.slice(
        0,
        Math.max(0, SNAPSHOT_ELEMENT_CAP - inViewport.length),
      ),
    ].sort((a, b) => a.index - b.index);
  }

  return {
    url: snapshot.url,
    title: snapshot.title,
    elements: kept.map(toAgentElement),
    truncated: kept.length < visible.length,
    omittedCount: hiddenCount + (visible.length - kept.length),
  };
}

/** The jev-ultrafast element-table row: `[i] role  name · value`. */
export function elementDescription(element: IndexedElement): string {
  const name = element.name ? ` ${element.name}` : "";
  const value = element.value ? ` · ${element.value}` : "";
  return `[${element.index}] ${element.role}${name}${value}`;
}

export function findElement(
  snapshot: PageSnapshot,
  index: number | null,
): AgentElement | undefined {
  if (index === null) return undefined;
  return snapshot.elements.find((element) => element.index === index);
}

export function typeableElements(snapshot: PageSnapshot): AgentElement[] {
  return snapshot.elements.filter((element) => element.typeable);
}

export function selectableElements(snapshot: PageSnapshot): AgentElement[] {
  return snapshot.elements.filter((element) => element.selectable);
}

/** Strips local-only fields — exactly the IndexedElement shape goes to Jev. */
export function jevElements(
  snapshot: PageSnapshot,
): Array<Record<string, JsonValue>> {
  return snapshot.elements.map((element) => {
    const json: Record<string, JsonValue> = {
      index: element.index,
      role: element.role,
      name: element.name,
    };
    if (element.value !== undefined) json.value = element.value;
    return json;
  });
}
