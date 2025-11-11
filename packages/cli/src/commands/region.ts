import chalk from "chalk";
import { loadConfig, saveConfig } from "../config";
import { deployCommand } from "./deploy";
import { RegionAddOptions } from "../types";

export const regionCommand = {
  async add(region: string, options: RegionAddOptions): Promise<void> {
    console.log(chalk.blue.bold(`\n🌍 Adding region: ${region}\n`));

    const config = loadConfig();

    if (config.awsRegions.includes(region)) {
      console.log(chalk.yellow(`Region ${region} already configured`));
      return;
    }

    // Add region to config
    config.awsRegions.push(region);
    saveConfig(config);

    console.log(chalk.green(`✅ Added ${region} to configuration\n`));

    // Deploy to new region
    await deployCommand({
      region,
      instances: options.instances,
      addressesPerInstance: config.addressesPerInstance,
    });
  },

  async list(): Promise<void> {
    console.log(chalk.blue.bold("\n🌍 Configured Regions\n"));

    const config = loadConfig();

    if (config.awsRegions.length === 0) {
      console.log(chalk.gray("No regions configured\n"));
      return;
    }

    config.awsRegions.forEach((region) => {
      console.log(chalk.white(`  • ${region}`));
    });
    console.log();
  },

  async remove(region: string): Promise<void> {
    console.log(chalk.blue.bold(`\n🌍 Removing region: ${region}\n`));

    const config = loadConfig();

    if (!config.awsRegions.includes(region)) {
      console.log(chalk.yellow(`Region ${region} not configured`));
      return;
    }

    saveConfig({
      ...config,
      awsRegions: config.awsRegions.filter((r) => r !== region),
    });

    console.log(chalk.green(`✅ Removed ${region} from configuration\n`));
    console.log(chalk.yellow("Note: Instances in this region are still running."));
    console.log(chalk.gray('Run "night stop --region ' + region + '" to terminate them.\n'));
  },
};
