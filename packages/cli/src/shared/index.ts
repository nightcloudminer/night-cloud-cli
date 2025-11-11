// API Client
export { ScavengerMineAPI } from "./api-client";

// API Schemas
export * from "./api";

// Re-export commonly used types
export type {
  Challenge,
  NoChallenge,
  ChallengeResponse,
  SolutionReceipt,
  RegistrationReceipt,
  TermsAndConditions,
  WorkToStarRate,
  ApiError,
} from "./api";

