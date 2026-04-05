import { resolve } from "node:path";
import { $ } from "bun";

export default async function update(_args: string[]) {
  const srcDir = resolve(process.env.HOME || "~", ".config/wikis/src");
  console.log("Updating wikis...");
  await $`cd ${srcDir} && git pull && bun install`;
  console.log("Updated.");
}
