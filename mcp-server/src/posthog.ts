import { PostHog } from "posthog-node";

const POSTHOG_KEY =
  process.env.POSTHOG_KEY ??
  "phc_zXv8JiZNaiaRCj4BmWVXguPNArabdGVwWRCyUqWSMWAz";

export const posthog = new PostHog(POSTHOG_KEY, {
  host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  flushAt: 20,
  flushInterval: 10000,
});
