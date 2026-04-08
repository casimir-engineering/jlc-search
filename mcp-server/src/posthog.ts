import { PostHog } from "posthog-node";

const POSTHOG_KEY = "phc_mATHaDwUWBQvdHFsATWxKYFsfjBfZKyx9cLJEmpF9oDY";

export const posthog = new PostHog(POSTHOG_KEY, {
  host: "https://us.i.posthog.com",
  flushAt: 20,
  flushInterval: 10000,
});
