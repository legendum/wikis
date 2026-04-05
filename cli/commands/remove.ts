/**
 * wikis remove — unregister current project.
 */
import { removeProject } from "../lib/config";

export default async function remove(_args: string[]) {
  const projectDir = process.cwd();
  const removed = removeProject(projectDir);

  if (removed) {
    console.log(`Removed ${projectDir} from registered projects.`);
  } else {
    console.log("This project is not registered. Nothing to remove.");
  }
}
