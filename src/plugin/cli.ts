import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { updateOpencodeConfig } from "./config/updater";

// TODO: Add UI module (./ui/auth-menu) — stubbed for now
export type AccountStatus = "active" | "rate-limited" | "cooling-down" | "disabled" | "verification-required";

interface AccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
}

function isTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

export async function promptProjectId(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Project ID (leave blank to use your default project): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Add another account? (${currentCount} added) (y/n): `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export type LoginMode = "add" | "remove" | "fresh" | "configure-models" | "cancel";

export interface ExistingAccountInfo {
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: AccountStatus;
  isCurrentAccount?: boolean;
  enabled?: boolean;
}

export interface LoginMenuResult {
  mode: LoginMode;
}

async function promptLoginModeFallback(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
  const rl = createInterface({ input, output });
  try {
    console.log(`\n${existingAccounts.length} account(s) saved:`);
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`;
      console.log(`  ${acc.index + 1}. ${label}`);
    }
    console.log("");

    while (true) {
      const answer = await rl.question("(a)dd, (r)emove, (f)resh, (m)odels config, (c)ancel? [a/r/f/m/c]: ");
      const normalized = answer.trim().toLowerCase();

      if (normalized === "a" || normalized === "add") {
        return { mode: "add" };
      }
      if (normalized === "r" || normalized === "remove") {
        return { mode: "remove" };
      }
      if (normalized === "f" || normalized === "fresh") {
        return { mode: "fresh" };
      }
      if (
        normalized === "m" ||
        normalized === "model" ||
        normalized === "models" ||
        normalized === "configure" ||
        normalized === "configure-models"
      ) {
        const result = await updateOpencodeConfig();
        if (result.success) {
          console.log(`\n✓ Models configured in ${result.configPath}\n`);
        } else {
          console.log(`\n✗ Failed to configure models: ${result.error}\n`);
        }
        continue;
      }
      if (normalized === "c" || normalized === "cancel") {
        return { mode: "cancel" };
      }

      console.log("Please enter 'a', 'r', 'f', 'm', or 'c'.");
    }
  } finally {
    rl.close();
  }
}

export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
  // TODO: Restore interactive UI menu once ./ui/auth-menu module is added
  return promptLoginModeFallback(existingAccounts);
}

export async function promptRemoveAccount(existingAccounts: ExistingAccountInfo[]): Promise<number | null> {
  if (!existingAccounts.length) return null;

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Remove which account? [1-${existingAccounts.length}] (blank to cancel): `,
    );
    const trimmed = answer.trim();
    if (!trimmed) return null;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1 || n > existingAccounts.length) {
      console.log(`Invalid selection. Please enter a number between 1 and ${existingAccounts.length}.`);
      return null;
    }
    return n - 1;
  } finally {
    rl.close();
  }
}

export { isTTY };
