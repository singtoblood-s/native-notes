import { describe, expect, it } from "vitest";
import { accountNamespace } from "../src/storage";
import { clonePage, createPage, createNotebook, isUUID, requireUUID } from "../src/models";

describe("local identity and canonical models", () => {
  it("keeps endpoint and account namespaces distinct", async () => {
    const first = await accountNamespace("https://one.example:user");
    const second = await accountNamespace("https://one.example/user");
    const otherAccount = await accountNamespace("https://one.example:other");
    expect(first).not.toBe(second);
    expect(first).not.toBe(otherAccount);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only UUID entity identifiers", () => {
    const value = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(isUUID(value)).toBe(true);
    expect(requireUUID(value, "id")).toBe(value.toLowerCase());
    expect(isUUID("../../other-account")).toBe(false);
    expect(() => requireUUID("../../other-account", "id")).toThrow();
  });

  it("clones nested stroke points before an edit", () => {
    const notebook = createNotebook();
    const page = createPage(notebook.id);
    page.strokes = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", color: 0xff000000, width: 2, points: [{ x: 1, y: 2, pressure: 0.5, time: 0, tiltX: null, tiltY: null }] }];
    const copy = clonePage(page);
    copy.strokes[0]!.points[0]!.x = 9;
    expect(page.strokes[0]!.points[0]!.x).toBe(1);
  });
});
