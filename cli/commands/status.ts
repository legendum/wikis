/**
 * wikis status — show daemon health and current project state.
 */
import { isDaemonRunning, readDaemonPid, readProjects } from "../lib/config";

export default async function status(_args: string[]) {
  // Daemon status
  const running = isDaemonRunning();
  const pid = readDaemonPid();
  if (running) {
    console.log(`Daemon: running (PID ${pid})`);
  } else {
    console.log("Daemon: not running");
  }

  // Current project status
  const projectDir = process.cwd();
  const { projects } = readProjects();
  const project = projects.find((p) => p.path === projectDir);

  if (project) {
    console.log();
    console.log(`Project: ${project.name}`);
    console.log(`Path:    ${project.path}`);
    console.log(`Checked: ${project.last_check || "never"}`);
  } else if (projects.length > 0) {
    console.log();
    console.log("This directory is not a registered project.");
    console.log(
      `${projects.length} project(s) registered — run 'wikis list' to see them.`,
    );
  }
}
