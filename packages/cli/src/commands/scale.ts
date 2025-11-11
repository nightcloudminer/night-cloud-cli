import chalk from "chalk";
import ora from "ora";
import { AutoScalingManager } from "../aws/autoscaling";
import { ScaleOptions } from "../types";

export async function scaleCommand(options: ScaleOptions): Promise<void> {
  console.log(chalk.blue.bold("\n📈 Night Cloud Miner - Scale\n"));

  const asgManager = new AutoScalingManager();

  const region = options.region;
  const targetInstances = parseInt(options.instances.toString());

  console.log(chalk.gray(`Region: ${region}`));
  console.log(chalk.gray(`Target instances: ${targetInstances}\n`));

  const spinner = ora("Scaling Auto Scaling Group...").start();

  try {
    const currentSize = await asgManager.getAutoScalingGroupSize(region);

    if (currentSize === targetInstances) {
      spinner.info(`Already at target size (${targetInstances} instances)`);
      return;
    }

    await asgManager.scaleAutoScalingGroup(region, targetInstances);

    const action = targetInstances > currentSize ? "up" : "down";
    spinner.succeed(`Scaled ${action} from ${currentSize} to ${targetInstances} instances`);

    console.log(chalk.green("\n✅ Scaling complete!\n"));
    console.log(chalk.yellow("⏳ Instances will launch/terminate over the next few minutes\n"));
    console.log(chalk.gray('Run "night status" to check progress'));
  } catch (error: any) {
    spinner.fail("Failed to scale");
    console.error(chalk.red(error.message));
    
    // Check if error is about exceeding max capacity
    if (error.message && error.message.includes("is above max value")) {
      console.log(chalk.yellow("\n💡 Tip: To increase the maximum capacity, run the deploy command again:"));
      console.log(chalk.gray(`   night deploy --region ${region} --instances ${targetInstances}\n`));
    }
    
    process.exit(1);
  }
}
