/**
 * wikis login — authenticate with your Legendum account key.
 *
 * Usage:
 *   wikis login <lak_...>
 */
import { readConfig, writeConfig, getApiUrl } from "../lib/config";

export default async function login(args: string[]) {
  // Accept key as first arg, or after --key for backwards compat
  const keyIdx = args.indexOf("--key");
  const key = keyIdx !== -1 ? args[keyIdx + 1] : args[0];

  if (!key || !key.startsWith("lak_")) {
    console.error("Usage: wikis login <account-key>");
    console.error("  Get your key at legendum.co.uk");
    process.exit(1);
  }

  const apiUrl = getApiUrl();

  // Register key with server
  console.log("Logging in...");
  try {
    const res = await fetch(`${apiUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });

    const data = (await res.json()) as { ok: boolean; data?: { email: string }; message?: string };

    if (!data.ok) {
      console.error(`Login failed: ${data.message || "invalid key"}`);
      process.exit(1);
    }

    // Save locally
    const config = readConfig();
    config.account_key = key;
    writeConfig(config);

    console.log(`Logged in as ${data.data?.email}.`);
  } catch (e) {
    console.error(`Could not reach ${apiUrl}: ${(e as Error).message}`);
    process.exit(1);
  }
}
