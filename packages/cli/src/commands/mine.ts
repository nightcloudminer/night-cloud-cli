import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../config";
import { CardanoWalletManager } from "../utils/cardano-wallet";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface MineCommandOptions {
  readonly region: string;
  readonly addresses?: number;
  readonly workers?: number;
  readonly pollInterval: number;
}

export async function mineCommand(options: MineCommandOptions): Promise<void> {
  console.log(chalk.blue.bold("\n⛏️  Night Cloud Miner - Local Mining\n"));

  const config = loadConfig();
  const walletManager = new CardanoWalletManager(config.apiUrl, config.keysDirectory, options.region);

  // Load wallets
  const spinner = ora("Loading wallets...").start();
  const wallets = walletManager.loadAllWallets();

  if (wallets.length === 0) {
    spinner.fail("No wallets found");
    console.error(
      chalk.red(`Please generate wallets first with: night-cloud wallet --region ${options.region} --generate <count>`),
    );
    process.exit(1);
  }

  spinner.succeed(`Loaded ${wallets.length} wallet(s)`);

  // Limit addresses if requested
  let addressesToMine = wallets.map((w) => w.address);
  if (options.addresses && options.addresses < addressesToMine.length) {
    addressesToMine = addressesToMine.slice(0, options.addresses);
    console.log(chalk.gray(`Using first ${options.addresses} address(es)`));
  }

  // Find the miner binary
  // When bundled, __dirname points to the bundled file location
  // We need to find the actual project root by looking for package.json
  let projectRoot = process.cwd();

  // Try to find project root by going up directories until we find the root package.json
  let currentDir = __dirname;
  for (let i = 0; i < 10; i++) {
    const potentialRoot = path.resolve(currentDir, "../".repeat(i));
    const packageJsonPath = path.join(potentialRoot, "package.json");
    const minerPath = path.join(potentialRoot, "packages/miner/rust/target/release/night-cloud");

    if (fs.existsSync(packageJsonPath) && fs.existsSync(minerPath)) {
      projectRoot = potentialRoot;
      break;
    }
  }

  const minerBinary = path.join(projectRoot, "packages/miner/rust/target/release/night-cloud");
  const minerCli = path.join(projectRoot, "packages/miner/dist/cli.js");

  // Check if miner is built
  if (!fs.existsSync(minerBinary)) {
    console.error(chalk.red("\n❌ Rust miner binary not found!"));
    console.log(chalk.yellow("\nPlease build the miner first:"));
    console.log(chalk.gray("  pnpm run build\n"));
    process.exit(1);
  }

  if (!fs.existsSync(minerCli)) {
    console.error(chalk.red("\n❌ Miner CLI not found!"));
    console.log(chalk.yellow("\nPlease build the miner first:"));
    console.log(chalk.gray("  pnpm run build\n"));
    process.exit(1);
  }

  // Start mining
  console.log(chalk.green("\n🚀 Starting local miner...\n"));
  console.log(chalk.gray(`Region: ${options.region}`));
  console.log(chalk.gray(`Addresses: ${addressesToMine.length}`));
  console.log(chalk.gray(`Workers: ${options.workers || "auto (CPU cores)"}`));
  console.log(chalk.gray(`Poll interval: ${options.pollInterval}ms`));
  console.log(chalk.gray(`Rust binary: ${minerBinary}`));
  console.log();

  const args = [
    minerCli,
    "start",
    "--addresses",
    addressesToMine.join(","),
    "--rust-binary",
    minerBinary,
    "--poll-interval",
    options.pollInterval.toString(),
    "--region",
    options.region,
  ];

  if (options.workers) {
    args.push("--workers", options.workers.toString());
  }

  const miner = spawn("node", args, {
    stdio: "inherit",
    cwd: path.join(projectRoot, "packages/miner"),
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n🛑 Stopping miner..."));
    miner.kill("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log(chalk.yellow("\n\n🛑 Stopping miner..."));
    miner.kill("SIGTERM");
    process.exit(0);
  });

  miner.on("exit", (code) => {
    if (code !== 0) {
      console.error(chalk.red(`\n❌ Miner exited with code ${code}`));
      process.exit(code || 1);
    }
  });
}
