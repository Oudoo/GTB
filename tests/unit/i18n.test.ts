import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/i18n/messages";

type Tree = { [key: string]: Tree | string };

function keysOf(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`),
  );
}

function valueAt(tree: Tree, path: string): string {
  let node: Tree | string = tree;
  for (const part of path.split(".")) node = (node as Tree)[part] as Tree | string;
  return node as string;
}

/** Names of the top-level ICU arguments (`{name}` / `{count, plural, …}`), ignoring branch text. */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i += 1) {
    const ch = message[i];
    if (ch === "{") {
      if (depth === 0) {
        const match = /^\{\s*(\w+)\s*[,}]/.exec(message.slice(i));
        if (match) names.add(match[1] as string);
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    }
  }
  return [...names].sort();
}

describe("message catalogues", () => {
  const en = MESSAGES.en as unknown as Tree;
  const ar = MESSAGES.ar as unknown as Tree;
  const enKeys = keysOf(en).sort();
  const arKeys = keysOf(ar).sort();

  it("Arabic has exactly the same keys as English (no silent fallback)", () => {
    expect(arKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(300);
  });

  it("no message is empty or a leftover placeholder", () => {
    for (const key of enKeys) {
      for (const tree of [en, ar]) {
        const value = valueAt(tree, key);
        expect(value.trim().length, key).toBeGreaterThan(0);
        expect(/lorem ipsum|TODO|TBD/i.test(value), key).toBe(false);
      }
    }
  });

  it("every Arabic message uses the same ICU arguments as English", () => {
    for (const key of enKeys) {
      expect(placeholders(valueAt(ar, key)), key).toEqual(placeholders(valueAt(en, key)));
    }
  });

  it("Arabic messages are actually Arabic for the core namespaces", () => {
    const arabic = /[؀-ۿ]/;
    const latinOnlyAllowed = new Set(["common.labels.english", "common.labels.unknownValue"]);
    for (const key of arKeys) {
      if (latinOnlyAllowed.has(key)) continue;
      expect(arabic.test(valueAt(ar, key)), `${key} should contain Arabic text`).toBe(true);
    }
  });
});
