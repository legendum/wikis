/**
 * wikis start — start the background daemon.
 */
import { resolve } from "path";
import { isDaemonRunning } from "../lib/config";

export default async function start(_args: string[]) {
  if (isDaemonRunning()) {
    console.log("Daemon is already running.");
    return;
  }

  const daemonScript = resolve(import.meta.dir, "../lib/daemon.ts");

  const proc = Bun.spawn(["bun", "run", daemonScript], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });

  // Detach so the daemon outlives this process
  proc.unref();

  console.log(`Daemon started (PID ${proc.pid}).`);
  console.log("Source files will be checked every 5 minutes.");
}
