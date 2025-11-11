#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { MiningOrchestrator } from "./mining-orchestrator";
import * as fs from "fs";

yargs(hideBin(process.argv))
  .scriptName("night-miner")
  .usage("🌙 Night Cloud Miner - Standalone mining orchestrator")
  .version("1.0.0")
  .alias("v", "version")
  .alias("h", "help")
  .demandCommand(1, "You need to specify a command")
  .strict()
  .recommendCommands()
  .fail((msg, err) => {
    if (err) {
      console.error("❌ Fatal error:", err.message);
      process.exit(1);
    }
    console.error("❌", msg);
    process.exit(1);
  })
  // Start command
  .command(
    "start",
    "Start mining with assigned addresses",
    (yargs) => {
      return yargs
        .option("addresses", {
          type: "string",
          description: "Comma-separated list of Cardano addresses",
          demandOption: true,
        })
        .option("rust-binary", {
          type: "string",
          description: "Path to Rust miner binary",
        })
        .option("poll-interval", {
          type: "number",
          description: "Challenge polling interval in ms",
          default: 60000,
        })
        .option("workers", {
          type: "number",
          description: "Number of worker processes (defaults to CPU cores)",
        })
        .option("region", {
          type: "string",
          description: "AWS region (for solution tracking)",
          demandOption: true,
        });
    },
    async (argv) => {
      const addresses = argv.addresses.split(",").map((a: string) => a.trim());
      const workerCount = argv.workers;
      const region = argv.region;
      const apiUrl = "https://scavenger.prod.gd.midnighttge.io";

      console.log("🌙 Night Cloud Miner");
      console.log("===================\n");
      console.log(`API URL: ${apiUrl}`);
      console.log(`Addresses: ${addresses.length}`);
      console.log(`Poll interval: ${argv["poll-interval"]}ms`);
      console.log(`Region: ${region}`);
      console.log();

      const orchestrator = new MiningOrchestrator(addresses, apiUrl, region, argv["rust-binary"], workerCount);

      orchestrator.setChallengeFetchInterval(argv["poll-interval"]);

      // Handle graceful shutdown
      process.on("SIGINT", () => {
        console.log("\n\n🛑 Shutting down gracefully...");
        orchestrator.stop();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        console.log("\n\n🛑 Shutting down gracefully...");
        orchestrator.stop();
        process.exit(0);
      });

      await orchestrator.start();
    },
  )
  // Start from file command
  .command(
    "start-from-file",
    "Start mining with addresses from a file",
    (yargs) => {
      return yargs
        .option("file", {
          type: "string",
          description: "Path to file containing addresses (one per line)",
          demandOption: true,
        })
        .option("rust-binary", {
          type: "string",
          description: "Path to Rust miner binary",
        })
        .option("poll-interval", {
          type: "number",
          description: "Challenge polling interval in ms",
          default: 60000,
        })
        .option("workers", {
          type: "number",
          description: "Number of worker processes (defaults to CPU cores)",
        })
        .option("region", {
          type: "string",
          description: "AWS region (for solution tracking)",
          demandOption: true,
        });
    },
    async (argv) => {
      // Read addresses from file
      const fileContent = fs.readFileSync(argv.file, "utf-8");
      const addresses = fileContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      if (addresses.length === 0) {
        console.error("❌ No addresses found in file");
        process.exit(1);
      }

      const workerCount = argv.workers;
      const region = argv.region;
      const apiUrl = "https://scavenger.prod.gd.midnighttge.io";

      console.log("🌙 Night Cloud Miner");
      console.log("===================\n");
      console.log(`API URL: ${apiUrl}`);
      console.log(`Addresses loaded: ${addresses.length}`);
      console.log(`Poll interval: ${argv["poll-interval"]}ms`);
      console.log(`Region: ${region}`);
      console.log();

      const orchestrator = new MiningOrchestrator(addresses, apiUrl, region, argv["rust-binary"], workerCount);

      orchestrator.setChallengeFetchInterval(argv["poll-interval"]);

      // Handle graceful shutdown
      process.on("SIGINT", () => {
        console.log("\n\n🛑 Shutting down gracefully...");
        orchestrator.stop();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        console.log("\n\n🛑 Shutting down gracefully...");
        orchestrator.stop();
        process.exit(0);
      });

      await orchestrator.start();
    },
  )
  .parse();
