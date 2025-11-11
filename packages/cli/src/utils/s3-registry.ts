import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
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
  private bucketName: string;
  private region: string;
  private registryKey: string = "registry.json";
  private minerCodeKey: string = "miner-code.tar.gz";
  private addressesKey: string = "addresses.json";

  constructor(region: string) {
    this.region = region;
    this.bucketName = `night-cloud-miner-registry-${region}`;
    this.s3Client = new S3Client({ region });
  }

  /**
   * Ensure the S3 bucket exists and initialize empty registry
   */
  async ensureBucket(): Promise<void> {
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
  getMinerCodeUrl(): string {
    return `s3://${this.bucketName}/${this.minerCodeKey}`;
  }

  /**
   * Get the bucket name
   */
  getBucketName(): string {
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
   * Creates or updates the registry.json file with addresses and empty assignments
   */
  async initializeRegistry(addresses: string[], addressesPerInstance: number): Promise<void> {
    const registry = {
      addresses: addresses,
      assignments: {},
      nextAvailable: 0,
      lastUpdated: new Date().toISOString(),
      region: this.region,
      addressesPerInstance: addressesPerInstance,
    };

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.registryKey,
        Body: JSON.stringify(registry, null, 2),
        ContentType: "application/json",
      }),
    );
  }

  /**
   * Get the region this registry is for
   */
  getRegion(): string {
    return this.region;
  }
}
