import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Locale routing only. Authentication and authorization are NOT decided here: every page and
 * every `/api/v1` operation verifies the server session itself (SEC-01), so bypassing this
 * proxy grants nothing.
 */
export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals, the service worker, the offline document and static files.
  matcher: ["/((?!api|_next|sw\\.js|offline\\.html|manifest\\.webmanifest|icons|.*\\..*).*)"],
};
