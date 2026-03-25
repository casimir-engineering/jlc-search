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
          INSERT INTO mcp_api_keys (id, key_hash, key_plaintext, name, tier, patreon_member_id, patreon_email)
          VALUES (${id}, ${keyHash}, ${key}, ${`Patreon: ${email ?? memberId}`}, ${tier}, ${memberId}, ${email ?? null})
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

const MCP_URL = "https://search.casimir.engineering/mcp-api/mcp";

export async function handleKeyPage(c: Context): Promise<Response> {
  const clientId = process.env.PATREON_CLIENT_ID;
  const clientSecret = process.env.PATREON_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.html(renderPage("Configuration Error", "<p>Patreon OAuth is not configured on this server.</p>"));
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
    return c.html(renderPage("OAuth Error", "<p>Failed to exchange authorization code. Please try again.</p>"));
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
    return c.html(renderPage("Identity Error", "<p>Failed to fetch your Patreon identity.</p>"));
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
    return c.html(renderPage("Error", "<p>Could not determine your Patreon membership.</p>"));
  }

  // Look up existing key
  const sql = getSql();
  const rows = await sql`
    SELECT id, key_hash, key_plaintext, tier, is_active FROM mcp_api_keys
    WHERE patreon_member_id = ${lookupId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.html(renderPage(
      `Hello, ${escHtml(fullName)}`,
      "<p>No API key found for your account. Make sure you are an active patron, then check back shortly after your membership is processed.</p>"
    ));
  }

  const row = rows[0];
  if (!row.is_active) {
    return c.html(renderPage(
      `Hello, ${escHtml(fullName)}`,
      "<p>Your API key has been deactivated. Please ensure your Patreon membership is active.</p>"
    ));
  }

  // Read key_plaintext if available; otherwise generate a new one and persist both hash + plaintext
  let apiKey: string;
  if (row.key_plaintext) {
    apiKey = row.key_plaintext;
  } else {
    const { key: newKey, hash: newHashPromise } = generateApiKey();
    const newHash = await newHashPromise;
    await sql`
      UPDATE mcp_api_keys SET key_hash = ${newHash}, key_plaintext = ${newKey}
      WHERE id = ${row.id}
    `;
    apiKey = newKey;
  }

  const tier: string = row.tier ?? "hobbyist";
  const safeName = escHtml(fullName);

  const tierColors: Record<string, string> = {
    hobbyist: "#0066cc",
    engineer: "#d97706",
    addict: "#7c3aed",
  };
  const tierColor = tierColors[tier] ?? "#4a9eff";

  const tools = [
    { name: "search_parts", desc: "Search 3.5M+ components with filters" },
    { name: "get_part", desc: "Full details for any LCSC part" },
    { name: "list_categories", desc: "Browse component categories" },
    { name: "compare_parts", desc: "Side-by-side part comparison" },
    { name: "create_bom", desc: "Build a BOM with shareable link" },
  ];

  const toolCards = tools.map(t => `<div class="tool-card"><span class="tool-name">${t.name}</span><span class="tool-desc">${t.desc}</span></div>`).join("\n      ");

  const body = `
  <div class="greeting">
    <h2>Hello, ${safeName}</h2>
    <span class="tier-badge" style="background:${tierColor}">${escHtml(tier)}</span>
  </div>

  <div class="key-section">
    <label class="section-label">Your API Key</label>
    <div class="key-box">
      <code id="api-key">${escHtml(apiKey)}</code>
      <button class="copy-btn" onclick="copyKey()">Copy</button>
    </div>
  </div>

  <div class="tools-section">
    <label class="section-label">Your AI gets access to</label>
    <div class="tools-grid">
      ${toolCards}
    </div>
  </div>

  <div class="setup-section">
    <label class="section-label" for="guide-select">Setup Guide</label>
    <select id="guide-select" class="guide-dropdown" onchange="showGuide(this.value)">
      <option value="generic" selected>Generic / Other AI</option>
      <option value="claude-desktop">Claude Desktop</option>
      <option value="claude-code">Claude Code</option>
      <option value="codex-cli">Codex CLI</option>
    </select>

    <div id="guide-generic" class="guide-content active">
      <p>Give this prompt to your AI:</p>
      <pre class="config-block"><code>I have access to a JLCsearch MCP server at ${MCP_URL}
with API key: ${escHtml(apiKey)} (send as Authorization: Bearer header).

Available tools:
- search_parts: Search 3.5M+ electronic components with filters
- get_part: Get full details for a part by LCSC code
- list_categories: Browse component categories
- compare_parts: Compare up to 10 parts side by side
- create_bom: Build a BOM with quantities, get pricing summary + shareable link

Configure the MCP server and use it to help me find electronic components and build BOMs.</code></pre>
    </div>

    <div id="guide-claude-desktop" class="guide-content">
      <p>Add to your Claude Desktop config file:</p>
      <ul class="path-list">
        <li><b>macOS</b>: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
        <li><b>Windows</b>: <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></li>
        <li><b>Linux</b>: <code>~/.config/Claude/claude_desktop_config.json</code></li>
      </ul>
      <pre class="config-block"><code>{
  "mcpServers": {
    "jlc-search": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${escHtml(apiKey)}"
      }
    }
  }
}</code></pre>
    </div>

    <div id="guide-claude-code" class="guide-content">
      <p>Add to <code>.mcp.json</code> in your project root (shared) or to <code>~/.claude.json</code> (personal, all projects):</p>
      <pre class="config-block"><code>{
  "mcpServers": {
    "jlc-search": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${escHtml(apiKey)}"
      }
    }
  }
}</code></pre>
      <p>Or run:</p>
      <pre class="config-block"><code>claude mcp add --transport http jlc-search ${MCP_URL} --header "Authorization: Bearer ${escHtml(apiKey)}"</code></pre>
    </div>

    <div id="guide-codex-cli" class="guide-content">
      <p>1. Set your API key as an environment variable:</p>
      <pre class="config-block"><code>export JLCSEARCH_API_KEY="${escHtml(apiKey)}"</code></pre>
      <p>2. Add to <code>~/.codex/config.toml</code> (or project <code>.codex/config.toml</code>):</p>
      <pre class="config-block"><code>[mcp_servers.jlc-search]
url = "${MCP_URL}"
bearer_token_env_var = "JLCSEARCH_API_KEY"</code></pre>
      <p>Or add via CLI:</p>
      <pre class="config-block"><code>codex mcp add --transport http jlc-search ${MCP_URL}</code></pre>
      <p class="hint-text">Then manually add <code>bearer_token_env_var = "JLCSEARCH_API_KEY"</code> to the <code>[mcp_servers.jlc-search]</code> section in your config.toml.</p>
    </div>
  </div>

  <script>
    function copyKey() {
      const key = document.getElementById('api-key').textContent;
      navigator.clipboard.writeText(key).then(function() {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
      });
    }

    function showGuide(value) {
      var guides = document.querySelectorAll('.guide-content');
      for (var i = 0; i < guides.length; i++) {
        guides[i].classList.remove('active');
      }
      var el = document.getElementById('guide-' + value);
      if (el) el.classList.add('active');
    }
  </script>`;

  return c.html(renderPage(`jlc-search MCP`, body));
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 680px;
      margin: 48px auto;
      padding: 0 24px;
      background: #f5f5f5;
      color: #1a1a1a;
      line-height: 1.6;
    }
    a { color: #0066cc; }
    code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.85rem; }

    /* Greeting */
    .greeting {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }
    .greeting h2 {
      color: #1a1a1a;
      margin: 0;
      font-size: 1.5rem;
      font-weight: 600;
    }
    .tier-badge {
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 3px 10px;
      border-radius: 999px;
      color: #fff;
      white-space: nowrap;
    }

    /* Section labels */
    .section-label {
      display: block;
      font-size: 0.78rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #888;
      margin-bottom: 8px;
    }

    /* Key box */
    .key-section { margin-bottom: 28px; }
    .key-box {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #fff;
      border: 1.5px solid #e8e8e8;
      border-radius: 8px;
      padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .key-box code {
      flex: 1;
      color: #0066cc;
      font-size: 1rem;
      font-weight: 500;
      word-break: break-all;
      user-select: all;
      font-family: monospace;
    }
    .copy-btn {
      background: #0066cc;
      color: #fff;
      border: none;
      border-radius: 5px;
      padding: 6px 14px;
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .copy-btn:hover { background: #0052a3; }

    /* Tool cards */
    .tools-section { margin-bottom: 28px; }
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 10px;
    }
    .tool-card {
      background: #fff;
      border: 1.5px solid #e8e8e8;
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .tool-card:hover {
      border-color: #0066cc;
      box-shadow: 0 3px 8px rgba(0,0,0,0.1);
    }
    .tool-name {
      display: block;
      font-family: monospace;
      font-size: 0.82rem;
      font-weight: 600;
      color: #0066cc;
      margin-bottom: 4px;
    }
    .tool-desc {
      display: block;
      font-size: 0.78rem;
      color: #666;
      line-height: 1.4;
    }

    /* Setup guide */
    .setup-section { margin-bottom: 28px; }
    .guide-dropdown {
      display: block;
      width: 100%;
      padding: 10px 14px;
      font-size: 0.92rem;
      background: #fff;
      color: #1a1a1a;
      border: 1.5px solid #d0d0d0;
      border-radius: 8px;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%230066cc' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      cursor: pointer;
      margin-bottom: 16px;
    }
    .guide-dropdown:focus { outline: 2px solid #0066cc; outline-offset: 1px; }

    .guide-content { display: none; }
    .guide-content.active { display: block; }
    .guide-content p { margin: 0 0 10px 0; font-size: 0.88rem; color: #444; }
    .guide-content p code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.82rem;
    }
    .path-list {
      font-size: 0.82rem;
      color: #666;
      margin: 4px 0 12px 18px;
      line-height: 1.8;
    }
    .hint-text {
      font-size: 0.82rem;
      color: #888;
    }

    /* Config code blocks */
    .config-block {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      margin: 0 0 12px 0;
    }
    .config-block code {
      color: #e0e0e0;
      font-size: 0.82rem;
      white-space: pre;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
