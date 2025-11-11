/**
 * Solution Tracker - Manages submitted solutions in S3 to prevent duplicate work
 *
 * Uses one S3 file per address to eliminate race conditions and keep files small.
 * File structure: solutions/{address}.json
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

export interface SolutionRecord {
  challengeId: string;
  nonce: string;
  submittedAt: string;
  instanceId?: string;
}

export interface AddressSolutions {
  address: string;
  solutions: SolutionRecord[];
  lastUpdated: string;
}

export interface SolutionStats {
  totalSolutions: number;
  donationSolutions: number;
  totalErrors: number;
  lastUpdated: string;
  recentSolutions: Array<{
    address: string;
    challengeId: string;
    timestamp: string;
    isDonation?: boolean;
  }>;
  recentErrors: Array<{
    address: string;
    challengeId: string;
    timestamp: string;
    error: string;
    isDonation?: boolean;
  }>;
}

export class SolutionTracker {
  private s3Client: S3Client;
  private stsClient: STSClient;
  private bucketName: string;
  private region: string;
  private solutionsPrefix: string = "solutions/";
  private statsKey: string = "solutions-stats.json";
  private solutionCache: Map<string, Set<string>> = new Map(); // address -> Set of challengeIds
  private cacheLoaded: boolean = false;

  constructor(region: string) {
    this.region = region;
    this.bucketName = ""; // Will be set after getting account ID
    this.s3Client = new S3Client({ region });
    this.stsClient = new STSClient({ region });
  }

  private async initializeBucketName(): Promise<void> {
    if (this.bucketName) {
      return; // Already initialized
    }

    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      this.bucketName = `night-cloud-miner-${accountId}-${this.region}`;
    } catch (error) {
      throw new Error(`Failed to get AWS account ID: ${error}`);
    }
  }

  /**
   * Get the S3 key for an address's solutions file
   */
  private getAddressKey(address: string): string {
    return `${this.solutionsPrefix}${address}.json`;
  }

  /**
   * Preload all solutions from S3 into cache
   */
  async preloadSolutions(addresses: string[]): Promise<void> {
    await this.initializeBucketName();

    console.log(`📥 Preloading solutions for ${addresses.length} addresses...`);
    this.solutionCache.clear();

    let loaded = 0;
    for (const address of addresses) {
      try {
        const addressSolutions = await this.loadAddressSolutions(address);
        const challengeIds = new Set(addressSolutions.solutions.map((s) => s.challengeId));
        this.solutionCache.set(address, challengeIds);
        loaded++;
      } catch (error: any) {
        if (error.name === "NoSuchKey") {
          // No solutions yet for this address
          this.solutionCache.set(address, new Set());
        } else {
          console.error(`⚠️  Error loading solutions for ${address.substring(0, 20)}:`, error);
          this.solutionCache.set(address, new Set());
        }
      }
    }

    this.cacheLoaded = true;
    console.log(`✅ Preloaded solutions for ${loaded}/${addresses.length} addresses`);
  }

  /**
   * Check if a solution already exists for this address and challenge
   * Uses cache if available, otherwise loads from S3
   */
  async hasSolution(address: string, challengeId: string): Promise<boolean> {
    // Use cache if loaded
    if (this.cacheLoaded && this.solutionCache.has(address)) {
      return this.solutionCache.get(address)!.has(challengeId);
    }

    // Fallback to S3 if cache not loaded
    try {
      const addressSolutions = await this.loadAddressSolutions(address);
      return addressSolutions.solutions.some((s) => s.challengeId === challengeId);
    } catch (error: any) {
      if (error.name === "NoSuchKey") {
        return false; // No solutions file for this address yet
      }
      console.error(`⚠️  Error checking solution existence:`, error);
      return false; // Assume no solution on error (better to duplicate than skip)
    }
  }

  /**
   * Record a submitted solution
   * No race conditions since each address has its own file!
   */
  async recordSolution(
    address: string,
    challengeId: string,
    nonce: string,
    instanceId?: string,
    isDonation: boolean = false,
  ): Promise<boolean> {
    await this.initializeBucketName();

    try {
      // For donation addresses, only update stats - don't create individual address files
      if (isDonation) {
        // Update global stats file
        try {
          await this.updateStats(address, challengeId, isDonation);
        } catch (error) {
          console.warn(`⚠️  Failed to update stats file:`, error);
        }
        console.log(`✅ Recorded donation solution for ${address.substring(0, 20)}... on ${challengeId}`);
        return true;
      }

      // For regular addresses, record in individual address file
      // Load existing solutions for this address (or create empty)
      let addressSolutions: AddressSolutions;
      try {
        addressSolutions = await this.loadAddressSolutions(address);
      } catch (error: any) {
        if (error.name === "NoSuchKey") {
          // First solution for this address
          addressSolutions = {
            address,
            solutions: [],
            lastUpdated: new Date().toISOString(),
          };
        } else {
          throw error;
        }
      }

      // Check if solution already exists
      const exists = addressSolutions.solutions.some((s) => s.challengeId === challengeId);
      if (exists) {
        console.log(`ℹ️  Solution already recorded for ${address.substring(0, 20)}... on ${challengeId}`);
        return true;
      }

      // Add new solution
      addressSolutions.solutions.push({
        challengeId,
        nonce,
        submittedAt: new Date().toISOString(),
        instanceId,
      });

      addressSolutions.lastUpdated = new Date().toISOString();

      // Write back to S3 (no ETag needed - one file per address!)
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: this.getAddressKey(address),
          Body: JSON.stringify(addressSolutions, null, 2),
          ContentType: "application/json",
        }),
      );

      // Update cache if loaded
      if (this.cacheLoaded && this.solutionCache.has(address)) {
        this.solutionCache.get(address)!.add(challengeId);
      }

      // Update global stats file (best effort - don't fail if this fails)
      try {
        await this.updateStats(address, challengeId, isDonation);
      } catch (error) {
        console.warn(`⚠️  Failed to update stats file:`, error);
      }

      console.log(`✅ Recorded solution for ${address.substring(0, 20)}... on ${challengeId}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to record solution:`, error);
      return false;
    }
  }

  /**
   * Record a solution submission error
   */
  async recordError(
    address: string,
    challengeId: string,
    error: string,
    isDonation: boolean = false,
  ): Promise<boolean> {
    await this.initializeBucketName();

    try {
      // Update global stats file with error
      await this.updateStatsWithError(address, challengeId, error, isDonation);
      console.log(`📝 Recorded error for ${address.substring(0, 20)}... on ${challengeId}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to record error:`, err);
      return false;
    }
  }

  /**
   * Update the global stats file with new solution
   * Uses optimistic locking with ETags to handle race conditions
   * Retries up to 5 times if there's a conflict
   */
  private async updateStats(address: string, challengeId: string, isDonation: boolean = false): Promise<void> {
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Load existing stats with ETag for optimistic locking
        let stats: SolutionStats;
        let etag: string | undefined;

        try {
          const response = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: this.bucketName,
              Key: this.statsKey,
            }),
          );
          const body = await response.Body?.transformToString();
          if (!body) {
            stats = this.createEmptyStats();
          } else {
            stats = JSON.parse(body);
            // Migrate legacy stats
            if (stats.donationSolutions === null || stats.donationSolutions === undefined) {
              stats.donationSolutions = 0;
            }
            if (stats.totalErrors === null || stats.totalErrors === undefined) {
              stats.totalErrors = 0;
            }
            if (!stats.recentSolutions) {
              stats.recentSolutions = [];
            }
            if (!stats.recentErrors) {
              stats.recentErrors = [];
            }
          }
          etag = response.ETag;
        } catch (error: any) {
          if (error.name === "NoSuchKey") {
            stats = this.createEmptyStats();
            etag = undefined;
          } else {
            throw error;
          }
        }

        // Increment totals
        stats.totalSolutions++;
        if (isDonation) {
          stats.donationSolutions++;
        }
        stats.lastUpdated = new Date().toISOString();

        // Add to recent solutions (keep last 20)
        stats.recentSolutions.unshift({
          address,
          challengeId,
          timestamp: new Date().toISOString(),
          isDonation,
        });
        stats.recentSolutions = stats.recentSolutions.slice(0, 20);

        // Write back to S3 with conditional write (only if ETag matches)
        // This prevents race conditions - if another process updated the file,
        // this will fail and we'll retry with the new data
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: this.statsKey,
            Body: JSON.stringify(stats, null, 2),
            ContentType: "application/json",
            IfMatch: etag, // Only write if ETag matches (optimistic locking)
          }),
        );

        // Success! Exit the retry loop
        return;
      } catch (error: any) {
        // If we got a precondition failed error, another process updated the file
        // Retry with the new data
        if (error.name === "PreconditionFailed" && attempt < maxRetries - 1) {
          // Add a small random delay to reduce contention
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
          continue;
        }

        // For other errors or if we've exhausted retries, throw
        throw error;
      }
    }
  }

  /**
   * Update the global stats file with error
   * Uses optimistic locking with ETags to handle race conditions
   */
  private async updateStatsWithError(
    address: string,
    challengeId: string,
    error: string,
    isDonation: boolean = false,
  ): Promise<void> {
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Load existing stats with ETag for optimistic locking
        let stats: SolutionStats;
        let etag: string | undefined;

        try {
          const response = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: this.bucketName,
              Key: this.statsKey,
            }),
          );
          const body = await response.Body?.transformToString();
          if (!body) {
            stats = this.createEmptyStats();
          } else {
            stats = JSON.parse(body);
            // Migrate legacy stats
            if (stats.donationSolutions === null || stats.donationSolutions === undefined) {
              stats.donationSolutions = 0;
            }
            if (stats.totalErrors === null || stats.totalErrors === undefined) {
              stats.totalErrors = 0;
            }
            if (!stats.recentSolutions) {
              stats.recentSolutions = [];
            }
            if (!stats.recentErrors) {
              stats.recentErrors = [];
            }
          }
          etag = response.ETag;
        } catch (error: any) {
          if (error.name === "NoSuchKey") {
            stats = this.createEmptyStats();
            etag = undefined;
          } else {
            throw error;
          }
        }

        // Increment error count
        stats.totalErrors++;
        stats.lastUpdated = new Date().toISOString();

        // Add to recent errors (keep last 20)
        stats.recentErrors.unshift({
          address,
          challengeId,
          timestamp: new Date().toISOString(),
          error,
          isDonation,
        });
        stats.recentErrors = stats.recentErrors.slice(0, 20);

        // Write back to S3 with conditional write
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: this.statsKey,
            Body: JSON.stringify(stats, null, 2),
            ContentType: "application/json",
            IfMatch: etag,
          }),
        );

        // Success! Exit the retry loop
        return;
      } catch (error: any) {
        // If we got a precondition failed error, retry
        if (error.name === "PreconditionFailed" && attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
          continue;
        }

        // For other errors or if we've exhausted retries, throw
        throw error;
      }
    }
  }

  private createEmptyStats(): SolutionStats {
    return {
      totalSolutions: 0,
      donationSolutions: 0,
      totalErrors: 0,
      lastUpdated: new Date().toISOString(),
      recentSolutions: [],
      recentErrors: [],
    };
  }

  /**
   * Get solution stats (fast - single S3 read)
   */
  async getStats(): Promise<SolutionStats> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: this.statsKey,
        }),
      );
      const body = await response.Body?.transformToString();
      if (!body) {
        return this.createEmptyStats();
      }

      const stats = JSON.parse(body);
      // Migrate legacy stats that don't have donationSolutions field
      if (stats.donationSolutions === null || stats.donationSolutions === undefined) {
        stats.donationSolutions = 0;
      }
      if (stats.totalErrors === null || stats.totalErrors === undefined) {
        stats.totalErrors = 0;
      }
      if (!stats.recentSolutions) {
        stats.recentSolutions = [];
      }
      if (!stats.recentErrors) {
        stats.recentErrors = [];
      }
      return stats;
    } catch (error: any) {
      if (error.name === "NoSuchKey") {
        return this.createEmptyStats();
      }
      throw error;
    }
  }

  /**
   * Get all solutions for a specific address
   */
  async getSolutionsForAddress(address: string): Promise<SolutionRecord[]> {
    try {
      const addressSolutions = await this.loadAddressSolutions(address);
      return addressSolutions.solutions;
    } catch (error: any) {
      if (error.name === "NoSuchKey") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Load solutions for a specific address
   */
  private async loadAddressSolutions(address: string): Promise<AddressSolutions> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: this.getAddressKey(address),
      }),
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      throw new Error("Empty response body");
    }

    return JSON.parse(body) as AddressSolutions;
  }
}
