/**
 * Process wiring. Approval targets, instruction observers, audit labelers and job handlers
 * register themselves as import side effects of `src/server/bootstrap.ts`. Every entry point
 * that can run them must import it: the built web app once had no handler for batch and
 * repair approvals because only the worker and the seed loaded the registrations.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("registration wiring", () => {
  it.each(["src/server/api/registry.ts", "src/server/page.ts", "worker/index.ts", "src/server/seed/demo.ts"])("%s loads the registrations", (path) => {
    expect(source(path)).toMatch(/^import "@\/server\/bootstrap";$/m);
  });

  it("the bootstrap imports every domain registration module that exists", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    const domains = readdirSync(new URL("../../src/server/domain", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const bootstrap = source("src/server/bootstrap.ts");
    for (const domain of domains) {
      if (!existsSync(new URL(`../../src/server/domain/${domain}/register.ts`, import.meta.url))) continue;
      expect(bootstrap, `bootstrap must import ${domain}/register`).toContain(`import "@/server/domain/${domain}/register";`);
    }
  });
});
