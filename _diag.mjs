// Temporary diagnostic — safe to delete.
import { readFileSync } from "node:fs";
import pg from "pg";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = env.DATABASE_URL || process.env.DATABASE_URL;
console.log("DATABASE_URL host:", url ? url.replace(/:\/\/[^@]*@/, "://***@") : "(missing)");
console.log("NEXTAUTH_URL:", env.NEXTAUTH_URL);
console.log("WEBHOOK_VERIFY_TOKEN set:", Boolean(env.WEBHOOK_VERIFY_TOKEN));
console.log("FACEBOOK_APP_SECRET set:", Boolean(env.FACEBOOK_APP_SECRET), "len", (env.FACEBOOK_APP_SECRET||"").length);
console.log("INSTAGRAM_APP_SECRET set:", Boolean(env.INSTAGRAM_APP_SECRET), "len", (env.INSTAGRAM_APP_SECRET||"").length);
console.log("FACEBOOK_APP_ID:", env.FACEBOOK_APP_ID, "INSTAGRAM_APP_ID:", env.INSTAGRAM_APP_ID);
console.log("META_GRAPH_API_VERSION:", env.META_GRAPH_API_VERSION);

const client = new pg.Client({ connectionString: url });
await client.connect();

const q = async (label, sql) => {
  try {
    const r = await client.query(sql);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(r.rows, null, 2));
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e.message}`);
  }
};

await q(
  "InstagramAccount",
  `select "instagramId","username","webhookSubscribed","isActive","tokenExpiresAt","createdAt","workspaceId" from "InstagramAccount" order by "createdAt"`
);
await q("WebhookEvent count", `select count(*)::int as n, min("createdAt") as first, max("createdAt") as last from "WebhookEvent"`);
await q(
  "WebhookEvent recent",
  `select "createdAt","object","status","errorMessage","workspaceId", left(payload::text, 500) as payload_head from "WebhookEvent" order by "createdAt" desc limit 8`
);
await q(
  "OperationalEvent recent",
  `select "createdAt","source","level","message" from "OperationalEvent" order by "createdAt" desc limit 12`
);
await q(
  "Automation",
  `select id,name,"isActive","workspaceId","instagramAccountId","keywords","matchType" from "Automation"`
);
await q("DmLog count by status", `select status, count(*)::int as n from "DmLog" group by status`);
await q(
  "DmLog recent",
  `select "createdAt",status,"commentText","errorMessage" from "DmLog" order by "createdAt" desc limit 8`
);
await q("ProcessedComment count", `select count(*)::int as n from "ProcessedComment"`);

await client.end();
