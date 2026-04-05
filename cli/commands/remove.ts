/**
 * wikis remove — unregister current project and delete all data.
 */
import { existsSync, readFileSync, rmSync } from 'fs';
import yaml from 'js-yaml';
import { resolve } from 'path';
import { getAccountKey, getApiUrl, removeProject } from '../lib/config';

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  for await (const line of console) {
    return line.trim();
  }
  return '';
}

export default async function remove(_args: string[]) {
  const projectDir = process.cwd();
  const wikiDir = resolve(projectDir, 'wiki');
  const configPath = resolve(wikiDir, 'config.yml');

  // Check if wiki exists
  if (!existsSync(configPath)) {
    console.log('No wiki found in this project.');
    return;
  }

  // Confirm
  const answer = await prompt(
    'Are you sure? This will permanently delete the wiki folder and remove it from the server. (y/N): '
  );
  if (!['y', 'yes', 'Y', 'Yes'].includes(answer)) {
    console.log('Cancelled.');
    return;
  }

  // Read config to get wiki name
  const config = yaml.load(readFileSync(configPath, 'utf8')) as {
    name: string;
  };
  const wikiName = config.name;

  // Remove from server
  const accountKey = getAccountKey();
  if (accountKey) {
    const apiUrl = getApiUrl();
    try {
      const response = await fetch(`${apiUrl}/api/wikis/${wikiName}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accountKey}`,
        },
      });
      if (response.ok) {
        console.log(`Removed wiki "${wikiName}" from server.`);
      } else {
        console.error(`Failed to remove from server: ${response.status}`);
      }
    } catch (e) {
      console.error(`Error removing from server: ${(e as Error).message}`);
    }
  }

  // Remove from daemon
  const removed = removeProject(projectDir);
  if (removed) {
    console.log(`Removed ${projectDir} from registered projects.`);
  }

  // Delete wiki folder
  try {
    rmSync(wikiDir, { recursive: true, force: true });
    console.log(`Deleted wiki folder: ${wikiDir}`);
  } catch (e) {
    console.error(`Failed to delete wiki folder: ${(e as Error).message}`);
  }

  console.log('Done.');
}
