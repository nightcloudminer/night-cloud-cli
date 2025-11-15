import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { EC2Manager } from "../aws/ec2";
import { AutoScalingManager } from "../aws/autoscaling";
import { S3RegistryManager } from "../utils/s3-registry";
import { DeploymentOptions } from "../types";
import axios from "axios";
import { loadConfig } from "../config";
import { MiningEstimator } from "../utils/mining-estimator";
import { CardanoWalletManager } from "../utils/cardano-wallet";
import * as path from "path";
import * as fs from "fs";

export async function deployCommand(options: DeploymentOptions): Promise<void> {
  console.log(chalk.blue.bold("\n🚀 Night Cloud Miner - Deployment\n"));

  const config = loadConfig();
  const region = options.region;

  const ec2Manager = new EC2Manager(region);
  const asgManager = new AutoScalingManager();
  const s3Registry = new S3RegistryManager(region);

  const addressesPerInstance = parseInt(options.addressesPerInstance?.toString() || "10");

  // Parse instance count if provided
  let instanceCount: number | undefined;
  if (options.instances) {
    instanceCount = parseInt(options.instances.toString());
  }

  // If no instance count provided, help user calculate based on target solutions
  if (!instanceCount || isNaN(instanceCount)) {
    console.log(chalk.blue("Let's calculate how many instances you need...\n"));

    const estimator = new MiningEstimator(config.apiUrl);
    const spinner = ora("Fetching current challenge difficulty...").start();

    const [difficulty, starPerSolution] = await Promise.all([
      estimator.getCurrentDifficulty(),
      estimator.getWorkToStarRate(),
    ]);

    if (difficulty) {
      spinner.succeed(`Current difficulty: 0x${difficulty.hex}`);

      const solutionsPerInstance = estimator.estimateSolutionsPerInstance(difficulty.value, addressesPerInstance);

      console.log(
        chalk.gray(`   Each c7g.xlarge (4 workers) estimates ${solutionsPerInstance.toFixed(2)} solutions/hour\n`),
      );

      const { targetSolutions } = await inquirer.prompt([
        {
          type: "number",
          name: "targetSolutions",
          message: "How many solutions per hour do you want?",
          default: 100,
          validate: (input: number) => {
            if (input <= 0) return "Must be greater than 0";
            return true;
          },
        },
      ]);

      const estimate = estimator.calculateInstancesNeeded(
        targetSolutions,
        difficulty.value,
        addressesPerInstance,
        starPerSolution || undefined,
      );

      instanceCount = estimate.instancesNeeded;

      console.log(
        chalk.green(
          `\n✓ Recommended: ${instanceCount.toLocaleString()} instance(s) for ~${estimate.solutionsPerHour.toLocaleString(
            undefined,
            { maximumFractionDigits: 0 },
          )} solutions/hour`,
        ),
      );

      const spotPrice = parseFloat(config.spotMaxPrice);
      const estimatedCost = spotPrice * instanceCount;
      const estimatedCostPerDay = estimatedCost * 24;
      console.log(
        chalk.gray(
          `   Estimated cost: ~$${estimatedCost.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
          })}/hour ($${estimatedCostPerDay.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}/day)`,
        ),
      );

      if (estimate.nightPerHour !== undefined) {
        const nightPerDay = estimate.nightPerHour * 24;
        console.log(
          chalk.gray(
            `   Expected reward: ~${estimate.nightPerHour.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} $NIGHT/hour (~${nightPerDay.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} $NIGHT/day)`,
          ),
        );

        // Calculate cost per NIGHT
        const costPerNight = estimatedCost / estimate.nightPerHour;
        console.log(
          chalk.gray(
            `   Cost per NIGHT: ~$${costPerNight.toLocaleString(undefined, {
              minimumFractionDigits: 4,
              maximumFractionDigits: 6,
            })}/NIGHT`,
          ),
        );

        console.log(
          chalk.yellow(`\n   Note: Rewards are estimates based on current rates and may vary as more miners join.`),
        );
      }

      console.log();

      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Deploy ${instanceCount} instance(s) to ${region}?`,
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.yellow("Deployment cancelled."));
        return;
      }
    } else {
      spinner.warn("Could not fetch difficulty, please specify instance count manually");

      const { manualCount } = await inquirer.prompt([
        {
          type: "number",
          name: "manualCount",
          message: "How many instances do you want to deploy?",
          default: 10,
          validate: (input: number) => {
            if (input <= 0) return "Must be greater than 0";
            return true;
          },
        },
      ]);

      instanceCount = manualCount;
    }
  }

  // Ensure instanceCount is defined at this point
  if (!instanceCount) {
    console.log(chalk.red("Error: Unable to determine instance count"));
    return;
  }

  console.log(chalk.gray("Configuration:"));
  console.log(chalk.gray(`  Region: ${region}`));
  console.log(chalk.gray(`  Instances: ${instanceCount}`));
  console.log(chalk.gray(`  Addresses per instance: ${addressesPerInstance}`));
  console.log();

  // Step 1: Initialize S3 registry
  let spinner = ora("Initializing S3 registry...").start();
  try {
    await s3Registry.ensureBucket();
    spinner.succeed("S3 registry ready");
  } catch (error: any) {
    spinner.fail("Failed to initialize S3 registry");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 1.5: Upload miner code to S3
  spinner = ora("Uploading miner code to S3...").start();
  try {
    // Use the bundled miner tarball from the CLI dist folder
    // When bundled, __dirname points to the bundled file location
    // We need to find the actual dist directory by looking for the tarball
    let tarballPath: string | null = null;

    // Try multiple possible locations
    const possiblePaths = [
      path.join(__dirname, "miner-code.tar.gz"), // Same directory as bundled CLI
      path.join(__dirname, "../miner-code.tar.gz"), // One level up
      path.join(__dirname, "../../miner-code.tar.gz"), // Two levels up
      path.join(process.cwd(), "node_modules/@night-cloud/cli/dist/miner-code.tar.gz"), // Installed globally
    ];

    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        tarballPath = possiblePath;
        break;
      }
    }

    // Check if miner tarball exists
    if (!tarballPath) {
      throw new Error(
        "Miner tarball not found. Please ensure the CLI was built with 'npm run build' which packages the miner.",
      );
    }

    // Upload to S3
    spinner.text = "Uploading miner code to S3...";
    const checksum = await s3Registry.uploadMinerCode(tarballPath);

    spinner.succeed(`Miner code uploaded (checksum: ${checksum.substring(0, 16)}...)`);
  } catch (error: any) {
    spinner.fail("Failed to upload miner code");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 1.6: Load and initialize registry with wallet addresses
  spinner = ora("Loading wallet addresses...").start();
  try {
    const walletManager = new CardanoWalletManager(config.apiUrl, config.keysDirectory, region);
    const wallets = walletManager.loadAllWallets();

    if (wallets.length === 0) {
      spinner.fail("No wallet addresses found");
      console.error(
        chalk.red(`Please generate wallets first with: night-cloud wallet --region ${region} --generate <count>`),
      );
      process.exit(1);
    }

    const totalAddressesNeeded = instanceCount * addressesPerInstance;
    const recommendedAddresses = Math.ceil(totalAddressesNeeded * 1.2);

    // Check: do we have at least 1.2x the addresses needed?
    // This ensures we don't run out of capacity if instances need to be reassigned
    if (wallets.length < recommendedAddresses) {
      spinner.fail(`Not enough addresses for ${region}`);
      console.error(
        chalk.red(
          `Need at least ${recommendedAddresses} addresses (1.2x ${totalAddressesNeeded} needed) for ${region}`,
        ),
      );
      console.error(chalk.red(`Currently have ${wallets.length} addresses in ${config.keysDirectory}/${region}/`));
      console.log(
        chalk.yellow(`\n💡 Why 1.2x? This ensures you have spare capacity when instances restart or get reassigned.`),
      );
      console.log(chalk.yellow(`   Without extra capacity, instances can fail to start due to address exhaustion.\n`));
      console.log(
        chalk.white(
          `Generate more wallets with: night-cloud wallet --region ${region} --generate ${
            recommendedAddresses - wallets.length
          }`,
        ),
      );
      process.exit(1);
    }

    // Show capacity info
    const capacityPercent = Math.round((wallets.length / recommendedAddresses) * 100);
    if (wallets.length < totalAddressesNeeded * 2) {
      console.log(
        chalk.yellow(
          `   ⚠️  Wallet capacity: ${wallets.length}/${recommendedAddresses} (${capacityPercent}% of recommended)`,
        ),
      );
    } else {
      console.log(
        chalk.green(
          `   ✅ Wallet capacity: ${wallets.length}/${recommendedAddresses} (${capacityPercent}% of recommended)`,
        ),
      );
    }

    // Extract addresses for this region
    const regionAddresses = wallets.map((w) => w.address);

    // Initialize registry with addresses
    spinner.text = "Initializing registry with addresses...";
    await s3Registry.initializeRegistry(regionAddresses, addressesPerInstance);

    spinner.succeed(`Registry initialized with ${regionAddresses.length} wallet addresses for ${region}`);
  } catch (error: any) {
    spinner.fail("Failed to initialize registry");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 2: Get latest Ubuntu AMI
  spinner = ora("Finding latest Ubuntu 24.04 ARM64 AMI...").start();
  let amiId: string;
  try {
    amiId = await ec2Manager.getLatestUbuntuAMI(region, config);
    spinner.succeed(`Using AMI: ${amiId}`);
  } catch (error: any) {
    spinner.fail("Failed to find AMI");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 2: Setup IAM instance profile
  spinner = ora("Setting up IAM instance profile...").start();
  let instanceProfileName: string;
  try {
    instanceProfileName = await ec2Manager.ensureInstanceProfile();
    spinner.succeed(`IAM instance profile ready: ${instanceProfileName}`);
  } catch (error: any) {
    spinner.fail("Failed to setup IAM instance profile");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 3: Setup security group
  spinner = ora("Setting up security group...").start();
  let securityGroupId: string;
  try {
    securityGroupId = await ec2Manager.ensureSecurityGroup(region, config);
    spinner.succeed(`Security group ready: ${securityGroupId}`);
  } catch (error: any) {
    spinner.fail("Failed to setup security group");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 4: Create/update launch template
  spinner = ora("Creating launch template...").start();
  try {
    await ec2Manager.createOrUpdateLaunchTemplate(region, config, amiId, securityGroupId, instanceProfileName);
    spinner.succeed("Launch template ready");
  } catch (error: any) {
    spinner.fail("Failed to create launch template");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 4: Get spot prices and let user select AZs
  spinner = ora("Getting spot prices for availability zones...").start();
  let selectedAZs: string[];
  try {
    // Get spot prices for all AZs
    const { DescribeSpotPriceHistoryCommand } = await import("@aws-sdk/client-ec2");
    const client = (ec2Manager as any).getClient(region);

    const command = new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [config.instanceType as any],
      ProductDescriptions: ["Linux/UNIX"],
      StartTime: new Date(Date.now() - 3600000),
      MaxResults: 100,
    });

    const response = await client.send(command);

    if (!response.SpotPriceHistory || response.SpotPriceHistory.length === 0) {
      throw new Error("No spot price data available");
    }

    // Get latest price for each AZ
    const azPrices = new Map<string, { price: number; timestamp: Date }>();
    for (const item of response.SpotPriceHistory) {
      const az = item.AvailabilityZone!;
      const price = parseFloat(item.SpotPrice!);
      const timestamp = item.Timestamp!;

      if (!azPrices.has(az) || azPrices.get(az)!.timestamp < timestamp) {
        azPrices.set(az, { price, timestamp });
      }
    }

    // Sort by price
    const sortedAZs = Array.from(azPrices.entries())
      .map(([az, data]) => ({ az, price: data.price }))
      .sort((a, b) => a.price - b.price);

    spinner.succeed("Spot prices retrieved");
    console.log();

    // Display AZ options
    console.log(chalk.cyan("Available zones (sorted by price):"));
    console.log();
    sortedAZs.forEach((item, index) => {
      const marker = index === 0 ? chalk.green("  → ") : "    ";
      const label = index === 0 ? chalk.green(" (cheapest)") : "";
      console.log(
        `${marker}${chalk.white(item.az.padEnd(18))} ${chalk.yellow(`$${item.price.toFixed(4)}/hr`)}${label}`,
      );
    });
    console.log();

    // Warning about capacity
    console.log(chalk.yellow("⚠️  Note: Cheaper zones may have limited capacity."));
    console.log(chalk.gray("   Using multiple zones increases chances of getting all instances."));
    console.log();

    // Interactive selection - all zones selected by default
    const { selectedAZsList } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selectedAZsList",
        message: "Select availability zones to use:",
        choices: sortedAZs.map((item) => ({
          name: `${item.az.padEnd(18)} $${item.price.toFixed(4)}/hr`,
          value: item.az,
          checked: true, // All zones selected by default
        })),
        validate: (answer) => {
          if (answer.length === 0) {
            return "You must select at least one availability zone";
          }
          return true;
        },
      },
    ]);

    selectedAZs = selectedAZsList;

    console.log();
    console.log(chalk.green(`✓ Selected ${selectedAZs.length} availability zone(s):`));
    selectedAZs.forEach((az) => {
      const priceData = azPrices.get(az);
      const priceStr = priceData ? `$${priceData.price.toFixed(4)}/hr` : "N/A";
      console.log(`  ${chalk.cyan(az)} @ ${chalk.yellow(priceStr)}`);
    });
    console.log();
  } catch (error: any) {
    spinner.fail("Failed to get availability zones");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 5: Check if ASG already exists
  const existingSize = await asgManager.getAutoScalingGroupSize(region);
  const isUpdate = existingSize > 0;

  // Step 6: Create/update Auto Scaling Group with selected AZs
  spinner = ora("Setting up Auto Scaling Group...").start();
  try {
    await asgManager.createOrUpdateAutoScalingGroup(region, config, instanceCount, selectedAZs);
    spinner.succeed("Auto Scaling Group ready");
  } catch (error: any) {
    spinner.fail("Failed to setup Auto Scaling Group");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // Step 7: Start instance refresh if this is an update AND refresh flag is set
  if (isUpdate && options.refresh) {
    spinner = ora("Starting instance refresh to deploy new code...").start();
    try {
      const refreshId = await asgManager.startInstanceRefresh(region);
      spinner.succeed("Instance refresh started");
      console.log(chalk.gray(`   Refresh ID: ${refreshId}`));
      console.log(chalk.gray(`   This will gradually replace all instances with the latest code`));
      console.log(chalk.gray(`   Keeping at least 50% of instances running during the refresh\n`));
    } catch (error: any) {
      spinner.warn("Failed to start instance refresh");
      console.log(chalk.yellow(`   You may need to manually refresh instances or redeploy`));
      console.log(chalk.gray(`   Error: ${error.message}\n`));
    }
  } else if (isUpdate && !options.refresh) {
    console.log(chalk.yellow("\n💡 Tip: New code has been uploaded to S3"));
    console.log(chalk.gray("   Existing instances will continue running with their current code."));
    console.log(chalk.gray("   To deploy the new code to existing instances, run:"));
    console.log(chalk.white(`   night-cloud deploy --region ${region} --refresh\n`));
  }

  console.log(chalk.green("\n✅ Infrastructure deployed successfully!\n"));

  if (isUpdate && options.refresh) {
    console.log(chalk.yellow("🔄 Instance refresh in progress...\n"));
    console.log(chalk.gray("  Instances will be gradually replaced with the latest code."));
    console.log(chalk.gray("  This process maintains at least 50% capacity during the refresh.\n"));
  } else if (!isUpdate) {
    console.log(chalk.yellow("⏳ Waiting for instances to launch (this takes 2-3 minutes)...\n"));
  }

  // Wait for instances to be ready
  await new Promise((resolve) => setTimeout(resolve, 30000));

  // Step 8: Get running instances
  spinner = ora("Discovering instances...").start();
  let instances;
  try {
    const instanceIds = await asgManager.getAutoScalingGroupInstances(region);
    instances = await ec2Manager.getInstanceDetails(region, instanceIds);
    spinner.succeed(`Found ${instances.length} running instances`);
  } catch (error: any) {
    spinner.fail("Failed to list instances");
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  if (instances.length === 0) {
    console.log(chalk.yellow("\nNo instances found yet. They may still be launching."));
    console.log(chalk.gray('Run "night status" to check progress.'));
    return;
  }

  console.log(chalk.green("\n✅ Deployment complete!\n"));
  console.log(chalk.gray(`${instances.length} instance(s) are launching and will self-assign miner ranges.\n`));

  console.log(chalk.blue("\nNext steps:\n"));
  console.log(chalk.gray("  Instances will automatically start mining once they're ready."));
  console.log(chalk.gray("  This typically takes 5-10 minutes for setup and compilation.\n"));
  console.log(chalk.gray("  Check status:"));
  console.log(chalk.white(`    night-cloud status --region ${region}`));
  console.log(chalk.gray("  View logs:"));
  console.log(chalk.white(`    night-cloud logs --region ${region}\n`));
}
