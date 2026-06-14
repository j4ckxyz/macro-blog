#!/usr/bin/env bun
import { CONFIG_PATH, loadConfig, saveConfig } from "./lib/config.ts";
import { hashPassword, randomToken } from "./lib/indieauth.ts";
import { getDb } from "./db/index.ts";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);

async function prompt(question: string, mask = false): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function main() {
  if (args.includes("--migrate")) {
    getDb();
    console.log("✓ Database migrated");
    return;
  }

  if (args.includes("--backup")) {
    const { createBackup } = await import("./services/backup.ts");
    const file = await createBackup();
    console.log("✓ Backup written to", file);
    return;
  }

  if (args.includes("--restore")) {
    const idx = args.indexOf("--restore");
    const file = args[idx + 1];
    if (!file) {
      console.error("Usage: bun run macroblog --restore <backup.tar.gz>");
      process.exit(1);
    }
    const { restoreBackup } = await import("./services/backup.ts");
    await restoreBackup(file);
    console.log("✓ Restored from", file, "— restart Macroblog and rebuild.");
    return;
  }

  if (args.includes("--gen-secret")) {
    const secret = randomToken(48);
    saveConfig({ auth: { session_secret: secret } as any });
    console.log("✓ session_secret written to", CONFIG_PATH);
    return;
  }

  if (args.includes("--set-password")) {
    if (!existsSync(CONFIG_PATH)) {
      console.error(`Config not found at ${CONFIG_PATH}. Copy macroblog.config.yaml.example first.`);
      process.exit(1);
    }
    const pw = await prompt("New password: ");
    if (!pw) {
      console.error("Password cannot be empty.");
      process.exit(1);
    }
    const hash = await hashPassword(pw);
    saveConfig({ auth: { password_hash: hash } as any });
    console.log("✓ password_hash written to", CONFIG_PATH);
    return;
  }

  console.log(`Macroblog CLI

Usage:
  bun run macroblog --set-password    Set the IndieAuth login password
  bun run macroblog --gen-secret      Generate and store a session secret
  bun run macroblog --migrate         Run database migrations
  bun run macroblog --backup          Create a backup archive (backups/)
  bun run macroblog --restore <file>  Restore from a backup archive

Config: ${CONFIG_PATH}`);
}

main();
