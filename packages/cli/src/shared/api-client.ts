import axios, { AxiosInstance, AxiosError } from "axios";
import {
  ChallengeSchema,
  ActiveChallengeSchema,
  NoChallengeSchema,
  SolutionReceiptSchema,
  RegistrationReceiptSchema,
  TermsAndConditionsSchema,
  WorkToStarRateSchema,
  ApiErrorSchema,
  parseApiResponse,
  safeParseApiResponse,
  type Challenge,
  type NoChallenge,
  type SolutionReceipt,
  type RegistrationReceipt,
  type TermsAndConditions,
  type WorkToStarRate,
} from "./api";

export class ScavengerMineAPI {
  private client: AxiosInstance;

  constructor(baseUrl: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * GET /TandC - Get Terms and Conditions
   * Reference: Scavenger Mine API V3 spec, page 4
   */
  async getTermsAndConditions(version: string = "1-0"): Promise<TermsAndConditions> {
    try {
      const response = await this.client.get(`/TandC/${version}`);
      return parseApiResponse(TermsAndConditionsSchema, response.data, "GET /TandC");
    } catch (error) {
      throw this.handleApiError(error, "Failed to fetch Terms and Conditions");
    }
  }

  /**
   * POST /register - Register a Cardano address
   * Reference: Scavenger Mine API V3 spec, page 5
   */
  async registerAddress(address: string, signature: string, pubkey: string): Promise<RegistrationReceipt> {
    try {
      const response = await this.client.post(`/register/${address}/${signature}/${pubkey}`);
      return parseApiResponse(RegistrationReceiptSchema, response.data, "POST /register");
    } catch (error) {
      throw this.handleApiError(error, "Failed to register address");
    }
  }

  /**
   * GET /challenge - Get current active challenge
   * Reference: Scavenger Mine API V3 spec
   *
   * Returns Challenge if available, or NoChallenge status
   */
  async getCurrentChallenge(): Promise<Challenge | NoChallenge | null> {
    try {
      const response = await this.client.get("/challenge");

      // Try to parse as ActiveChallenge (new format with wrapper)
      const activeChallengeResult = safeParseApiResponse(ActiveChallengeSchema, response.data);
      if (activeChallengeResult.success) {
        // Extract the challenge data from the wrapper
        return activeChallengeResult.data.challenge;
      }

      // Try to parse as Challenge (legacy format)
      const challengeResult = safeParseApiResponse(ChallengeSchema, response.data);
      if (challengeResult.success) {
        return challengeResult.data;
      }

      // Try to parse as NoChallenge status
      const noChallengeResult = safeParseApiResponse(NoChallengeSchema, response.data);
      if (noChallengeResult.success) {
        return noChallengeResult.data;
      }

      // If no schema matches, throw validation error
      throw new Error(`Invalid challenge response format: ${JSON.stringify(response.data)}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null; // No active challenge
      }
      throw this.handleApiError(error, "Failed to fetch challenge");
    }
  }

  /**
   * POST /solution/{address}/{challenge_id}/{nonce} - Submit a solution
   * Reference: Scavenger Mine API V3 spec
   */
  async submitSolution(address: string, challengeId: string, nonce: string): Promise<SolutionReceipt> {
    try {
      const response = await this.client.post(`/solution/${address}/${challengeId}/${nonce}`, {});

      return parseApiResponse(SolutionReceiptSchema, response.data, "POST /solution");
    } catch (error) {
      // Check if solution already exists (409 Conflict)
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        throw new Error("Solution already exists");
      }
      // Include API error details in the error message
      if (axios.isAxiosError(error) && error.response?.data) {
        throw new Error(`Failed to submit solution: ${JSON.stringify(error.response.data)}`);
      }
      throw this.handleApiError(error, "Failed to submit solution");
    }
  }

  /**
   * GET /work_to_star_rate - Get STAR allocation rates
   * Reference: Scavenger Mine API V3 spec, page 10
   */
  async getWorkToStarRate(): Promise<WorkToStarRate> {
    try {
      const response = await this.client.get("/work_to_star_rate");
      return parseApiResponse(WorkToStarRateSchema, response.data, "GET /work_to_star_rate");
    } catch (error) {
      throw this.handleApiError(error, "Failed to fetch work to star rate");
    }
  }

  /**
   * GET /statistics/{address} - Get statistics for a specific address
   */
  async getAddressStatistics(address: string): Promise<any> {
    try {
      const response = await this.client.get(`/statistics/${address}`);
      return response.data;
    } catch (error) {
      throw this.handleApiError(error, "Failed to fetch address statistics");
    }
  }

  /**
   * POST /donate_to - Consolidate rewards from one address to another
   *
   * IMPORTANT:
   * - URL format is /donate_to/{destination_address}/{original_address}/{signature}
   * - This endpoint is only available on Day 22 (consolidation window after mining ends)
   * - During Days 1-21 (mining period), this endpoint returns 403 Forbidden
   */
  async donateRewards(originalAddress: string, destinationAddress: string, signature: string): Promise<any> {
    try {
      // Correct parameter order: destination FIRST, then original, then signature
      const response = await this.client.post(`/donate_to/${destinationAddress}/${originalAddress}/${signature}`, {});
      return response.data;
    } catch (error) {
      // Check for specific error codes
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        throw new Error("Donation already exists");
      }
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        throw new Error("Donation endpoint not available (may not be Day 22 yet)");
      }
      throw this.handleApiError(error, "Failed to donate rewards");
    }
  }

  /**
   * Construct the message that needs to be signed for donation
   */
  getDonationMessage(destinationAddress: string): string {
    return `Assign accumulated Scavenger rights to: ${destinationAddress}`;
  }

  /**
   * Submit multiple solutions with retry logic
   */
  async submitSolutions(
    solutions: Array<{ address: string; challengeId: string; nonce: string }>,
  ): Promise<Array<{ success: boolean; receipt?: SolutionReceipt; error?: string }>> {
    const results = await Promise.all(
      solutions.map(async (solution) => {
        try {
          const receipt = await this.submitSolution(solution.address, solution.challengeId, solution.nonce);
          return { success: true, receipt };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      }),
    );

    return results;
  }

  /**
   * Helper to handle API errors with proper typing
   */
  private handleApiError(error: unknown, defaultMessage: string): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      // Try to parse as API error response
      if (axiosError.response?.data) {
        const errorResult = safeParseApiResponse(ApiErrorSchema, axiosError.response.data);

        if (errorResult.success) {
          return new Error(`${defaultMessage}: ${JSON.stringify(errorResult.data)}`);
        }
      }

      return new Error(`${defaultMessage}: ${axiosError.message}`);
    }

    if (error instanceof Error) {
      return new Error(`${defaultMessage}: ${error.message}`);
    }

    return new Error(defaultMessage);
  }
}
