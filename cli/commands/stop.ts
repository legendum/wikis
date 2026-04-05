/**
 * wikis stop — stop the background daemon.
 */
import { isDaemonRunning, readDaemonPid, removeDaemonPid } from "../lib/config";

export default async function stop(_args: string[]) {
  if (!isDaemonRunning()) {
    console.log("Daemon is not running.");
    removeDaemonPid();
    return;
  }

  const pid = readDaemonPid();
  if (!pid) {
    console.log("Could not read daemon PID.");
    removeDaemonPid();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID ${pid}).`);
  } catch {
    console.log("Could not stop daemon — process may have already exited.");
  }
  removeDaemonPid();
}
