#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";
import { initCommand } from "./commands/init";
import { deployCommand } from "./commands/deploy";
import { regionCommand } from "./commands/region";
import { statusCommand } from "./commands/status";
import { scaleCommand } from "./commands/scale";
import { stopCommand } from "./commands/stop";
import { walletCommand } from "./commands/wallet";
import { logsCommand } from "./commands/logs";
import { mineCommand } from "./commands/mine";
import { dashboardCommand } from "./commands/dashboard";
import { killCommand } from "./commands/kill";

// Read version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const version = packageJson.version;

yargs(hideBin(process.argv))
  .scriptName("night-cloud")
  .usage("☁️⛏️  Night Cloud Miner - One-click AWS mining infrastructure")
  .version(version)
  .alias("v", "version")
  .alias("h", "help")
  .demandCommand(1, "You need to specify a command")
  .strict()
  .recommendCommands()
  .fail((msg, err) => {
    if (err) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    console.error(chalk.red(msg));
    process.exit(1);
  })
  // Init command
  .command(
    "init",
    "Initialize configuration and validate AWS credentials",
    () => {},
    async () => {
      await initCommand();
    },
  )
  // Deploy command
  .command(
    "deploy",
    "Deploy mining infrastructure to AWS",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region",
          default: "ap-south-1",
        })
        .option("instances", {
          alias: "i",
          type: "number",
          description: "Number of instances (will calculate if not provided)",
        })
        .option("addresses-per-instance", {
          alias: "m",
          type: "number",
          description: "Number of addresses to mine per instance",
          default: 10,
        })
        .option("instance", {
          type: "string",
          description: "Deploy to specific instance",
        })
        .option("force", {
          type: "boolean",
          description: "Force redeploy",
          default: false,
        })
        .option("refresh", {
          type: "boolean",
          description: "Trigger instance refresh to deploy new code to existing instances",
          default: false,
        })
        .option("all-zones", {
          type: "boolean",
          description: "Automatically select all availability zones (skip interactive selection)",
          default: false,
        });
    },
    async (argv) => {
      await deployCommand({
        region: argv.region,
        instances: argv.instances as number | undefined,
        addressesPerInstance: argv["addresses-per-instance"],
        instance: argv.instance,
        force: argv.force,
        refresh: argv.refresh,
        allZones: argv["all-zones"],
      });
    },
  )
  // Status command
  .command(
    "status",
    "Show current deployment status",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "Filter by region",
        })
        .option("verbose", {
          alias: "v",
          type: "boolean",
          description: "Show detailed information",
          default: false,
        });
    },
    async (argv) => {
      await statusCommand({
        region: argv.region,
        verbose: argv.verbose,
      });
    },
  )
  // Scale command
  .command(
    "scale",
    "Scale instances up or down",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region",
          demandOption: true,
        })
        .option("instances", {
          alias: "i",
          type: "number",
          description: "Target number of instances",
          demandOption: true,
        });
    },
    async (argv) => {
      await scaleCommand({
        region: argv.region,
        instances: argv.instances,
      });
    },
  )
  // Stop command
  .command(
    "stop",
    "Stop mining in a region",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region (all if not specified)",
        })
        .option("terminate", {
          type: "boolean",
          description: "Terminate instances (default: just stop mining)",
          default: false,
        });
    },
    async (argv) => {
      await stopCommand({
        region: argv.region,
        terminate: argv.terminate,
      });
    },
  )
  // Kill command (emergency stop)
  .command(
    "kill",
    "🛑 Emergency kill switch - immediately terminate ALL instances",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region",
          demandOption: true,
        })
        .option("force", {
          alias: "f",
          type: "boolean",
          description: "Skip confirmation prompts (dangerous!)",
          default: false,
        });
    },
    async (argv) => {
      await killCommand({
        region: argv.region,
        force: argv.force,
      });
    },
  )
  // Wallet command
  .command(
    "wallet",
    "Manage Cardano wallets",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region for wallet management",
        })
        .option("generate", {
          alias: "g",
          type: "number",
          description: "Generate N new wallets",
        })
        .option("list", {
          alias: "l",
          type: "boolean",
          description: "List all wallets",
        })
        .option("register", {
          type: "boolean",
          description: "Register wallets with the API",
          default: true,
        })
        .option("start", {
          alias: "s",
          type: "number",
          description: "Starting miner number",
          default: 0,
        })
        .option("auto", {
          type: "boolean",
          description: "Auto mode: continuously generate 50 wallets with 60s cooldown",
          default: false,
        });
    },
    async (argv) => {
      await walletCommand({
        region: argv.region,
        generate: argv.generate,
        list: argv.list,
        register: argv.register,
        start: argv.start,
        auto: argv.auto,
      });
    },
  )
  // Logs command
  .command(
    "logs",
    "View CloudWatch logs from instances",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "AWS region",
          demandOption: true,
        })
        .option("instance", {
          alias: "i",
          type: "string",
          description: "Instance ID (shows all if not specified)",
        })
        .option("follow", {
          alias: "f",
          type: "boolean",
          description: "Follow log output",
          default: false,
        })
        .option("lines", {
          alias: "n",
          type: "number",
          description: "Number of lines to show",
          default: 100,
        });
    },
    async (argv) => {
      await logsCommand({
        region: argv.region,
        instance: argv.instance,
        follow: argv.follow,
        lines: argv.lines,
      });
    },
  )
  // Dashboard command
  .command(
    "dashboard",
    "Live dashboard monitoring all regions at once",
    (yargs) => {
      return yargs
        .option("refresh", {
          type: "number",
          description: "Refresh interval in seconds",
          default: 10,
        })
        .option("reset-session", {
          type: "boolean",
          description: "Reset session counters (keeps total counts)",
          default: false,
        });
    },
    async (argv) => {
      await dashboardCommand({
        refresh: argv.refresh,
        resetSession: argv["reset-session"],
      });
    },
  )
  // Mine command (local testing)
  .command(
    "mine",
    "Start mining locally (for testing)",
    (yargs) => {
      return yargs
        .option("region", {
          alias: "r",
          type: "string",
          description: "Region to load wallets from",
          demandOption: true,
        })
        .option("addresses", {
          alias: "a",
          type: "number",
          description: "Number of addresses to mine with (default: all)",
        })
        .option("workers", {
          alias: "w",
          type: "number",
          description: "Number of worker processes (default: CPU cores)",
        })
        .option("poll-interval", {
          alias: "p",
          type: "number",
          description: "Challenge polling interval in ms",
          default: 60000,
        });
    },
    async (argv) => {
      await mineCommand({
        region: argv.region,
        addresses: argv.addresses,
        workers: argv.workers,
        pollInterval: argv["poll-interval"],
      });
    },
  )
  // Region command
  .command(
    "region",
    "Manage AWS regions",
    (yargs) => {
      return yargs
        .command(
          "add <region>",
          "Add a new region",
          (yargs) => {
            return yargs
              .positional("region", {
                type: "string",
                description: "AWS region name",
              })
              .option("instances", {
                alias: "i",
                type: "number",
                description: "Number of instances",
                default: 50,
              });
          },
          async (argv) => {
            await regionCommand.add(argv.region!, {
              instances: argv.instances,
            });
          },
        )
        .command(
          "list",
          "List all regions",
          () => {},
          async () => {
            await regionCommand.list();
          },
        )
        .command(
          "remove <region>",
          "Remove a region",
          (yargs) => {
            return yargs.positional("region", {
              type: "string",
              description: "AWS region name",
            });
          },
          async (argv) => {
            await regionCommand.remove(argv.region!);
          },
        )
        .demandCommand(1, "You need to specify a region subcommand");
    },
    () => {},
  )
  .parse();
