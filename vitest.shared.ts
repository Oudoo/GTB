import { fileURLToPath } from "node:url";

/** Shared Vitest resolution: the `@/` alias, and `server-only` as a no-op outside Next.js. */
export const sharedResolve = {
  alias: [
    { find: /^@\//, replacement: `${fileURLToPath(new URL("./src/", import.meta.url))}` },
    { find: /^server-only$/, replacement: fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) },
  ],
};
