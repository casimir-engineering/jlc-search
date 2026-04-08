import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { App } from "./App.tsx";
import "./styles/index.css";

const POSTHOG_KEY =
  (import.meta.env.VITE_POSTHOG_KEY as string | undefined) ??
  "phc_zXv8JiZNaiaRCj4BmWVXguPNArabdGVwWRCyUqWSMWAz";

posthog.init(POSTHOG_KEY, {
  api_host:
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
    "https://us.i.posthog.com",
  person_profiles: "identified_only",
  capture_pageview: true,
  capture_pageleave: true,
  autocapture: true,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
