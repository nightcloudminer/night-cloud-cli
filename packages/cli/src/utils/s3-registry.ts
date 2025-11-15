import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * S3 Registry Manager for CLI
 *
 * The CLI handles:
 * 1. Creating region-specific S3 buckets
 * 2. Initializing an empty registry file
 * 3. Uploading the miner code tarball for instances to download
 * 4. Uploading wallet addresses for instances to use
 *
 * All address reservation and heartbeat logic happens on the instances via Python scripts.
 */
export class S3RegistryManager {
  private s3Client: S3Client;
  private stsClient: STSClient;
  private bucketName: string;
  private region: string;
  private registryKey: string = "registry.json";
  private minerCodeKey: string = "miner-code.tar.gz";
  private addressesKey: string = "addresses.json";
  private accountId?: string;

  constructor(region: string) {
    this.region = region;
    this.bucketName = ""; // Will be set after getting account ID
    this.s3Client = new S3Client({ region });
    this.stsClient = new STSClient({ region });
  }

  /**
   * Initialize the bucket name with the AWS account ID
   * This ensures bucket names are globally unique
   */
  private async initializeBucketName(): Promise<void> {
    if (this.bucketName) {
      return; // Already initialized
    }

    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      this.accountId = identity.Account;
      // Use account ID to ensure globally unique bucket name
      this.bucketName = `night-cloud-miner-${this.accountId}-${this.region}`;
    } catch (error) {
      throw new Error(`Failed to get AWS account ID: ${error}`);
    }
  }

  /**
   * Ensure the S3 bucket exists and initialize empty registry
   */
  async ensureBucket(): Promise<void> {
    // Initialize bucket name with account ID
    await this.initializeBucketName();

    // Create bucket if it doesn't exist
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
    } catch (error) {
      await this.s3Client.send(new CreateBucketCommand({ Bucket: this.bucketName }));
    }

    // Initialize empty registry if it doesn't exist
    try {
      await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: this.registryKey,
        }),
      );
    } catch (error) {
      if (error instanceof NoSuchKey || (error as any).name === "NoSuchKey") {
        const emptyRegistry = {
          assignments: {},
          nextAvailable: 0,
          lastUpdated: new Date().toISOString(),
        };

        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: this.registryKey,
            Body: JSON.stringify(emptyRegistry, null, 2),
            ContentType: "application/json",
          }),
        );
      }
    }
  }

  /**
   * Upload miner code tarball to S3
   * This allows instances to download the miner code instead of cloning from GitHub
   */
  async uploadMinerCode(tarballPath: string): Promise<string> {
    // Initialize bucket name with account ID
    await this.initializeBucketName();

    // Read the tarball
    const fileContent = fs.readFileSync(tarballPath);

    // Calculate checksum for integrity verification
    const checksum = crypto.createHash("sha256").update(fileContent).digest("hex");

    // Upload to S3
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.minerCodeKey,
        Body: fileContent,
        ContentType: "application/gzip",
        Metadata: {
          checksum: checksum,
          uploadedAt: new Date().toISOString(),
        },
      }),
    );

    return checksum;
  }

  /**
   * Get the S3 URL for the miner code
   */
  async getMinerCodeUrl(): Promise<string> {
    await this.initializeBucketName();
    return `s3://${this.bucketName}/${this.minerCodeKey}`;
  }

  /**
   * Get the bucket name
   */
  async getBucketName(): Promise<string> {
    await this.initializeBucketName();
    return this.bucketName;
  }

  /**
   * Get the miner code key
   */
  getMinerCodeKey(): string {
    return this.minerCodeKey;
  }

  /**
   * Initialize registry with wallet addresses
   * Creates or updates the registry.json file with addresses
   * Preserves existing assignments if registry already exists
   * Uses ETag-based optimistic locking to prevent race conditions
   */
  async initializeRegistry(addresses: string[], addressesPerInstance: number): Promise<void> {
    // Initialize bucket name with account ID
    await this.initializeBucketName();

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Try to load existing registry to preserve assignments
        let existingRegistry: any = null;
        let etag: string | undefined = undefined;

        try {
          const response = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: this.bucketName,
              Key: this.registryKey,
            }),
          );
          const body = await response.Body?.transformToString();
          if (body) {
            existingRegistry = JSON.parse(body);
            etag = response.ETag;
          }
        } catch (error: any) {
          // Registry doesn't exist yet, that's fine
          if (error.name !== "NoSuchKey") {
            throw error;
          }
        }

        const registry = {
          addresses: addresses,
          assignments: existingRegistry?.assignments || {},
          nextAvailable: existingRegistry?.nextAvailable || 0,
          lastUpdated: new Date().toISOString(),
          region: this.region,
          addressesPerInstance: addressesPerInstance,
        };

        // Use conditional write with ETag if registry exists
        const putParams: any = {
          Bucket: this.bucketName,
          Key: this.registryKey,
          Body: JSON.stringify(registry, null, 2),
          ContentType: "application/json",
        };

        // Only use IfMatch if we have an ETag (registry exists)
        if (etag) {
          putParams.IfMatch = etag;
        }

        await this.s3Client.send(new PutObjectCommand(putParams));

        // Success - exit retry loop
        return;
      } catch (error: any) {
        // Handle precondition failed (someone else modified the registry)
        if (error.name === "PreconditionFailed" && attempt < maxRetries - 1) {
          // Wait a bit before retrying (exponential backoff)
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        // Re-throw other errors or if we've exhausted retries
        throw error;
      }
    }

    throw new Error("Failed to initialize registry after maximum retries");
  }

  /**
   * Get the region this registry is for
   */
  getRegion(): string {
    return this.region;
  }

  /**
   * Write a heartbeat file for a specific instance
   * Each instance writes to its own file to avoid contention
   */
  async writeHeartbeat(instanceId: string, data: { lastHeartbeat: string; publicIp?: string }): Promise<void> {
    await this.initializeBucketName();

    const heartbeatKey = `heartbeats/${instanceId}.json`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: heartbeatKey,
        Body: JSON.stringify(data, null, 2),
        ContentType: "application/json",
      }),
    );
  }

  /**
   * Read a heartbeat file for a specific instance
   */
  async readHeartbeat(instanceId: string): Promise<{ lastHeartbeat: string; publicIp?: string } | null> {
    await this.initializeBucketName();

    const heartbeatKey = `heartbeats/${instanceId}.json`;

    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: heartbeatKey,
        }),
      );

      const body = await response.Body?.transformToString();
      if (body) {
        return JSON.parse(body);
      }
      return null;
    } catch (error: any) {
      if (error.name === "NoSuchKey") {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all heartbeat files and return instance IDs with their last heartbeat times
   */
  async listHeartbeats(): Promise<Map<string, { lastHeartbeat: string; publicIp?: string }>> {
    await this.initializeBucketName();

    const heartbeats = new Map<string, { lastHeartbeat: string; publicIp?: string }>();

    try {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: "heartbeats/",
        }),
      );

      if (response.Contents) {
        // Fetch all heartbeat files in parallel
        const heartbeatPromises = response.Contents.map(async (obj) => {
          if (!obj.Key || !obj.Key.endsWith(".json")) return null;

          const instanceId = obj.Key.replace("heartbeats/", "").replace(".json", "");
          const heartbeat = await this.readHeartbeat(instanceId);

          return heartbeat ? { instanceId, heartbeat } : null;
        });

        const results = await Promise.all(heartbeatPromises);

        for (const result of results) {
          if (result) {
            heartbeats.set(result.instanceId, result.heartbeat);
          }
        }
      }
    } catch (error: any) {
      console.error("Failed to list heartbeats:", error);
    }

    return heartbeats;
  }

  /**
   * Delete a heartbeat file for a specific instance
   */
  async deleteHeartbeat(instanceId: string): Promise<void> {
    await this.initializeBucketName();

    const heartbeatKey = `heartbeats/${instanceId}.json`;

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: heartbeatKey,
        }),
      );
    } catch (error: any) {
      // Ignore if file doesn't exist
      if (error.name !== "NoSuchKey") {
        throw error;
      }
    }
  }
}
