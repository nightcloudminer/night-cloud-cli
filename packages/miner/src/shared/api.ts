import { z } from "zod";

/**
 * Scavenger Mine API schemas based on official specification
 * Reference: https://45047878.fs1.hubspotusercontent-na1.net/hubfs/45047878/Midnight%20-%20Whitepaper%20treatment%20for%20Scavenger%20Mine%20API%20V3.pdf
 */

// Challenge data schema
export const ChallengeDataSchema = z.object({
  challenge_id: z.string().regex(/^\*\*[A-Z0-9]+$/, "Challenge ID must start with **"),
  challenge_number: z.number(),
  day: z.number(),
  issued_at: z.string().datetime(),
  difficulty: z.string().regex(/^[0-9A-F]+$/, "Difficulty must be hex string"),
  no_pre_mine: z.string().regex(/^[0-9a-f]{64}$/, "No pre-mine must be 64 char hex"),
  latest_submission: z.string().datetime(), // ISO 8601 format
  no_pre_mine_hour: z.string().regex(/^\d+$/, "No pre-mine hour must be numeric string"),
});

export type ChallengeData = z.infer<typeof ChallengeDataSchema>;

// Active challenge response - GET /challenge
export const ActiveChallengeSchema = z.object({
  code: z.literal("active"),
  challenge: ChallengeDataSchema,
  mining_period_ends: z.string().datetime(),
  max_day: z.number(),
  total_challenges: z.number(),
  current_day: z.number(),
  next_challenge_starts_at: z.string().datetime(),
});

export type ActiveChallenge = z.infer<typeof ActiveChallengeSchema>;

// Legacy challenge schema (for backward compatibility)
export const ChallengeSchema = ChallengeDataSchema;
export type Challenge = z.infer<typeof ChallengeSchema>;

// Alternative response when no challenge is available
export const NoChallengeSchema = z.object({
  code: z.enum(["before", "after"]),
  starts_at: z.string().datetime().optional(),
  next_challenge_starts_at: z.string().datetime().optional(),
  current_day: z.number().optional(),
  mining_period_ends: z.string().datetime().optional(),
  max_day: z.number().optional(),
  total_challenges: z.number().optional(),
});

export type NoChallenge = z.infer<typeof NoChallengeSchema>;

// Union type for challenge endpoint response
export const ChallengeResponseSchema = z.union([ActiveChallengeSchema, NoChallengeSchema]);

export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

// Registration receipt schema - POST /register
// The API returns a registration_receipt object, but the exact structure may vary
// Making this more lenient to accept any object with optional fields
export const RegistrationReceiptSchema = z
  .object({
    address: z.string().optional(),
    signature: z.string().optional(),
    timestamp: z.string().optional(),
    receipt_id: z.string().optional(),
    message: z.string().optional(),
    statusCode: z.number().optional(),
  })
  .passthrough(); // Allow additional fields we don't know about

export type RegistrationReceipt = z.infer<typeof RegistrationReceiptSchema>;

// Solution submission response - POST /solution
export const SolutionReceiptSchema = z
  .object({
    address: z.string().optional(),
    challenge_id: z.string().optional(),
    nonce: z.string().optional(),
    crypto_receipt: z.union([z.string(), z.object({}).passthrough()]).optional(),
    timestamp: z.string().datetime().optional(),
  })
  .passthrough();

export type SolutionReceipt = z.infer<typeof SolutionReceiptSchema>;

// Error response schema
export const ApiErrorSchema = z.object({
  message: z.string(),
  error: z.string(),
  statusCode: z.number(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// Terms and Conditions schema - GET /TandC
export const TermsAndConditionsSchema = z.object({
  version: z.string(),
  content: z.string(),
  message: z.string(),
});

export type TermsAndConditions = z.infer<typeof TermsAndConditionsSchema>;

// Work to STAR rate schema - GET /work_to_star_rate
export const WorkToStarRateSchema = z.array(z.number());

export type WorkToStarRate = z.infer<typeof WorkToStarRateSchema>;

// Donation assignment schema - POST /donate_to
export const DonationReceiptSchema = z.object({
  original_address: z.string(),
  destination_address: z.string(),
  timestamp: z.string().datetime(),
  receipt_id: z.string().optional(),
});

export type DonationReceipt = z.infer<typeof DonationReceiptSchema>;

/**
 * Helper function to safely parse API responses
 */
export function parseApiResponse<T>(schema: z.ZodSchema<T>, data: unknown, context?: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`API response validation failed${context ? ` for ${context}` : ""}: ${issues}`);
    }
    throw error;
  }
}

/**
 * Helper function to safely parse API responses with fallback
 */
export function safeParseApiResponse<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
