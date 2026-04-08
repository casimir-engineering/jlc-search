import { PostHog } from "posthog-node";

const POSTHOG_KEY =
  process.env.POSTHOG_KEY ??
  "phc_zXv8JiZNaiaRCj4BmWVXguPNArabdGVwWRCyUqWSMWAz";

// When POSTHOG_KEY is explicitly set to "" (e.g. in the /test staging stack),
// export a no-op stub instead of instantiating the real client. The PostHog
// SDK throws on empty keys, and call sites only use .capture() and .shutdown(),
// so a minimal stub keeps them working without requiring null checks.
export const posthog: Pick<PostHog, "capture" | "shutdown"> = POSTHOG_KEY
  ? new PostHog(POSTHOG_KEY, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 20,
      flushInterval: 10000,
    })
  : ({
      capture: () => {},
      shutdown: async () => undefined,
    } as unknown as PostHog);
