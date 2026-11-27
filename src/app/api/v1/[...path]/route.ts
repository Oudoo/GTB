import { dispatch } from "@/server/api/framework";
import { getRegistry } from "@/server/api/registry";

// Every API response is computed per request and is never cached (document 04, PWA-03).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  return dispatch(getRegistry(), request);
}

export { handle as GET, handle as POST, handle as PATCH };
