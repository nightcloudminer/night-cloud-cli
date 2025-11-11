import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";

/**
 * Parameters for mining
 */
export interface MiningParams {
  address: string;
  challengeId: string;
  difficulty: string;
  noPreMine: string;
  latestSubmission: string;
  noPreMineHour: string;
}

/**
 * Result from mining operation
 */
export interface MiningResult {
  success: boolean;
  nonce?: string;
  preimage?: string;
  hash?: string;
  message?: string;
}

/**
 * Rust Miner Wrapper
 *
 * Manages spawning and communicating with Rust miner processes.
 * Spawns a fixed number of worker processes and distributes addresses across them.
 */
export class RustMinerWrapper {
  private binaryPath: string;
  private activeWorkers: Map<number, { process: ChildProcess; address: string; abortController: AbortController }> = new Map();
  private workerCount: number;

  constructor(binaryPath?: string, workerCount?: number) {
    // Default to the built binary location
    this.binaryPath = binaryPath || this.getDefaultBinaryPath();
    // Default to number of CPU cores
    this.workerCount = workerCount || os.cpus().length;
  }

  /**
   * Get the default binary path based on environment
   */
  private getDefaultBinaryPath(): string {
    // Binary is in rust/target/release/night-cloud relative to miner package root
    return path.resolve(__dirname, "../rust/target/release/night-cloud");
  }

  /**
   * Mine for a single address on a specific worker
   * Returns a promise that resolves when mining completes
   * Can be aborted by calling abortWorker(workerId)
   */
  async mine(params: MiningParams, workerId: number): Promise<MiningResult> {
    return new Promise((resolve, reject) => {
      const args = [
        "--address",
        params.address,
        "--challenge-id",
        params.challengeId,
        "--difficulty",
        params.difficulty,
        "--no-pre-mine",
        params.noPreMine,
        "--latest-submission",
        params.latestSubmission,
        "--no-pre-mine-hour",
        params.noPreMineHour,
      ];

      const worker = spawn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Create abort controller for this worker
      const abortController = new AbortController();

      // Track this worker
      this.activeWorkers.set(workerId, { process: worker, address: params.address, abortController });

      let stdout = "";
      let stderr = "";
      let wasAborted = false;

      // Listen for abort signal
      abortController.signal.addEventListener("abort", () => {
        wasAborted = true;
        worker.kill("SIGTERM");
      });

      worker.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        if (text.includes("DEBUG") || text.includes("Solution Details")) {
          console.error(text.trim());
        }
      });

      worker.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
      });

      worker.on("close", (code) => {
        // Remove from active workers
        this.activeWorkers.delete(workerId);

        // If aborted, resolve with no solution
        if (wasAborted) {
          resolve({ success: false, message: "Mining aborted due to challenge expiration" });
          return;
        }

        if (code !== 0) {
          reject(new Error(`Worker ${workerId} exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          // Parse JSON output from Rust miner
          const result = JSON.parse(stdout.trim()) as MiningResult;
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse worker ${workerId} output: ${stdout}`));
        }
      });

      worker.on("error", (error) => {
        this.activeWorkers.delete(workerId);
        reject(new Error(`Failed to spawn worker ${workerId}: ${error.message}`));
      });
    });
  }

  /**
   * Abort a specific worker by ID (triggers abort signal)
   */
  abortWorker(workerId: number): void {
    const worker = this.activeWorkers.get(workerId);
    if (worker) {
      worker.abortController.abort();
    }
  }

  /**
   * Stop a specific worker by ID
   */
  stopWorker(workerId: number): void {
    const worker = this.activeWorkers.get(workerId);
    if (worker) {
      worker.process.kill("SIGTERM");
      this.activeWorkers.delete(workerId);
    }
  }

  /**
   * Stop all active workers
   */
  stopAll(): void {
    for (const [workerId, worker] of this.activeWorkers.entries()) {
      worker.process.kill("SIGTERM");
    }
    this.activeWorkers.clear();
  }

  /**
   * Get count of active worker processes
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Get list of addresses currently being mined
   */
  getActiveAddresses(): string[] {
    return Array.from(this.activeWorkers.values()).map((w) => w.address);
  }

  /**
   * Check if a specific worker is active
   */
  isWorkerActive(workerId: number): boolean {
    return this.activeWorkers.has(workerId);
  }

  /**
   * Get the number of workers per address
   */
  getWorkerCount(): number {
    return this.workerCount;
  }

  /**
   * Set the number of workers per address
   */
  setWorkerCount(count: number): void {
    this.workerCount = count;
  }

  /**
   * Set binary path (useful for testing or custom builds)
   */
  setBinaryPath(path: string): void {
    this.binaryPath = path;
  }

  /**
   * Get current binary path
   */
  getBinaryPath(): string {
    return this.binaryPath;
  }
}
