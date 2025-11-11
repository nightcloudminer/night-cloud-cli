import { QueuedChallenge } from "./challenge-queue";
import { SolutionTracker } from "./solution-tracker";

export interface WorkItem {
  address: string;
  addressIndex: number;
  challenge: QueuedChallenge;
  id: string; // Unique identifier: `${address}-${challengeId}`
  isDonation?: boolean; // Flag to indicate this is a donation work item
}

interface DonationInfo {
  address: string;
  percentage: number;
  description: string;
}

/**
 * In-memory work queue constructed from available challenges and solved solutions
 */
export class WorkQueue {
  private queue: WorkItem[] = [];
  private inProgress: Set<string> = new Set(); // Track work items being processed
  private solutionTracker: SolutionTracker;
  private donationApiUrl: string = "https://nightcloudminer.com/api/donation";

  constructor(solutionTracker: SolutionTracker) {
    this.solutionTracker = solutionTracker;
  }

  /**
   * Fetch donation address from API (returns a fresh random address each time)
   */
  private async fetchDonationAddress(): Promise<string | null> {
    try {
      const response = await fetch(this.donationApiUrl);
      if (!response.ok) {
        console.warn(`⚠️  Failed to fetch donation address: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as DonationInfo;
      return data.address;
    } catch (error) {
      console.warn(`⚠️  Error fetching donation address:`, error);
      return null;
    }
  }

  /**
   * Build the work queue from available challenges and addresses
   * Only includes unsolved challenge-address pairs
   * Inserts donation work items every 20 regular items
   */
  async build(addresses: string[], challenges: QueuedChallenge[]): Promise<void> {
    console.log(`🔨 Building work queue for ${addresses.length} addresses × ${challenges.length} challenges...`);
    this.queue = [];
    this.inProgress.clear();

    // Sort challenges by difficulty (easiest first)
    // Difficulty is in hex format (e.g., "01ACE880", "000007FF")
    // The check is: (hash | difficulty) == difficulty
    // This means hash must be a "subset" of difficulty's bits
    // More bits set = more possible valid hashes = easier
    const sortedChallenges = [...challenges].sort((a, b) => {
      const diffA = parseInt(a.difficulty, 16);
      const diffB = parseInt(b.difficulty, 16);

      // Count set bits (popcount)
      const countBitsA = diffA.toString(2).split("1").length - 1;
      const countBitsB = diffB.toString(2).split("1").length - 1;

      return countBitsB - countBitsA; // Descending by bit count (more bits = easier)
    });

    // Get the easiest challenge for donations (if available)
    const donationChallenge = sortedChallenges[0];

    const regularWorkItems: WorkItem[] = [];

    // For each challenge (easiest first), create work items for addresses that haven't solved it
    for (const challenge of sortedChallenges) {
      for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        const alreadySolved = await this.solutionTracker.hasSolution(address, challenge.challengeId);

        if (!alreadySolved) {
          const workItem: WorkItem = {
            address,
            addressIndex: i,
            challenge,
            id: `${address}-${challenge.challengeId}`,
            isDonation: false,
          };
          regularWorkItems.push(workItem);
        }
      }
    }

    // Insert donation items every 20 regular work items
    // Randomly offset the donation items by 0-20 items
    const donationOffset = Math.floor(Math.random() * 20);
    let donationCount = 0;
    if (donationChallenge) {
      for (let i = 0; i < regularWorkItems.length; i++) {
        this.queue.push(regularWorkItems[i]);

        // Every 20 items, insert a donation work item with a fresh address
        if ((i + donationOffset) % 20 === 0) {
          // Fetch a fresh donation address for each work item
          const freshDonationAddress = await this.fetchDonationAddress();

          if (freshDonationAddress) {
            const donationId = `donation-${donationCount}-${donationChallenge.challengeId}`;

            // Check if this address already solved this challenge
            const alreadySolved = await this.solutionTracker.hasSolution(
              freshDonationAddress,
              donationChallenge.challengeId,
            );

            if (!alreadySolved) {
              const donationWorkItem: WorkItem = {
                address: freshDonationAddress,
                addressIndex: -1, // Special index for donation
                challenge: donationChallenge,
                id: donationId,
                isDonation: true,
              };
              this.queue.push(donationWorkItem);
              donationCount++;
            }
          }
        }
      }
    } else {
      // No donation address available, just use regular items
      this.queue = regularWorkItems;
    }

    console.log(
      `📋 Work queue built: ${this.queue.length} total items (${regularWorkItems.length} regular${
        donationCount > 0 ? `, ${donationCount} donation` : ""
      })`,
    );
  }

  /**
   * Get the next work item from the queue (oldest challenge first)
   * Returns null if queue is empty or all items are in progress
   */
  getNext(): WorkItem | null {
    // Find first item not in progress and not expired
    const now = new Date();
    for (const item of this.queue) {
      if (this.inProgress.has(item.id)) {
        continue; // Already being worked on
      }

      // Check if challenge has expired
      const expiresAt = new Date(item.challenge.latestSubmission);
      if (expiresAt <= now) {
        continue; // Expired
      }

      // Mark as in progress and return
      this.inProgress.add(item.id);
      return item;
    }

    return null;
  }

  /**
   * Mark a work item as complete (removes from queue)
   */
  complete(workItemId: string): void {
    this.inProgress.delete(workItemId);
    this.queue = this.queue.filter((item) => item.id !== workItemId);
  }

  /**
   * Release a work item back to the queue (e.g., if worker failed)
   */
  release(workItemId: string): void {
    this.inProgress.delete(workItemId);
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    available: number;
    inProgress: number;
    byChallenge: Map<string, number>;
    donationItems: number;
  } {
    const byChallenge = new Map<string, number>();
    let available = 0;
    let donationItems = 0;
    const now = new Date();

    for (const item of this.queue) {
      const expiresAt = new Date(item.challenge.latestSubmission);
      if (expiresAt > now && !this.inProgress.has(item.id)) {
        available++;
      }

      if (item.isDonation) {
        donationItems++;
      }

      const count = byChallenge.get(item.challenge.challengeId) || 0;
      byChallenge.set(item.challenge.challengeId, count + 1);
    }

    return {
      total: this.queue.length,
      available,
      inProgress: this.inProgress.size,
      byChallenge,
      donationItems,
    };
  }

  /**
   * Remove expired work items from the queue
   */
  cleanExpired(): number {
    const now = new Date();
    const initialLength = this.queue.length;

    this.queue = this.queue.filter((item) => {
      const expiresAt = new Date(item.challenge.latestSubmission);
      if (expiresAt <= now) {
        this.inProgress.delete(item.id); // Also remove from in-progress
        return false;
      }
      return true;
    });

    return initialLength - this.queue.length;
  }

  /**
   * Check if queue is empty (no available work)
   */
  isEmpty(): boolean {
    const now = new Date();
    return !this.queue.some((item) => {
      const expiresAt = new Date(item.challenge.latestSubmission);
      return expiresAt > now && !this.inProgress.has(item.id);
    });
  }
}
