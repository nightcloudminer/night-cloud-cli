import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { saveConfig, configExists } from "../config";
import { Config } from "../types";

export async function initCommand(): Promise<void> {
  console.log(chalk.blue.bold("\n☁️⛏️  Night Cloud Miner - Initialization\n"));

  // Display disclaimer
  console.log(chalk.yellow.bold("⚠️  IMPORTANT DISCLAIMER:"));
  console.log(chalk.yellow("   This software will deploy AWS infrastructure that incurs costs."));
  console.log(chalk.yellow("   You are solely responsible for all AWS charges and security."));
  console.log(chalk.yellow("   USE AT YOUR OWN RISK. Always monitor your AWS billing.\n"));

  // Check if config already exists
  if (configExists()) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: "Configuration already exists. Overwrite?",
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log(chalk.yellow("Initialization cancelled."));
      return;
    }
  }

  // Validate AWS credentials
  const spinner = ora("Validating AWS credentials...").start();
  try {
    const ec2 = new EC2Client({ region: "us-east-1" });
    await ec2.send(new DescribeRegionsCommand({}));
    spinner.succeed("AWS credentials valid");
  } catch (error: any) {
    spinner.fail("AWS credentials invalid");
    console.error(chalk.red("\nError:"), error.message);
    console.log(chalk.yellow("\nPlease configure AWS CLI:"));
    console.log(chalk.gray("  aws configure"));
    process.exit(1);
  }

  // Use the most efficient instance type for mining
  const instanceType = "c7g.xlarge";

  // Prompt for configuration
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "spotMaxPrice",
      message: "Spot instance max price (USD/hour):",
      default: "0.10",
    },
    {
      type: "number",
      name: "addressesPerInstance",
      message: "Addresses per instance:",
      default: 10,
    },
    {
      type: "input",
      name: "keysDirectory",
      message: "Directory to store wallet keys:",
      default: "./keys",
      validate: (input: string) => {
        if (!input || input.trim().length === 0) {
          return "Keys directory cannot be empty";
        }
        return true;
      },
    },
  ]);

  // Save configuration
  const config: Partial<Config> = {
    instanceType: instanceType,
    spotMaxPrice: answers.spotMaxPrice,
    addressesPerInstance: answers.addressesPerInstance,
    apiUrl: "https://scavenger.prod.gd.midnighttge.io", // Official Scavenger Mine API
    awsRegions: [], // Region is now specified per-command
    keysDirectory: answers.keysDirectory,
  };

  saveConfig(config);

  console.log(chalk.green("\n✅ Configuration saved successfully!\n"));
  console.log(chalk.blue("Next steps:\n"));
  console.log(chalk.gray("  1. Generate wallets (specify region):"));
  console.log(chalk.white(`     night-cloud wallet --region <region> --generate 10\n`));
  console.log(chalk.gray("  2. Deploy to your region:"));
  console.log(chalk.white(`     night-cloud deploy --region <region> --instances 5\n`));
  console.log(chalk.gray("  3. Check status:"));
  console.log(chalk.white(`     night-cloud status --region <region>\n`));
  console.log(chalk.gray("  4. View live dashboard:"));
  console.log(chalk.white(`     night-cloud dashboard --region <region>\n`));
  console.log(chalk.gray("\n  💡 Tip: Popular regions include ap-south-1, us-east-1, eu-west-1\n"));
}
