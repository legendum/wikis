/**
 * wikis login — authenticate with Legendum or set an account key directly.
 *
 * Usage:
 *   wikis login              — open browser for Legendum OAuth
 *   wikis login --key lak_…  — store an account key directly
 */
import { readConfig, writeConfig, getApiUrl } from "../lib/config";

export default async function login(args: string[]) {
  // Direct key mode: wikis login --key lak_abc123
  const keyIdx = args.indexOf("--key");
  if (keyIdx !== -1) {
    const key = args[keyIdx + 1];
    if (!key) {
      console.error("Usage: wikis login --key <account-key>");
      process.exit(1);
    }
    const config = readConfig();
    config.account_key = key;
    writeConfig(config);
    console.log("Account key saved.");
    return;
  }

  // OAuth flow — open browser to login endpoint
  const apiUrl = getApiUrl();
  const callbackPort = 19432;
  const callbackUrl = `http://localhost:${callbackPort}/callback`;

  // Start a tiny HTTP server to receive the callback
  let authenticated = false;
  const server = Bun.serve({
    port: callbackPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const accountKey = url.searchParams.get("key");
        if (accountKey) {
          const config = readConfig();
          config.account_key = accountKey;
          writeConfig(config);
          authenticated = true;
          setTimeout(() => server.stop(), 500);
          return new Response(
            "<html><body><h2>Logged in!</h2><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }
        return new Response("Missing key", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const loginUrl = `${apiUrl}/login?cli_callback=${encodeURIComponent(callbackUrl)}`;
  console.log(`Opening browser to log in…`);
  console.log(`  ${loginUrl}`);
  console.log();
  console.log("Waiting for authentication…");

  // Try to open browser
  try {
    const proc = Bun.spawn(["open", loginUrl], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    console.log("Could not open browser. Please visit the URL above.");
  }

  // Wait for callback (timeout after 5 minutes)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.error("\nLogin timed out. Try again or use: wikis login --key <key>");
      server.stop();
      resolve();
    }, 5 * 60 * 1000);

    const check = setInterval(() => {
      if (authenticated) {
        clearInterval(check);
        clearTimeout(timeout);
        console.log("Authenticated successfully.");
        resolve();
      }
    }, 500);
  });
}
