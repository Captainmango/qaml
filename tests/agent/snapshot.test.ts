import { describe, expect, it } from "vitest";
import {
  buildPageSnapshot,
  elementDescription,
  findElement,
  jevElements,
  SNAPSHOT_ELEMENT_CAP,
  selectableElements,
  typeableElements,
} from "@/agent/snapshot.ts";
import { makeBrowserSnapshot, makeSnapshotElement } from "./helpers.ts";

describe("buildPageSnapshot", () => {
  it("keeps visible elements only, in snapshot order, counting the omitted", () => {
    // Input honours the BrowserSnapshot contract: index-sorted by stage 03's
    // snapshotState at extraction; filtering must preserve that order.
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [
          makeSnapshotElement(3, { isVisible: false }),
          makeSnapshotElement(5),
          makeSnapshotElement(9, { tag: "a", text: "Products" }),
        ],
      }),
    );

    expect(snapshot.elements.map((element) => element.index)).toEqual([5, 9]);
    expect(snapshot.omittedCount).toBe(1);
    expect(snapshot.truncated).toBe(false);
  });

  it("derives role, name, and value from attributes and own text", () => {
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [
          makeSnapshotElement(1, {
            tag: "input",
            attributes: { type: "text", placeholder: "Username", id: "u" },
          }),
          // No name-ish attribute: the own text becomes the name.
          makeSnapshotElement(2, { tag: "button", text: " Login " }),
          // An explicit role attribute beats the tag-derived role; value shows.
          makeSnapshotElement(3, {
            tag: "div",
            role: "tab",
            name: "Cart",
            attributes: { role: "tab", value: "3 items" },
          }),
        ],
      }),
    );

    expect(snapshot.elements[0]).toMatchObject({
      role: "input-text",
      name: "Username",
      typeable: true,
      password: false,
    });
    expect(snapshot.elements[1]).toMatchObject({
      role: "button",
      name: "Login",
      typeable: false,
    });
    expect(snapshot.elements[2]).toMatchObject({
      role: "tab",
      name: "Cart",
      value: "3 items",
    });
  });

  it("flags password inputs and never exposes their value attribute", () => {
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [
          makeSnapshotElement(2, {
            tag: "input",
            attributes: { type: "password", value: "hunter2", name: "pw" },
          }),
        ],
      }),
    );

    const [password] = snapshot.elements;
    expect(password?.password).toBe(true);
    expect(password?.value).toBeUndefined();
    expect(password?.name).toBe("pw");
  });

  it("classifies typeable and selectable elements", () => {
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [
          makeSnapshotElement(1, { tag: "textarea" }),
          makeSnapshotElement(2, {
            tag: "input",
            attributes: { type: "email" },
          }),
          makeSnapshotElement(3, {
            tag: "input",
            attributes: { type: "checkbox" },
          }),
          makeSnapshotElement(4, { tag: "select" }),
          makeSnapshotElement(5, { tag: "div", role: "combobox" }),
          makeSnapshotElement(6, { tag: "div", role: "textbox" }),
          makeSnapshotElement(7, { tag: "a", attributes: { href: "/x" } }),
        ],
      }),
    );

    expect(typeableElements(snapshot).map((element) => element.index)).toEqual([
      1, 2, 6,
    ]);
    expect(
      selectableElements(snapshot).map((element) => element.index),
    ).toEqual([4, 5]);
  });

  it("caps the table at the limit, preferring in-viewport elements", () => {
    const total = SNAPSHOT_ELEMENT_CAP + 20;
    const elements = Array.from({ length: total }, (_, i) =>
      makeSnapshotElement(i + 1, {
        tag: "button",
        text: `Button ${i + 1}`,
        // Only the second half is in the viewport.
        isInViewport: i + 1 > total / 2,
      }),
    );
    const snapshot = buildPageSnapshot(makeBrowserSnapshot({ elements }));

    expect(snapshot.elements).toHaveLength(SNAPSHOT_ELEMENT_CAP);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.omittedCount).toBe(20);
    // In-viewport elements (61..120) all fit in the cap and are kept first;
    // the remaining slots go to the earliest off-screen ones (1..40).
    const kept = snapshot.elements.map((element) => element.index);
    expect(kept.filter((index) => index > total / 2)).toHaveLength(60);
    expect(kept[0]).toBe(1);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
  });

  it("caps display text lengths", () => {
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [makeSnapshotElement(1, { tag: "p", text: "x".repeat(300) })],
      }),
    );

    const [element] = snapshot.elements;
    expect(element?.name.length).toBeLessThanOrEqual(120);
    expect(element?.name.endsWith("…")).toBe(true);
  });
});

describe("elementDescription", () => {
  it("formats the jev-ultrafast table row", () => {
    expect(
      elementDescription({ index: 3, role: "button", name: "Login" }),
    ).toBe("[3] button Login");
    expect(
      elementDescription({
        index: 7,
        role: "input-text",
        name: "Email",
        value: "a@b.c",
      }),
    ).toBe("[7] input-text Email · a@b.c");
    expect(elementDescription({ index: 1, role: "div", name: "" })).toBe(
      "[1] div",
    );
  });
});

describe("findElement", () => {
  const snapshot = buildPageSnapshot(
    makeBrowserSnapshot({ elements: [makeSnapshotElement(4)] }),
  );

  it("finds by index and returns undefined for null/missing", () => {
    expect(findElement(snapshot, 4)?.index).toBe(4);
    expect(findElement(snapshot, null)).toBeUndefined();
    expect(findElement(snapshot, 99)).toBeUndefined();
  });
});

describe("jevElements", () => {
  it("sends exactly index/role/name(/value) — no local-only fields", () => {
    const snapshot = buildPageSnapshot(
      makeBrowserSnapshot({
        elements: [
          makeSnapshotElement(1, {
            tag: "input",
            attributes: { type: "text", placeholder: "User", value: "bob" },
          }),
          makeSnapshotElement(2, { tag: "button", text: "Go" }),
        ],
      }),
    );

    const elements = jevElements(snapshot);
    expect(elements).toEqual([
      { index: 1, role: "input-text", name: "User", value: "bob" },
      { index: 2, role: "button", name: "Go" },
    ]);
    expect(Object.keys(elements[1] ?? {}).sort()).toEqual([
      "index",
      "name",
      "role",
    ]);
  });
});
