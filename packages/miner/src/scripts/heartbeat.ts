#!/usr/bin/env node

/**
 * Heartbeat script that updates the lastHeartbeat timestamp every minute.
 * This keeps the address assignment alive and prevents it from being reclaimed.
 *
 * Uses local cache to avoid fetching registry on every heartbeat.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import axios from "axios";
import * as fs from "fs";

const REGISTRY_KEY = "registry.json";
const MAX_RETRIES = 5;
const CACHE_FILE = "/var/lib/night-cloud/addresses.json";

interface Registry {
  assignments: Record<string, Assignment>;
  lastUpdated: string;
}

interface Assignment {
  instanceId: string;
  publicIp: string;
  startAddress: number;
  endAddress: number;
  addresses: string[];
  assignedAt: string;
  region: string;
  lastHeartbeat?: string;
}

interface CachedData {
  addresses: string[];
  instanceId: string;
  cachedAt: string;
}

function getBucketName(region: string): string {
  return `night-cloud-miner-registry-${region}`;
}

async function getIMDSv2Token(): Promise<string> {
  try {
    const response = await axios.put(
      "http://169.254.169.254/latest/api/token",
      {},
      {
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
        timeout: 2000,
      },
    );
    return response.data;
  } catch (error) {
    console.error(`❌ Error getting IMDSv2 token: ${error}`);
    process.exit(1);
  }
}

async function getInstanceId(): Promise<string> {
  try {
    const token = await getIMDSv2Token();
    const response = await axios.get("http://169.254.169.254/latest/meta-data/instance-id", {
      headers: { "X-aws-ec2-metadata-token": token },
      timeout: 2000,
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Error getting instance ID: ${error}`);
    process.exit(1);
  }
}

async function getRegion(): Promise<string> {
  try {
    const token = await getIMDSv2Token();
    const response = await axios.get("http://169.254.169.254/latest/meta-data/placement/availability-zone", {
      headers: { "X-aws-ec2-metadata-token": token },
      timeout: 2000,
    });
    const az = response.data;
    return az.slice(0, -1); // Remove zone letter
  } catch (error) {
    console.error(`❌ Error getting region: ${error}`);
    process.exit(1);
  }
}

async function updateHeartbeat(instanceId: string, region: string): Promise<boolean> {
  const s3 = new S3Client({ region });
  const bucket = getBucketName(region);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Load current registry with ETag
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: REGISTRY_KEY,
        }),
      );

      const body = await response.Body?.transformToString();
      if (!body) throw new Error("Empty response body");

      const registry: Registry = JSON.parse(body);
      const etag = response.ETag || "";

      // Check if assignment exists
      if (!registry.assignments[instanceId]) {
        console.error(`⚠️  No assignment found for ${instanceId}`);
        return false;
      }

      // Update heartbeat timestamp
      registry.assignments[instanceId].lastHeartbeat = new Date().toISOString();
      registry.lastUpdated = new Date().toISOString();

      // Conditional write with ETag
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: REGISTRY_KEY,
            Body: JSON.stringify(registry, null, 2),
            ContentType: "application/json",
            IfMatch: etag,
          }),
        );

        return true;
      } catch (error: any) {
        if (error.name === "PreconditionFailed") {
          // Someone else modified, retry
          const backoff = Math.min(2 ** attempt, 10);
          await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        console.error(`❌ Failed to update heartbeat: ${error}`);
        return false;
      }
    }
  }

  return false;
}

function loadCachedData(): CachedData | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`⚠️  Failed to load cached data: ${error}`);
  }
  return null;
}

async function main() {
  // Try to get instance ID from cache first (faster)
  const cached = loadCachedData();
  let instanceId: string;

  if (cached) {
    instanceId = cached.instanceId;
  } else {
    instanceId = await getInstanceId();
  }

  const region = await getRegion();

  const success = await updateHeartbeat(instanceId, region);
  if (success) {
    console.log(`✅ Heartbeat updated for ${instanceId}`);
  } else {
    console.error(`❌ Failed to update heartbeat for ${instanceId}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${error}`);
  process.exit(1);
});
