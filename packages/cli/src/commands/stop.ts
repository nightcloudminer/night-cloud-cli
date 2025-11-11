import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { loadConfig } from "../config";
import { AutoScalingManager } from "../aws/autoscaling";
import { StopOptions } from "../types";

export async function stopCommand(options: StopOptions): Promise<void> {
  console.log(chalk.blue.bold("\n🛑 Night Cloud Miner - Stop\n"));

  const config = loadConfig();
  const asgManager = new AutoScalingManager();

  const regions = options.region ? [options.region] : config.awsRegions;

  if (options.terminate) {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: chalk.red("This will TERMINATE all instances. Are you sure?"),
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("Operation cancelled."));
      return;
    }
  }

  for (const region of regions) {
    console.log(chalk.gray(`\nStopping in ${region}...`));

    const spinner = ora("Scaling down...").start();

    try {
      if (options.terminate) {
        await asgManager.deleteAutoScalingGroup(region, true);
        spinner.succeed(`Terminated all instances in ${region}`);
      } else {
        await asgManager.scaleAutoScalingGroup(region, 0);
        spinner.succeed(`Scaled down to 0 instances in ${region}`);
      }
    } catch (error: any) {
      spinner.fail(`Failed to stop in ${region}`);
      console.error(chalk.red(error.message));
    }
  }

  console.log(chalk.green("\n✅ Stop complete!\n"));
}
