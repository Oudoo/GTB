// `server-only` throws when imported outside a React Server Component bundle. Tests and the
// worker run in plain Node, where every module is server code, so it resolves to this no-op.
export {};
