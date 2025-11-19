import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { ScavengerMineAPI } from "../shared";
import { CardanoWalletManager } from "../utils/cardano-wallet";
import { loadConfig } from "../config";

interface ConsolidateOptions {
  region: string;
  to: string;
  workers?: number;
  batchSize?: number;
  pauseSeconds?: number;
  outputFile?: string;
  noStats?: boolean;
}

interface DonationResult {
  minerName: string;
  minerNumber: number;
  timestamp: string;
  status: "success" | "failed" | "skipped";
  sourceAddress: string | null;
  receiptsBefore: number | null;
  solutionsConsolidated: number | null;
  donationId: string | null;
  error: string | null;
}

interface DonationLog {
  metadata: {
    destinationAddress: string;
    region: string;
    apiUrl: string;
    workers: number;
    startedAt: string;
    lastUpdated: string | null;
  };
  summary: {
    totalAttempted: number;
    totalSuccessful: number;
    totalFailed: number;
    totalSkipped: number;
    totalSolutionsConsolidated: number;
    batchesCompleted: number;
  };
  donations: DonationResult[];
  errors: Array<{
    minerName: string;
    timestamp: string;
    error: string;
  }>;
}

/**
 * Consolidate rewards from all wallets in a region to a destination address
 */
export async function consolidateCommand(options: ConsolidateOptions): Promise<void> {
  const { region, to, workers = 10, batchSize = 100, pauseSeconds = 2, outputFile, noStats = false } = options;

  // Load configuration
  const config = loadConfig();
  const apiUrl = config.apiUrl;
  const keysDir = path.resolve(config.keysDirectory);

  console.log(chalk.bold.cyan("\n" + "=".repeat(80)));
  console.log(chalk.bold.cyan("CONSOLIDATE REWARDS - PARALLEL DONATION"));
  console.log(chalk.bold.cyan("=".repeat(80) + "\n"));

  // Initialize API client
  const api = new ScavengerMineAPI(apiUrl);

  // Initialize wallet manager for the region
  const walletManager = new CardanoWalletManager(apiUrl, keysDir, region);

  // Validate destination address (must be a Cardano address, not a wallet name)
  const destinationAddress = to;
  if (!to.startsWith("addr")) {
    console.error(chalk.red(`✗ Destination must be a Cardano address starting with "addr"`));
    console.error(chalk.red(`  You provided: ${to}`));
    console.error(chalk.yellow(`  Tip: Use a full Cardano address, not a wallet name`));
    process.exit(1);
  }

  console.log(chalk.white(`Destination: ${destinationAddress}`));
  console.log(chalk.white(`Region: ${region}`));
  console.log(chalk.white(`Batch Size: ${batchSize}`));
  console.log(chalk.white(`Parallel Workers: ${workers}`));
  console.log(chalk.white(`Pause Between Batches: ${pauseSeconds}s`));
  if (noStats) {
    console.log(chalk.yellow(`No Stats Mode: enabled (skipping all stats checks)\n`));
  } else {
    console.log();
  }

  // Verify destination address is registered (unless no-stats mode)
  if (!noStats) {
    console.log(chalk.yellow("Verifying destination address..."));
    try {
      const destStats = await api.getAddressStatistics(destinationAddress);
      const destReceipts = destStats.local?.crypto_receipts || 0;
      console.log(chalk.green(`  ✓ Destination registered (current receipts: ${destReceipts})\n`));
    } catch (error: any) {
      const is429 = axios.isAxiosError(error) && error.response?.status === 429;
      console.error(chalk.red(`  ✗ Destination address verification failed: ${error.message}`));

      if (is429) {
        console.error(chalk.yellow(`\n  The stats API is rate-limited (HTTP 429).`));
        console.error(chalk.yellow(`  You can bypass this check with: --skip-stats`));
        console.error(chalk.yellow(`  Make sure the destination address is registered before proceeding!\n`));
      } else {
        console.error(chalk.red(`\n  IMPORTANT: The destination address must be registered!\n`));
      }
      process.exit(1);
    }
  } else {
    console.log(chalk.yellow("⚠️  Skipping all stats checks (--skip-stats mode)"));
    console.log(chalk.yellow("   Make sure the destination address is registered!\n"));
  }

  // Load all wallets from the region
  console.log(chalk.yellow(`Loading wallets from region: ${region}...`));
  const wallets = walletManager.loadAllWallets();

  if (wallets.length === 0) {
    console.error(chalk.red(`✗ No wallets found in region: ${region}`));
    process.exit(1);
  }

  console.log(chalk.green(`  ✓ Found ${wallets.length} wallets\n`));

  // Create donations directory
  const donationsDir = path.join(process.cwd(), "donations");
  if (!fs.existsSync(donationsDir)) {
    fs.mkdirSync(donationsDir, { recursive: true });
  }

  // Auto-generate output filename if not provided
  const finalOutputFile =
    outputFile ||
    `donations_${destinationAddress.slice(-8)}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)}.json`;
  const outputPath = path.join(donationsDir, finalOutputFile);

  // Load or initialize donation log
  let donationLog: DonationLog = loadOrInitLog(outputPath, destinationAddress, region, apiUrl, workers);

  console.log(chalk.bold.cyan("=".repeat(80)));
  console.log(chalk.bold.cyan("STARTING PARALLEL DONATIONS"));
  console.log(chalk.bold.cyan("=".repeat(80) + "\n"));

  // Process wallets in batches
  const totalWallets = wallets.length;
  let currentBatch = 1;

  for (let batchStart = 0; batchStart < totalWallets; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, totalWallets);
    const batchWallets = wallets.slice(batchStart, batchEnd);

    console.log(
      chalk.cyan(
        `Batch ${currentBatch}: Processing wallets ${batchStart + 1} to ${batchEnd} (${batchWallets.length} wallets)`,
      ),
    );
    console.log(chalk.gray("-".repeat(80)));

    const batchStartTime = Date.now();

    // Process batch in parallel with limited concurrency
    const results = await processWalletsInParallel(
      batchWallets,
      destinationAddress,
      api,
      walletManager,
      workers,
      donationLog,
      batchStart,
      totalWallets,
      noStats,
    );

    // Update log with results
    for (const result of results) {
      addDonationResult(donationLog, result);

      // Print progress
      const progress = `[${result.minerNumber}/${totalWallets}]`;
      if (result.status === "success") {
        console.log(
          chalk.green(`${progress} ${result.minerName}: ✅ Success (${result.solutionsConsolidated} solutions)`),
        );
      } else if (result.status === "skipped") {
        const errorShort = result.error?.substring(0, 40) || "Unknown";
        console.log(chalk.yellow(`${progress} ${result.minerName}: ⏭️  Skipped (${errorShort})`));
      } else {
        const errorShort = result.error?.substring(0, 40) || "Unknown";
        console.log(chalk.red(`${progress} ${result.minerName}: ❌ Failed (${errorShort})`));
      }
    }

    // Save log after batch
    donationLog.summary.batchesCompleted = currentBatch;
    saveLog(outputPath, donationLog);

    const batchTime = (Date.now() - batchStartTime) / 1000;
    console.log(chalk.gray("-".repeat(80)));
    console.log(chalk.cyan(`Batch ${currentBatch} completed in ${batchTime.toFixed(1)}s`));
    console.log(chalk.cyan(`Progress: ${batchEnd}/${totalWallets} (${((100 * batchEnd) / totalWallets).toFixed(1)}%)`));
    console.log(chalk.cyan(`💾 Log saved to ${outputPath}\n`));

    // Pause between batches (except after last batch)
    if (batchEnd < totalWallets) {
      console.log(chalk.yellow(`⏸️  Pausing for ${pauseSeconds} seconds...\n`));
      await new Promise((resolve) => setTimeout(resolve, pauseSeconds * 1000));
      currentBatch++;
    }
  }

  // Final summary
  console.log(chalk.bold.cyan("\n" + "=".repeat(80)));
  console.log(chalk.bold.cyan("PARALLEL DONATION COMPLETE"));
  console.log(chalk.bold.cyan("=".repeat(80) + "\n"));

  console.log(chalk.white(`Total Attempted: ${donationLog.summary.totalAttempted}`));
  console.log(chalk.green(`Successful: ${donationLog.summary.totalSuccessful}`));
  console.log(chalk.red(`Failed: ${donationLog.summary.totalFailed}`));
  console.log(chalk.yellow(`Skipped: ${donationLog.summary.totalSkipped}`));
  console.log(
    chalk.bold.green(
      `\n🎉 Total Solutions Consolidated: ${donationLog.summary.totalSolutionsConsolidated.toLocaleString()}`,
    ),
  );

  console.log(chalk.cyan(`\nDetailed log saved to: ${outputPath}\n`));
}

/**
 * Process wallets in parallel with limited concurrency
 */
async function processWalletsInParallel(
  wallets: any[],
  destinationAddress: string,
  api: ScavengerMineAPI,
  walletManager: CardanoWalletManager,
  maxConcurrency: number,
  donationLog: DonationLog,
  startIndex: number,
  totalWallets: number,
  noStats: boolean,
): Promise<DonationResult[]> {
  const results: DonationResult[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const minerNumber = startIndex + i + 1;

    // Check if already donated
    if (isAlreadyDonated(donationLog, `miner${wallet.minerNumber}`)) {
      results.push({
        minerName: `miner${wallet.minerNumber}`,
        minerNumber,
        timestamp: new Date().toISOString(),
        status: "skipped",
        sourceAddress: null,
        receiptsBefore: null,
        solutionsConsolidated: null,
        donationId: null,
        error: "Already donated (from previous run)",
      });
      continue;
    }

    // Create promise for this wallet
    const promise = donateSingle(wallet, destinationAddress, api, walletManager, minerNumber, noStats).then(
      (result) => {
        results.push(result);
      },
    );

    executing.push(promise);

    // If we've reached max concurrency, wait for one to finish
    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
      // Remove completed promises
      executing.splice(
        0,
        executing.length,
        ...executing.filter((p) => {
          let isPending = true;
          p.then(() => {
            isPending = false;
          }).catch(() => {
            isPending = false;
          });
          return isPending;
        }),
      );
    }
  }

  // Wait for all remaining promises
  await Promise.all(executing);

  return results;
}

/**
 * Donate from a single wallet
 */
async function donateSingle(
  wallet: any,
  destinationAddress: string,
  api: ScavengerMineAPI,
  walletManager: CardanoWalletManager,
  minerNumber: number,
  noStats: boolean,
): Promise<DonationResult> {
  const result: DonationResult = {
    minerName: `miner${wallet.minerNumber}`,
    minerNumber,
    timestamp: new Date().toISOString(),
    status: "failed",
    sourceAddress: wallet.address,
    receiptsBefore: null,
    solutionsConsolidated: null,
    donationId: null,
    error: null,
  };

  try {
    // Get statistics before donation (unless no-stats mode)
    if (!noStats) {
      try {
        const stats = await api.getAddressStatistics(wallet.address);
        result.receiptsBefore = stats.local?.crypto_receipts || 0;
      } catch (error: any) {
        // Not registered or other error - skip
        result.status = "skipped";
        result.error = `Not registered or stats unavailable: ${error.message}`;
        return result;
      }

      // Skip if no receipts
      if (result.receiptsBefore === 0) {
        result.status = "skipped";
        result.error = "No receipts to donate";
        return result;
      }
    }

    // Get donation message
    const message = api.getDonationMessage(destinationAddress);

    // Sign the message
    const config = loadConfig();
    const keysDir = path.resolve(config.keysDirectory);
    const targetDir = path.join(keysDir, walletManager["region"] || "");
    const minerDir = path.join(targetDir, `miner${wallet.minerNumber}`);
    const skeyPath = path.join(minerDir, "payment.skey");

    const { signature } = await walletManager.signMessage(message, skeyPath, wallet.address);

    // Submit donation
    const receipt = await api.donateRewards(wallet.address, destinationAddress, signature);

    // Extract information from receipt
    result.status = "success";
    result.solutionsConsolidated = receipt.solutions_consolidated || 0;
    result.donationId = receipt.donation_id || receipt.receipt_id;
  } catch (error: any) {
    result.status = "failed";
    result.error = error.message;

    // Check for specific error codes
    if (error.message.includes("409") || error.message.includes("already exists")) {
      result.status = "skipped";
      result.error = "Already has active donation assignment";
    }
  }

  return result;
}

/**
 * Load existing donation log or create new one
 */
function loadOrInitLog(
  outputPath: string,
  destinationAddress: string,
  region: string,
  apiUrl: string,
  workers: number,
): DonationLog {
  if (fs.existsSync(outputPath)) {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  }

  return {
    metadata: {
      destinationAddress,
      region,
      apiUrl,
      workers,
      startedAt: new Date().toISOString(),
      lastUpdated: null,
    },
    summary: {
      totalAttempted: 0,
      totalSuccessful: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalSolutionsConsolidated: 0,
      batchesCompleted: 0,
    },
    donations: [],
    errors: [],
  };
}

/**
 * Save donation log to file
 */
function saveLog(outputPath: string, log: DonationLog): void {
  log.metadata.lastUpdated = new Date().toISOString();
  fs.writeFileSync(outputPath, JSON.stringify(log, null, 2));
}

/**
 * Check if a miner has already been successfully donated
 */
function isAlreadyDonated(log: DonationLog, minerName: string): boolean {
  return log.donations.some((d) => d.minerName === minerName && d.status === "success");
}

/**
 * Add a donation result to the log
 */
function addDonationResult(log: DonationLog, result: DonationResult): void {
  log.donations.push(result);
  log.summary.totalAttempted++;

  if (result.status === "success") {
    log.summary.totalSuccessful++;
    log.summary.totalSolutionsConsolidated += result.solutionsConsolidated || 0;
  } else if (result.status === "skipped") {
    log.summary.totalSkipped++;
  } else {
    log.summary.totalFailed++;
    log.errors.push({
      minerName: result.minerName,
      timestamp: result.timestamp,
      error: result.error || "Unknown error",
    });
  }
}
