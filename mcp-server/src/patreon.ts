import type { Context } from "hono";
import { getSql } from "./db.ts";

// ── Key generation ───────────────────────────────────────────────────

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return [...hashArray].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): { key: string; hash: Promise<string> } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `jlc_${hex}`;
  return { key, hash: sha256(key) };
}

// ── Tier mapping ─────────────────────────────────────────────────────

function mapPatreonTier(entitledTierIds: string[]): string {
  const tierAddict = process.env.PATREON_TIER_ADDICT;
  const tierEngineer = process.env.PATREON_TIER_ENGINEER;
  const tierHobbyist = process.env.PATREON_TIER_HOBBYIST;

  // Check highest tier first
  if (tierAddict && entitledTierIds.includes(tierAddict)) return "addict";
  if (tierEngineer && entitledTierIds.includes(tierEngineer)) return "engineer";
  if (tierHobbyist && entitledTierIds.includes(tierHobbyist)) return "hobbyist";
  return "hobbyist";
}

// ── Webhook signature verification ───────────────────────────────────

async function verifySignature(body: string, signature: string): Promise<boolean> {
  const secret = process.env.PATREON_WEBHOOK_SECRET;
  if (!secret) {
    console.error("PATREON_WEBHOOK_SECRET not set, rejecting webhook");
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "MD5" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const computed = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === signature.toLowerCase();
}

// ── Webhook handler ──────────────────────────────────────────────────

export async function handlePatreonWebhook(c: Context): Promise<Response> {
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Patreon-Signature") ?? "";

  if (!signature || !(await verifySignature(rawBody, signature))) {
    return c.json({ error: "Invalid signature" }, 403);
  }

  const eventType = c.req.header("X-Patreon-Event") ?? "";
  const payload = JSON.parse(rawBody);

  // Process async — return 200 immediately
  processWebhookEvent(eventType, payload).catch((err) => {
    console.error("Webhook processing error:", err);
  });

  return c.json({ ok: true }, 200);
}

async function processWebhookEvent(eventType: string, payload: any): Promise<void> {
  const sql = getSql();

  const memberData = payload?.data?.attributes ?? {};
  const memberId = payload?.data?.id as string | undefined;
  const patronStatus = memberData.patron_status as string | undefined;
  const email = memberData.email as string | undefined;

  // Extract entitled tier IDs from included relationships
  const entitledTierIds: string[] = [];
  const included = payload?.included as any[] | undefined;
  if (included) {
    for (const item of included) {
      if (item.type === "tier" && item.id) {
        entitledTierIds.push(item.id);
      }
    }
  }

  if (!memberId) {
    console.error("Webhook missing member ID");
    return;
  }

  switch (eventType) {
    case "members:create": {
      if (patronStatus === "active_patron") {
        const tier = mapPatreonTier(entitledTierIds);
        const { key, hash } = generateApiKey();
        const keyHash = await hash;
        const id = crypto.randomUUID();

        await sql`
          INSERT INTO mcp_api_keys (id, key_hash, name, tier, patreon_member_id, patreon_email)
          VALUES (${id}, ${keyHash}, ${`Patreon: ${email ?? memberId}`}, ${tier}, ${memberId}, ${email ?? null})
          ON CONFLICT (key_hash) DO NOTHING
        `;

        console.log(`Created API key for Patreon member ${memberId} (tier: ${tier})`);
        // Note: the key itself is only retrievable via the OAuth /key flow
      }
      break;
    }

    case "members:update": {
      const tier = mapPatreonTier(entitledTierIds);

      if (patronStatus !== "active_patron") {
        // Deactivate
        await sql`
          UPDATE mcp_api_keys SET is_active = false
          WHERE patreon_member_id = ${memberId}
        `;
        console.log(`Deactivated API key for Patreon member ${memberId} (status: ${patronStatus})`);
      } else {
        // Update tier
        await sql`
          UPDATE mcp_api_keys SET tier = ${tier}, patreon_email = ${email ?? null}
          WHERE patreon_member_id = ${memberId}
        `;
        console.log(`Updated tier for Patreon member ${memberId} to ${tier}`);
      }
      break;
    }

    case "members:delete": {
      await sql`
        UPDATE mcp_api_keys SET is_active = false
        WHERE patreon_member_id = ${memberId}
      `;
      console.log(`Deactivated API key for deleted Patreon member ${memberId}`);
      break;
    }

    default:
      console.log(`Unhandled Patreon webhook event: ${eventType}`);
  }
}

// ── OAuth key retrieval page ─────────────────────────────────────────

const PATREON_AUTH_URL = "https://www.patreon.com/oauth2/authorize";
const PATREON_TOKEN_URL = "https://www.patreon.com/api/oauth2/token";
const PATREON_IDENTITY_URL = "https://www.patreon.com/api/oauth2/v2/identity";

export async function handleKeyPage(c: Context): Promise<Response> {
  const clientId = process.env.PATREON_CLIENT_ID;
  const clientSecret = process.env.PATREON_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.html(renderPage("Configuration Error", "Patreon OAuth is not configured on this server."));
  }

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");

  // Build the public-facing redirect URI (respects X-Forwarded-Proto from proxy)
  const proto = c.req.header("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
  const host = c.req.header("X-Forwarded-Host") ?? c.req.header("Host") ?? url.host;
  const publicBase = `${proto}://${host}`;
  const redirectUri = `${publicBase}/mcp-api/key`;

  // No code — redirect to Patreon OAuth
  if (!code) {
    const authUrl = new URL(PATREON_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "identity identity[email]");
    return c.redirect(authUrl.toString());
  }
  const tokenResp = await fetch(PATREON_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    return c.html(renderPage("OAuth Error", "Failed to exchange authorization code. Please try again."));
  }

  const tokenData = (await tokenResp.json()) as { access_token: string };
  const accessToken = tokenData.access_token;

  // Fetch patron identity
  const identityUrl = new URL(PATREON_IDENTITY_URL);
  identityUrl.searchParams.set("fields[user]", "email,full_name");
  identityUrl.searchParams.set("include", "memberships");

  const identityResp = await fetch(identityUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!identityResp.ok) {
    return c.html(renderPage("Identity Error", "Failed to fetch your Patreon identity."));
  }

  const identity = (await identityResp.json()) as any;
  const patreonUserId = identity?.data?.id;
  const email = identity?.data?.attributes?.email;
  const fullName = identity?.data?.attributes?.full_name ?? "Patron";

  // Find memberships to get the member ID for our campaign
  const memberships = identity?.included?.filter((i: any) => i.type === "member") ?? [];
  const campaignId = process.env.PATREON_CAMPAIGN_ID;
  let memberId: string | null = null;

  for (const m of memberships) {
    const campaignData = m?.relationships?.campaign?.data;
    if (campaignData?.id === campaignId) {
      memberId = m.id;
      break;
    }
  }

  // Fall back to patreon user ID if no campaign membership found
  const lookupId = memberId ?? patreonUserId;

  if (!lookupId) {
    return c.html(renderPage("Error", "Could not determine your Patreon membership."));
  }

  // Look up existing key
  const sql = getSql();
  const rows = await sql`
    SELECT id, key_hash, tier, is_active FROM mcp_api_keys
    WHERE patreon_member_id = ${lookupId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.html(renderPage(
      `Hello, ${fullName}`,
      "No API key found for your account. Make sure you are an active patron, then check back shortly after your membership is processed."
    ));
  }

  const row = rows[0];
  if (!row.is_active) {
    return c.html(renderPage(
      `Hello, ${fullName}`,
      "Your API key has been deactivated. Please ensure your Patreon membership is active."
    ));
  }

  // We cannot show the original key (we only store the hash).
  // Generate a new key, update the hash, and show it once.
  const { key: newKey, hash: newHashPromise } = generateApiKey();
  const newHash = await newHashPromise;

  await sql`
    UPDATE mcp_api_keys SET key_hash = ${newHash}
    WHERE id = ${row.id}
  `;

  return c.html(renderPage(
    `Hello, ${fullName}`,
    `<p>Your API key (tier: <strong>${row.tier}</strong>):</p>
    <pre style="background:#1a1a2e;color:#0f0;padding:16px;border-radius:8px;font-size:16px;user-select:all">${newKey}</pre>
    <p><strong>Save this key now.</strong> It will not be shown again.</p>
    <h3>Usage</h3>
    <p>Add this header to your MCP client requests:</p>
    <pre style="background:#1a1a2e;color:#eee;padding:12px;border-radius:8px">Authorization: Bearer ${newKey}</pre>`
  ));
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — jlc-search MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; background: #0d0d1a; color: #e0e0e0; }
    h1 { color: #7eb8ff; }
    pre { overflow-x: auto; }
    a { color: #7eb8ff; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}
