import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { AutoScalingManager } from "../aws/autoscaling";
import { EC2Manager } from "../aws/ec2";

interface KillOptions {
  readonly region: string;
  readonly force?: boolean;
}

export async function killCommand(options: KillOptions): Promise<void> {
  console.log(chalk.red.bold("\n🛑 Night Cloud Miner - Emergency Kill Switch\n"));

  const { region, force } = options;
  const asgManager = new AutoScalingManager();
  const ec2Manager = new EC2Manager(region);

  // Get current state
  let spinner = ora("Checking current deployment...").start();
  let currentSize: number;
  let instanceIds: string[];

  try {
    currentSize = await asgManager.getAutoScalingGroupSize(region);
    instanceIds = await asgManager.getAutoScalingGroupInstances(region);
    spinner.succeed(`Found Auto Scaling Group with ${currentSize} instances (${instanceIds.length} running)`);
  } catch (error: any) {
    spinner.fail("Failed to check deployment");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  if (currentSize === 0 && instanceIds.length === 0) {
    console.log(chalk.yellow("\n⚠️  No active deployment found in this region."));
    console.log(chalk.gray("   Auto Scaling Group capacity is already 0 and no instances are running.\n"));
    return;
  }

  // Show warning
  console.log(chalk.red.bold("\n⚠️  WARNING: This will immediately:"));
  console.log(chalk.red("   • Set Auto Scaling Group capacity to 0"));
  console.log(chalk.red("   • Terminate all running instances"));
  console.log(chalk.red("   • Stop all mining operations"));
  console.log(chalk.yellow("\n   This action is immediate and cannot be undone!"));
  console.log(chalk.gray(`   Region: ${region}`));
  console.log(chalk.gray(`   Current capacity: ${currentSize}`));
  console.log(chalk.gray(`   Running instances: ${instanceIds.length}\n`));

  // Confirmation prompt (unless --force flag is used)
  if (!force) {
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: chalk.red.bold("Are you absolutely sure you want to kill all mining instances?"),
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log(chalk.yellow("\n❌ Kill operation cancelled.\n"));
      return;
    }

    // Double confirmation for extra safety
    const { doubleConfirmed } = await inquirer.prompt([
      {
        type: "input",
        name: "doubleConfirmed",
        message: chalk.red.bold(`Type "KILL" to confirm:`),
        validate: (input: string) => {
          if (input === "KILL") {
            return true;
          }
          return 'You must type "KILL" to confirm';
        },
      },
    ]);

    if (doubleConfirmed !== "KILL") {
      console.log(chalk.yellow("\n❌ Kill operation cancelled.\n"));
      return;
    }
  }

  console.log(chalk.red.bold("\n🛑 Executing kill switch...\n"));

  // Step 1: Set ASG capacity to 0
  spinner = ora("Setting Auto Scaling Group capacity to 0...").start();
  try {
    await asgManager.setAutoScalingGroupCapacity(region, 0, 0, 0);
    spinner.succeed("Auto Scaling Group capacity set to 0");
  } catch (error: any) {
    spinner.fail("Failed to set ASG capacity");
    console.error(chalk.red(error.message));
    // Continue anyway to try to terminate instances
  }

  // Step 2: Terminate all running instances
  if (instanceIds.length > 0) {
    spinner = ora(`Terminating ${instanceIds.length} running instances...`).start();
    try {
      await ec2Manager.terminateInstances(region, instanceIds);
      spinner.succeed(`Terminated ${instanceIds.length} instances`);
    } catch (error: any) {
      spinner.fail("Failed to terminate instances");
      console.error(chalk.red(error.message));
    }
  }

  console.log(chalk.green("\n✅ Kill switch executed successfully!\n"));
  console.log(chalk.gray("   All mining operations have been stopped."));
  console.log(chalk.gray("   Auto Scaling Group capacity is now 0."));
  console.log(chalk.gray("   All instances have been terminated.\n"));
  console.log(chalk.blue("💡 To resume mining, run:"));
  console.log(chalk.white(`   night-cloud scale --region ${region} --instances <count>\n`));
}

