/**
 * wikis list — show all registered projects.
 */
import { readProjects } from "../lib/config";

export default async function list(_args: string[]) {
  const { projects } = readProjects();

  if (projects.length === 0) {
    console.log("No projects registered. Run 'wikis init' in a project directory.");
    return;
  }

  console.log(`${projects.length} registered project(s):\n`);
  for (const p of projects) {
    const checked = p.last_check ? ` (checked: ${p.last_check.slice(0, 16)})` : "";
    console.log(`  ${p.name}  ${p.path}${checked}`);
  }
}
