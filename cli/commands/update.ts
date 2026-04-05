import { $ } from "bun";
import { resolve } from "path";

export default async function update(_args: string[]) {
  const srcDir = resolve(process.env.HOME || "~", ".config/wikis/src");
  console.log("Updating wikis...");
  await $`cd ${srcDir} && git pull && bun install`;
  console.log("Updated.");
}
