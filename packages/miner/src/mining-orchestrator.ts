import { ScavengerMineAPI, Challenge, NoChallenge } from "./shared";
import { RustMinerWrapper } from "./rust-miner";
import { SolutionTracker } from "./solution-tracker";
import { ChallengeQueueManager } from "./challenge-queue";
import { WorkQueue } from "./work-queue";

/**
 * Mining Orchestrator
 *
 * Manages the complete mining lifecycle:
 * 1. Fetches current challenge from API
 * 2. Spawns Rust miners for each assigned address
 * 3. Collects solutions
 * 4. Submits solutions to API
 * 5. Handles errors and retries
 */
export class MiningOrchestrator {
  private api: ScavengerMineAPI;
  private addresses: string[];
  private rustMiner: RustMinerWrapper;
  private solutionTracker: SolutionTracker;
  private challengeQueue: ChallengeQueueManager;
  private workQueue: WorkQueue;
  private isRunning: boolean = false;
  private challengeFetchInterval: number = 300000; // Fetch new challenges every 5 minutes
  private workCheckInterval: number = 5000; // Check for new work every 5 seconds
  private lastChallengeFetch: number = 0; // Timestamp of last challenge fetch
  private workerChallenges: Map<number, { challengeId: string; expiresAt: Date }> = new Map(); // Track which challenge each worker is mining
  private expirationCheckInterval: NodeJS.Timeout | null = null; // Interval for checking expired challenges

  constructor(addresses: string[], apiUrl: string, region: string, rustBinaryPath?: string, workerCount?: number) {
    this.api = new ScavengerMineAPI(apiUrl);
    this.addresses = addresses;
    this.rustMiner = new RustMinerWrapper(rustBinaryPath, workerCount);
    this.solutionTracker = new SolutionTracker(region);
    this.challengeQueue = new ChallengeQueueManager(region);
    this.workQueue = new WorkQueue(this.solutionTracker);
  }

  /**
   * Start the mining orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("⚠️  Mining orchestrator is already running");
      return;
    }

    this.isRunning = true;
    console.log("🚀 Mining orchestrator started");
    console.log(`📋 Mining for ${this.addresses.length} address(es)`);
    console.log(`⚙️  Using ${this.rustMiner.getWorkerCount()} worker processes`);
    console.log(
      `💪 Each worker will mine ~${Math.ceil(this.addresses.length / this.rustMiner.getWorkerCount())} address(es)\n`,
    );

    // Initialize challenge queue from existing solutions in S3
    console.log("🔍 Initializing challenge queue from S3...");
    await this.challengeQueue.initialize();

    // Preload all solutions into cache for fast work queue building
    await this.solutionTracker.preloadSolutions(this.addresses);

    // Start periodic check for expired challenges (every 10 seconds)
    this.expirationCheckInterval = setInterval(() => {
      this.checkAndAbortExpiredWork();
    }, 10000);

    await this.miningLoop();
  }

  /**
   * Stop the mining orchestrator
   */
  stop(): void {
    this.isRunning = false;
    this.rustMiner.stopAll();
    if (this.expirationCheckInterval) {
      clearInterval(this.expirationCheckInterval);
      this.expirationCheckInterval = null;
    }
    console.log("🛑 Mining orchestrator stopped");
  }

  /**
   * Main mining loop
   */
  private async miningLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const now = Date.now();

        // Only fetch new challenges every 5 minutes to avoid API overload
        if (now - this.lastChallengeFetch >= this.challengeFetchInterval) {
          console.log("🔄 Fetching new challenges from API...");
          const apiChallenge = await this.fetchChallenge();
          if (apiChallenge != null) {
            await this.challengeQueue.addChallenge(apiChallenge);
          }
          this.lastChallengeFetch = now;
        }

        // Clean expired challenges from challenge queue
        const removedChallenges = this.challengeQueue.cleanExpiredChallenges();
        if (removedChallenges > 0) {
          console.log(`🧹 Removed ${removedChallenges} expired challenge(s)`);
        }

        // Get all available challenges
        const challenges = this.challengeQueue.getChallenges();
        console.log(`📊 Challenge queue: ${challenges.length} challenge(s) available`);

        if (challenges.length === 0) {
          console.log("⏳ No challenges available, waiting for API fetch...");
          await this.sleep(this.workCheckInterval);
          continue;
        }

        // Log challenge details
        if (challenges.length > 0) {
          const now = new Date();
          const validChallenges = challenges.filter((c) => new Date(c.latestSubmission) > now);
          console.log(`   Valid (non-expired): ${validChallenges.length}`);
          if (validChallenges.length > 0) {
            validChallenges.slice(0, 3).forEach((c) => {
              const hoursLeft = ((new Date(c.latestSubmission).getTime() - now.getTime()) / (1000 * 60 * 60)).toFixed(
                1,
              );
              console.log(`   - ${c.challengeId} (${hoursLeft}h left)`);
            });
          }
        }

        // Rebuild work queue from available challenges
        await this.workQueue.build(this.addresses, challenges);

        // Clean expired work items
        const removedWork = this.workQueue.cleanExpired();
        if (removedWork > 0) {
          console.log(`🧹 Removed ${removedWork} expired work item(s)`);
        }

        // Show work queue stats
        const stats = this.workQueue.getStats();
        if (stats.total === 0) {
          console.log("✅ All addresses have solved all available challenges!");
          await this.sleep(this.workCheckInterval);
          continue;
        }

        console.log(
          `\n📋 Work queue: ${stats.total} items (${stats.available} available, ${stats.inProgress} in progress${
            stats.donationItems > 0 ? `, 💝 ${stats.donationItems} donation` : ""
          })`,
        );
        console.log(`   Challenges:`);
        Array.from(stats.byChallenge.entries())
          .slice(0, 5)
          .forEach(([challengeId, count]) => {
            console.log(`     ${challengeId}: ${count} address(es)`);
          });
        console.log();

        // Start workers to process the queue
        await this.processWorkQueue();

        await this.sleep(this.workCheckInterval);
      } catch (error) {
        console.error("❌ Error in mining loop:", error);
        await this.sleep(30000); // Wait 30 seconds on error
      }
    }
  }

  /**
   * Fetch current challenge from API
   */
  private async fetchChallenge(): Promise<Challenge | null> {
    try {
      const response = await this.api.getCurrentChallenge();

      if (!response) {
        return null;
      }

      // Check if it's a NoChallenge response
      if ("code" in response && (response.code === "before" || response.code === "after")) {
        const noChallenge = response as NoChallenge;
        if (noChallenge.code === "before" && noChallenge.starts_at) {
          console.log(`⏰ Challenge starts at: ${noChallenge.starts_at}`);
        } else if (noChallenge.code === "after") {
          console.log("🏁 Mining period has ended");
        }
        return null;
      }

      return response as Challenge;
    } catch (error) {
      console.error("⚠️  Failed to fetch challenge:", error);
      return null;
    }
  }

  /**
   * Process work queue - each worker pulls work items and mines them
   */
  private async processWorkQueue(): Promise<void> {
    const workerCount = this.rustMiner.getWorkerCount();

    // Start all workers
    const workerPromises = Array.from({ length: workerCount }, (_, workerId) => this.workerLoop(workerId));

    // Wait for all workers to finish their current work
    await Promise.all(workerPromises);
  }

  /**
   * Worker loop - continuously pulls work from queue and mines
   */
  private async workerLoop(workerId: number): Promise<void> {
    while (this.isRunning) {
      // Get next work item from queue
      const workItem = this.workQueue.getNext();

      if (!workItem) {
        // No more work available
        // Clear worker tracking
        this.workerChallenges.delete(workerId);
        return;
      }

      try {
        if (workItem.isDonation) {
          console.log(
            `   [Worker ${workerId}] 💝 Mining ${
              workItem.challenge.challengeId
            } for DONATION: ${workItem.address.substring(0, 20)}...`,
          );
        } else {
          console.log(
            `   [Worker ${workerId}] Mining ${workItem.challenge.challengeId} for address ${
              workItem.addressIndex
            }: ${workItem.address.substring(0, 20)}...`,
          );
        }

        // Track which challenge this worker is mining
        this.workerChallenges.set(workerId, {
          challengeId: workItem.challenge.challengeId,
          expiresAt: new Date(workItem.challenge.latestSubmission),
        });

        const result = await this.rustMiner.mine(
          {
            address: workItem.address,
            challengeId: workItem.challenge.challengeId,
            difficulty: workItem.challenge.difficulty,
            noPreMine: workItem.challenge.noPreMine,
            latestSubmission: workItem.challenge.latestSubmission,
            noPreMineHour: workItem.challenge.noPreMineHour,
          },
          workerId,
        );

        // Clear worker tracking after mining completes
        this.workerChallenges.delete(workerId);

        if (result.success && result.nonce && result.preimage && result.hash) {
          // Check if challenge has expired before submitting
          const now = new Date();
          const expiresAt = new Date(workItem.challenge.latestSubmission);
          if (expiresAt <= now) {
            console.log(
              `\n⏰ [Worker ${workerId}] Challenge ${workItem.challenge.challengeId} expired before submission - skipping`,
            );
            this.workQueue.complete(workItem.id);
            continue;
          }

          if (workItem.isDonation) {
            console.log(`\n✅ [Worker ${workerId}] 💝 DONATION solution found for ${workItem.challenge.challengeId}!`);
            console.log(`   Donation Address: ${workItem.address.substring(0, 20)}...`);
            console.log(`   Nonce: ${result.nonce}`);
            console.log(`   Hash: ${result.hash.substring(0, 32)}...`);
          } else {
            console.log(
              `\n✅ [Worker ${workerId}] Solution found for ${workItem.challenge.challengeId} / address ${workItem.addressIndex}!`,
            );
            console.log(`   Address: ${workItem.address.substring(0, 20)}...`);
            console.log(`   Nonce: ${result.nonce}`);
            console.log(`   Hash: ${result.hash.substring(0, 32)}...`);
          }

          // Submit solution
          await this.submitSolution(workItem.address, workItem.challenge.challengeId, result.nonce, workItem.isDonation);

          // Mark work item as complete
          this.workQueue.complete(workItem.id);
        } else {
          if (workItem.isDonation) {
            console.log(`   [Worker ${workerId}] 💝 No donation solution found for ${workItem.challenge.challengeId}`);
          } else {
            console.log(
              `   [Worker ${workerId}] No solution found for ${workItem.challenge.challengeId} / address ${workItem.addressIndex}`,
            );
          }

          // Release work item back to queue (will be picked up again later)
          this.workQueue.release(workItem.id);
        }
      } catch (error) {
        console.error(
          `   [Worker ${workerId}] Mining error for ${workItem.address.substring(0, 20)} on ${
            workItem.challenge.challengeId
          }:`,
          error,
        );

        // Clear worker tracking
        this.workerChallenges.delete(workerId);

        // Release work item back to queue
        this.workQueue.release(workItem.id);
      }
    }
  }

  /**
   * Check for workers mining expired challenges and abort them
   */
  private checkAndAbortExpiredWork(): void {
    const now = new Date();
    const abortedWorkers: number[] = [];

    for (const [workerId, { challengeId, expiresAt }] of this.workerChallenges.entries()) {
      if (expiresAt <= now) {
        console.log(`⏰ Aborting worker ${workerId} - challenge ${challengeId} has expired`);
        this.rustMiner.abortWorker(workerId);
        abortedWorkers.push(workerId);
      }
    }

    // Clean up tracking for aborted workers
    for (const workerId of abortedWorkers) {
      this.workerChallenges.delete(workerId);
    }
  }

  /**
   * Submit a solution to the API
   */
  private async submitSolution(address: string, challengeId: string, nonce: string, isDonation: boolean = false): Promise<void> {
    try {
      console.log(`📤 Submitting solution for ${address.substring(0, 20)}...`);

      const receipt = await this.api.submitSolution(address, challengeId, nonce);

      console.log(`✅ Solution submitted successfully!`);

      // Show timestamp if available
      if (receipt.timestamp) {
        console.log(`   Receipt timestamp: ${receipt.timestamp}`);
      }

      // Show crypto receipt if available
      if (receipt.crypto_receipt) {
        const receiptStr =
          typeof receipt.crypto_receipt === "string" ? receipt.crypto_receipt : JSON.stringify(receipt.crypto_receipt);
        console.log(`   Crypto receipt: ${receiptStr.substring(0, 50)}...`);
      }

      // Show full receipt for debugging if neither timestamp nor crypto_receipt is present
      if (!receipt.timestamp && !receipt.crypto_receipt) {
        console.log(`   Receipt:`, JSON.stringify(receipt));
      }

      // Record the solution in S3 to prevent duplicate work
      await this.solutionTracker.recordSolution(address, challengeId, nonce, undefined, isDonation);
    } catch (error: any) {
      if (error.message.includes("already exists")) {
        console.log(`⚠️  Solution already submitted for this address`);

        // Still record it in our tracker to prevent retrying
        await this.solutionTracker.recordSolution(address, challengeId, nonce, undefined, isDonation);
      } else {
        console.error(`❌ Failed to submit solution:`, error);
        
        // Record the error for tracking
        const errorMessage = error.message || String(error);
        await this.solutionTracker.recordError(address, challengeId, errorMessage, isDonation);
      }
    }
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current mining status
   */
  getStatus(): {
    isRunning: boolean;
    workQueueStats: ReturnType<WorkQueue["getStats"]>;
    addressCount: number;
    activeWorkerCount: number;
    totalWorkers: number;
  } {
    return {
      isRunning: this.isRunning,
      workQueueStats: this.workQueue.getStats(),
      addressCount: this.addresses.length,
      activeWorkerCount: this.rustMiner.getActiveWorkerCount(),
      totalWorkers: this.rustMiner.getWorkerCount(),
    };
  }

  /**
   * Set interval for fetching new challenges from API
   */
  setChallengeFetchInterval(ms: number): void {
    this.challengeFetchInterval = ms;
  }

  /**
   * Set interval for checking work queue and processing
   */
  setWorkCheckInterval(ms: number): void {
    this.workCheckInterval = ms;
  }
}
