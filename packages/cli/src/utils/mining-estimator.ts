import axios from "axios";
import { z } from "zod";
import { ChallengeResponseSchema, WorkToStarRateSchema } from "../shared";

export interface MiningEstimate {
  instancesNeeded: number;
  solutionsPerHour: number;
  costPerHour: number;
  nightPerHour?: number;
}

export class MiningEstimator {
  constructor(private apiUrl: string) {}

  /**
   * Fetch the current challenge difficulty from the API
   * Returns both hex string and numeric value
   */
  async getCurrentDifficulty(): Promise<{ hex: string; value: number } | null> {
    try {
      const response = await axios.get(`${this.apiUrl}/challenge`, {
        timeout: 10000,
      });

      // Validate response with Zod
      const validatedData = ChallengeResponseSchema.parse(response.data);

      // Check if it's an active challenge
      if (validatedData.code === "active") {
        const difficultyHex = validatedData.challenge.difficulty;
        const difficultyNumber = parseInt(difficultyHex, 16);

        if (isNaN(difficultyNumber)) {
          console.error("Invalid difficulty value:", difficultyHex);
          return null;
        }

        return {
          hex: difficultyHex,
          value: difficultyNumber,
        };
      }

      // No active challenge (before or after)
      return null;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("Invalid API response format:", error.errors);
      } else {
        console.error("Failed to fetch difficulty:", error);
      }
      return null;
    }
  }

  /**
   * Fetch the work-to-star rate from the API
   * Returns the STAR allocation per solution for the most recent day
   *
   * The API returns an array where each element is the STAR per solution for each completed day.
   * There are 1 million STAR per NIGHT.
   */
  async getWorkToStarRate(): Promise<number | null> {
    try {
      const response = await axios.get(`${this.apiUrl}/work_to_star_rate`, {
        timeout: 10000,
      });

      // Validate response with Zod
      const validatedData = WorkToStarRateSchema.parse(response.data);

      // Return the most recent day's rate (last element in array)
      if (validatedData.length > 0) {
        return validatedData[validatedData.length - 1];
      }

      return null;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("Invalid API response format:", error.errors);
      } else {
        console.error("Failed to fetch work-to-star rate:", error);
      }
      return null;
    }
  }

  /**
   * Estimate solutions per hour for a single instance
   *
   * Based on empirical data and mining probability:
   * - c7g.xlarge (4 vCPUs, 4 workers) can compute approximately 1-2 million hashes/second per worker
   * - With 4 workers and 8 addresses, that's ~28.8 billion hashes per hour
   * - The difficulty check is: (hash | difficulty) == difficulty
   * - This means the hash must be a "subset" of difficulty's bits
   * - More bits set in difficulty = more valid hashes = easier
   * - At difficulty 0x7FF (11 bits set), this gives roughly 8 solutions/hour for 8 addresses
   *
   * The difficulty is NOT a threshold - it's a bitmask for the bitwise OR check.
   * More bits set = easier (more hashes pass the check)
   * Fewer bits set = harder (fewer hashes pass the check)
   */
  estimateSolutionsPerInstance(difficulty: number, addressesPerInstance: number): number {
    // Empirical baseline from testing:
    // c7g.xlarge (4 workers) mining 8 addresses = ~8 solutions/hour at difficulty 0x7FF (11 bits set)
    const baselineDifficultyBits = 11; // 0x7FF has 11 bits set
    const baselineSolutionsPerHour = 8;
    const baselineAddresses = 8;

    // Count set bits in the difficulty value (popcount)
    const difficultyBits = difficulty.toString(2).split("1").length - 1;

    // Solutions scale with:
    // 1. Exponential with bit count: 2^(current - baseline) gives the difficulty ratio
    //    - Fewer bits = exponentially harder (each bit removed makes it ~2x harder)
    //    - More bits = exponentially easier (each bit added makes it ~2x easier)
    // 2. Linear with number of addresses (more opportunities to find solutions)
    const difficultyRatio = Math.pow(2, difficultyBits - baselineDifficultyBits);
    const addressRatio = addressesPerInstance / baselineAddresses;

    const solutionsPerHour = baselineSolutionsPerHour * difficultyRatio * addressRatio;

    return Math.max(0.01, solutionsPerHour); // Minimum 0.01 to avoid division by zero
  }

  /**
   * Calculate how many instances are needed to achieve target solutions/hour
   */
  calculateInstancesNeeded(
    targetSolutionsPerHour: number,
    difficultyValue: number,
    addressesPerInstance: number,
    starPerSolution?: number,
  ): MiningEstimate {
    const solutionsPerInstance = this.estimateSolutionsPerInstance(difficultyValue, addressesPerInstance);

    const instancesNeeded = Math.ceil(targetSolutionsPerHour / solutionsPerInstance);

    const solutionsPerHour = instancesNeeded * solutionsPerInstance;

    // Calculate $NIGHT per hour if STAR rate is available
    // 1 NIGHT = 1,000,000 STAR
    let nightPerHour: number | undefined;
    if (starPerSolution !== undefined) {
      const starPerHour = solutionsPerHour * starPerSolution;
      nightPerHour = starPerHour / 1_000_000;
    }

    return {
      instancesNeeded,
      solutionsPerHour,
      costPerHour: 0, // Will be calculated in deploy command
      nightPerHour,
    };
  }
}
