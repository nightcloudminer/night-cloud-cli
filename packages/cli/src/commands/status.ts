import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../config";
import { EC2Manager } from "../aws/ec2";
import { AutoScalingManager } from "../aws/autoscaling";
import { StatusOptions } from "../types";
import { table } from "table";

export async function statusCommand(options: StatusOptions): Promise<void> {
  console.log(chalk.blue.bold("\n📊 Night Cloud Miner - Status\n"));

  const config = loadConfig();
  const regions = options.region ? [options.region] : config.awsRegions;

  // Use the first region for IAM (global service)
  const ec2Manager = new EC2Manager(regions[0]);
  const asgManager = new AutoScalingManager();

  for (const region of regions) {
    console.log(chalk.blue(`\n━━━ ${region.toUpperCase()} ━━━\n`));

    const spinner = ora("Fetching status...").start();

    try {
      // Get ASG size and instances
      const asgSize = await asgManager.getAutoScalingGroupSize(region);
      const instanceIds = await asgManager.getAutoScalingGroupInstances(region);
      const instances = await ec2Manager.getInstanceDetails(region, instanceIds);

      spinner.stop();

      // Auto Scaling Group info
      console.log(chalk.gray("Auto Scaling Group:"));
      console.log(chalk.gray(`  Desired capacity: ${asgSize}`));
      console.log(chalk.gray(`  Running instances: ${instances.length}\n`));

      if (instances.length === 0) {
        console.log(chalk.yellow("No instances running\n"));
        continue;
      }

      // Instances table
      if (options.verbose) {
        const tableData: string[][] = [["Instance ID", "Public IP", "State", "Type", "Launch Time"]];

        for (const instance of instances) {
          const stateName = instance.state?.Name || "unknown";
          tableData.push([
            instance.instanceId || "unknown",
            instance.publicIp,
            stateName === "running" ? chalk.green(stateName) : chalk.yellow(stateName),
            instance.instanceType || "unknown",
            instance.launchTime?.toLocaleString() || "unknown",
          ]);
        }

        console.log(table(tableData));
      }

      // Summary
      console.log(chalk.gray("Summary:"));
      console.log(chalk.gray(`  Total instances: ${instances.length}`));
      console.log(chalk.gray(`  Addresses per instance: ${config.addressesPerInstance}`));
      console.log(chalk.gray(`\n  Note: Address assignments are managed by instances via S3 registry\n`));
    } catch (error: any) {
      spinner.fail("Failed to fetch status");
      console.error(chalk.red(error.message));
    }
  }
}
