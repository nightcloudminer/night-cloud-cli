import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../config";
import { CardanoWalletManager } from "../utils/cardano-wallet";
import { table } from "table";

export interface WalletCommandOptions {
  readonly generate?: number;
  readonly register?: boolean;
  readonly list?: boolean;
  readonly start?: number;
  readonly region?: string;
  readonly auto?: boolean;
}

export async function walletCommand(options: WalletCommandOptions): Promise<void> {
  console.log(chalk.blue.bold("\n💼 Night Cloud Miner - Wallet Management\n"));

  const config = loadConfig();
  const region = options.region;
  const walletManager = new CardanoWalletManager(config.apiUrl, config.keysDirectory, region);

  try {
    // Auto mode: continuously generate 50 wallets with 60s cooldown
    if (options.auto) {
      if (!region) {
        console.log(chalk.red("Error: --region is required for auto mode"));
        console.log(chalk.gray("Example: night wallet --region ap-south-1 --auto"));
        process.exit(1);
      }

      console.log(chalk.blue.bold("🤖 Auto Mode Enabled"));
      console.log(chalk.gray("Generating 50 wallets per batch with 60s cooldown between batches"));
      console.log(chalk.gray("Press Ctrl+C to stop\n"));

      let batchNumber = 1;

      while (true) {
        try {
          const startNumber = walletManager.getNextMinerNumber();

          console.log(chalk.cyan(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
          console.log(chalk.cyan(`Batch #${batchNumber} - Starting from miner${startNumber}`));
          console.log(chalk.cyan(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

          const spinner = ora("Generating 50 wallets...").start();

          const wallets = await walletManager.generateWallets({
            startNumber,
            count: 50,
          });

          spinner.succeed(`Generated ${wallets.length} wallets (miner${startNumber} - miner${startNumber + 49})`);

          // Register wallets
          console.log(chalk.blue("\nRegistering wallets with Scavenger Mine API...\n"));

          const regSpinner = ora("Registering wallets...").start();

          const results = await walletManager.registerWallets(wallets);
          const successful = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          if (failed === 0) {
            regSpinner.succeed(`All ${successful} wallets registered successfully`);
          } else {
            regSpinner.warn(`${successful} succeeded, ${failed} failed`);

            // Show failed registrations
            console.log(chalk.red("\nFailed registrations:"));
            results
              .filter((r) => !r.success)
              .forEach((r) => {
                console.log(chalk.red(`  ✗ ${r.address}: ${r.error}`));
              });
          }

          console.log(chalk.green(`\n✓ Batch #${batchNumber} complete!`));
          console.log(chalk.gray(`Total wallets created: ${startNumber + 50}`));

          // Cooldown
          console.log(chalk.yellow(`\n⏳ Cooling down for 60 seconds to avoid rate limits...`));

          for (let i = 60; i > 0; i--) {
            process.stdout.write(chalk.gray(`\r   ${i}s remaining...`));
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          process.stdout.write("\r" + " ".repeat(50) + "\r"); // Clear the countdown line

          batchNumber++;
        } catch (error: any) {
          console.error(chalk.red(`\n✗ Error in batch #${batchNumber}: ${error.message}`));
          console.log(chalk.yellow("Waiting 60 seconds before retrying...\n"));

          for (let i = 60; i > 0; i--) {
            process.stdout.write(chalk.gray(`\r   ${i}s remaining...`));
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          process.stdout.write("\r" + " ".repeat(50) + "\r");
          batchNumber++;
        }
      }
    }

    // List existing wallets
    if (options.list) {
      if (region) {
        // List wallets for specific region
        const wallets = walletManager.loadAllWallets();

        if (wallets.length === 0) {
          console.log(chalk.yellow(`No wallets found for region: ${region}`));
          console.log(chalk.gray(`Generate wallets with: night wallet --region ${region} --generate <count>`));
          return;
        }

        console.log(chalk.blue(`Found ${wallets.length} wallets for ${region}:\n`));

        const tableData: string[][] = [["Miner #", "Address", "Status"]];

        for (const wallet of wallets) {
          tableData.push([
            `miner${wallet.minerNumber}`,
            wallet.address.substring(0, 20) + "..." + wallet.address.substring(wallet.address.length - 10),
            chalk.green("✓"),
          ]);
        }

        console.log(table(tableData));
        console.log(chalk.gray(`\nKeys directory: ${config.keysDirectory}/${region}`));
      } else {
        // List all regions and their wallet counts
        const regions = CardanoWalletManager.getAvailableRegions(config.keysDirectory);

        if (regions.length === 0) {
          console.log(chalk.yellow("No wallets found."));
          console.log(chalk.gray("Generate wallets with: night wallet --region <region> --generate <count>"));
          return;
        }

        console.log(chalk.blue("Wallet summary by region:\n"));

        const tableData: string[][] = [["Region", "Wallet Count"]];

        for (const reg of regions) {
          const regManager = new CardanoWalletManager(config.apiUrl, config.keysDirectory, reg);
          const wallets = regManager.loadAllWallets();
          tableData.push([reg, wallets.length.toString()]);
        }

        console.log(table(tableData));
        console.log(chalk.gray(`\nKeys directory: ${config.keysDirectory}`));
        console.log(chalk.gray(`\nTo see wallets for a specific region: night wallet --region <region> --list`));
      }
      return;
    }

    // Generate new wallets
    if (options.generate && options.generate > 0) {
      if (!region) {
        console.log(chalk.red("Error: --region is required when generating wallets"));
        console.log(chalk.gray("Example: night wallet --region ap-south-1 --generate 10"));
        process.exit(1);
      }

      const count = options.generate;
      const startNumber = options.start || walletManager.getNextMinerNumber();

      console.log(chalk.blue(`Generating ${count} wallet(s) for ${region} starting from miner${startNumber}...\n`));

      const spinner = ora("Generating wallets...").start();

      try {
        const wallets = await walletManager.generateWallets({
          startNumber,
          count,
        });

        spinner.succeed(`Generated ${wallets.length} wallet(s)`);

        // Register if requested
        if (options.register) {
          console.log(chalk.blue("\nRegistering wallets with Scavenger Mine API...\n"));

          const regSpinner = ora("Registering wallets...").start();

          const results = await walletManager.registerWallets(wallets);
          const successful = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          if (failed === 0) {
            regSpinner.succeed(`All ${successful} wallet(s) registered successfully`);
          } else {
            regSpinner.warn(`${successful} succeeded, ${failed} failed`);

            // Show failed registrations
            console.log(chalk.red("\nFailed registrations:"));
            results
              .filter((r) => !r.success)
              .forEach((r) => {
                console.log(chalk.red(`  ✗ ${r.address}: ${r.error}`));
              });
          }
        }

        console.log(chalk.green("\n✓ Wallet generation complete!"));
        console.log(chalk.gray(`Keys saved to: ${config.keysDirectory}/${region}`));

        if (!options.register) {
          console.log(chalk.yellow("\nNote: Wallets were not registered (--register=false was specified)."));
          console.log(chalk.gray(`Register them later with: night-cloud wallet --region ${region} --register`));
        }
      } catch (error: any) {
        spinner.fail("Failed to generate wallets");
        throw error;
      }
      return;
    }

    // Register existing wallets
    if (options.register && !options.generate) {
      if (!region) {
        console.log(chalk.red("Error: --region is required when registering wallets"));
        console.log(chalk.gray("Example: night wallet --region ap-south-1 --register"));
        process.exit(1);
      }

      const wallets = walletManager.loadAllWallets();

      if (wallets.length === 0) {
        console.log(chalk.yellow(`No wallets found to register for region: ${region}`));
        console.log(chalk.gray(`Generate wallets first with: night wallet --region ${region} --generate <count>`));
        return;
      }

      console.log(chalk.blue(`Registering ${wallets.length} wallet(s) for ${region}...\n`));

      const spinner = ora("Registering wallets...").start();

      try {
        const results = await walletManager.registerWallets(wallets);
        const successful = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        if (failed === 0) {
          spinner.succeed(`All ${successful} wallet(s) registered successfully`);
        } else {
          spinner.warn(`${successful} succeeded, ${failed} failed`);

          // Show failed registrations
          console.log(chalk.red("\nFailed registrations:"));
          results
            .filter((r) => !r.success)
            .forEach((r) => {
              console.log(chalk.red(`  ✗ ${r.address}: ${r.error}`));
            });
        }
      } catch (error: any) {
        spinner.fail("Failed to register wallets");
        throw error;
      }
      return;
    }

    // No options provided, show help
    console.log(chalk.yellow("No action specified.\n"));
    console.log("Available commands:");
    console.log(chalk.gray("  night wallet --list                                    List all regions"));
    console.log(chalk.gray("  night wallet --region <region> --list                  List wallets for region"));
    console.log(chalk.gray("  night wallet --region <region> --generate <count>      Generate wallets"));
    console.log(chalk.gray("  night wallet --region <region> --generate 10 --register  Generate and register"));
    console.log(chalk.gray("  night wallet --region <region> --register              Register existing wallets"));
    console.log(chalk.gray("  night wallet --region <region> --generate 5 --start 100  Start from miner100"));
  } catch (error: any) {
    console.error(chalk.red(`\n✗ Error: ${error.message}`));
    process.exit(1);
  }
}
