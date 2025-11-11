import { Challenge } from "./shared";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export interface QueuedChallenge {
  challengeId: string;
  challengeNumber: number;
  challengeTotal: number;
  campaignDay: number;
  difficulty: string;
  noPreMine: string;
  noPreMineHour: string;
  latestSubmission: string; // ISO 8601 timestamp
  availableAt: string; // ISO 8601 timestamp
}

/**
 * In-memory challenge queue, prioritizing older challenges first
 */
export class ChallengeQueueManager {
  private challenges: QueuedChallenge[] = [];
  private maxChallenges: number = 24;
  private s3Client: S3Client;
  private bucketName: string;
  private region: string;

  constructor(region: string) {
    this.region = region;
    this.bucketName = `night-cloud-miner-registry-${region}`;
    this.s3Client = new S3Client({ region });
  }

  /**
   * Initialize the queue by loading from S3, or fallback to API
   */
  async initialize(): Promise<void> {
    try {
      // Try to load from S3 first
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: "challenges.json",
        }),
      );

      const body = await response.Body?.transformToString();
      if (body) {
        const data = JSON.parse(body);
        if (data.challenges && Array.isArray(data.challenges)) {
          this.challenges = data.challenges;

          // Sort by availableAt (oldest first)
          this.challenges.sort((a, b) => new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime());

          console.log(`📋 Loaded ${this.challenges.length} challenge(s) from S3`);
          return;
        }
      }
    } catch (error: any) {
      if (error.name === "NoSuchKey") {
        console.log("📋 No challenges.json in S3, trying API fallback...");
        await this.loadFromAPI();
      } else {
        console.error("⚠️  Failed to load challenges from S3:", error);
        await this.loadFromAPI();
      }
    }
  }

  /**
   * Load challenges from API
   */
  private async loadFromAPI(): Promise<void> {
    try {
      console.log("📋 Fetching challenges from API...");
      const response = await fetch("https://nightcloudminer.com/api/challenges");

      if (!response.ok) {
        console.error(`⚠️  API returned status ${response.status}`);
        return;
      }

      const challenges = await response.json();

      if (Array.isArray(challenges)) {
        // Convert from API format to QueuedChallenge format
        this.challenges = challenges.map((c: any) => ({
          challengeId: c.challengeId,
          challengeNumber: c.challengeNumber,
          challengeTotal: c.challengeTotal || 504,
          campaignDay: c.campaignDay,
          difficulty: c.difficulty,
          noPreMine: c.noPreMine,
          noPreMineHour: c.noPreMineHour,
          latestSubmission: c.latestSubmission,
          availableAt: c.availableAt,
        }));

        // Sort by availableAt (oldest first)
        this.challenges.sort((a, b) => new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime());

        console.log(`📋 Loaded ${this.challenges.length} challenge(s) from API`);

        // Persist to S3 so other instances can use it
        await this.persist();
        console.log(`📋 Uploaded challenges to S3 for sharing`);
      }
    } catch (error) {
      console.error("⚠️  Failed to load challenges from API:", error);
      console.log("📋 Starting with empty challenge queue - will populate from mining loop");
    }
  }

  /**
   * Persist the queue to S3
   */
  private async persist(): Promise<void> {
    try {
      const data = {
        challenges: this.challenges,
        lastUpdated: new Date().toISOString(),
        region: this.region,
      };

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: "challenges.json",
          Body: JSON.stringify(data, null, 2),
          ContentType: "application/json",
        }),
      );
    } catch (error) {
      console.error("⚠️  Failed to persist challenges to S3:", error);
      // Don't throw - continue with in-memory queue
    }
  }

  /**
   * Add a new challenge to the queue (if it doesn't already exist)
   */
  async addChallenge(challenge: Challenge): Promise<void> {
    // Check if challenge already exists
    const exists = this.challenges.some((c) => c.challengeId === challenge.challenge_id);
    if (exists) {
      return;
    }

    // Convert API challenge to queued challenge
    const queuedChallenge: QueuedChallenge = {
      challengeId: challenge.challenge_id,
      challengeNumber: challenge.challenge_number,
      challengeTotal: 504, // Total challenges in campaign
      campaignDay: challenge.day,
      difficulty: challenge.difficulty,
      noPreMine: challenge.no_pre_mine,
      noPreMineHour: challenge.no_pre_mine_hour,
      latestSubmission: challenge.latest_submission,
      availableAt: challenge.issued_at,
    };

    // Add to queue
    this.challenges.push(queuedChallenge);

    // Sort by availableAt (oldest first)
    this.challenges.sort((a, b) => new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime());

    // Keep only the last N challenges
    if (this.challenges.length > this.maxChallenges) {
      this.challenges = this.challenges.slice(-this.maxChallenges);
    }

    // Persist to S3
    await this.persist();
  }

  /**
   * Get all challenges in the queue
   */
  getChallenges(): QueuedChallenge[] {
    return this.challenges;
  }

  /**
   * Get the next challenge to mine (oldest available challenge)
   */
  getNextChallenge(): QueuedChallenge | null {
    if (this.challenges.length === 0) {
      return null;
    }

    const now = new Date();

    // Filter out expired challenges
    const availableChallenges = this.challenges.filter((c) => {
      const latestSubmission = new Date(c.latestSubmission);
      return latestSubmission > now;
    });

    if (availableChallenges.length === 0) {
      return null;
    }

    // Return the oldest available challenge
    return availableChallenges[0];
  }

  /**
   * Remove expired challenges from the queue
   */
  cleanExpiredChallenges(): number {
    const now = new Date();
    const initialCount = this.challenges.length;

    // Keep only non-expired challenges
    this.challenges = this.challenges.filter((c) => {
      const latestSubmission = new Date(c.latestSubmission);
      return latestSubmission > now;
    });

    return initialCount - this.challenges.length;
  }

  /**
   * Check if a challenge has expired
   */
  isChallengeExpired(challenge: QueuedChallenge): boolean {
    const now = new Date();
    const latestSubmission = new Date(challenge.latestSubmission);
    return latestSubmission <= now;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.challenges.length;
  }
}
