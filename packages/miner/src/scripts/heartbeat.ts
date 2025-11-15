#!/usr/bin/env node

/**
 * Heartbeat script that writes a heartbeat timestamp to a separate S3 file.
 * Each instance writes to its own file (heartbeats/{instance-id}.json) to avoid contention.
 * This keeps the address assignment alive and prevents it from being reclaimed.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import axios from "axios";
import * as fs from "fs";

const CACHE_FILE = "/var/lib/night-cloud/addresses.json";

interface CachedData {
  addresses: string[];
  instanceId: string;
  cachedAt: string;
}

interface HeartbeatData {
  lastHeartbeat: string;
  publicIp?: string;
}

async function getBucketName(region: string): Promise<string> {
  try {
    const sts = new STSClient({ region });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    return `night-cloud-miner-${accountId}-${region}`;
  } catch (error) {
    console.error(`❌ Error getting AWS account ID: ${error}`);
    process.exit(1);
  }
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

async function getPublicIp(): Promise<string | undefined> {
  try {
    const token = await getIMDSv2Token();
    const response = await axios.get("http://169.254.169.254/latest/meta-data/public-ipv4", {
      headers: { "X-aws-ec2-metadata-token": token },
      timeout: 2000,
    });
    return response.data;
  } catch (error) {
    // Public IP might not be available, that's okay
    return undefined;
  }
}

async function updateHeartbeat(instanceId: string, region: string): Promise<boolean> {
  const s3 = new S3Client({ region });
  const bucket = await getBucketName(region);

  try {
    // Get public IP if available
    const publicIp = await getPublicIp();

    // Write heartbeat to individual file - no contention!
    const heartbeatData: HeartbeatData = {
      lastHeartbeat: new Date().toISOString(),
      publicIp,
    };

    const heartbeatKey = `heartbeats/${instanceId}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: heartbeatKey,
        Body: JSON.stringify(heartbeatData, null, 2),
        ContentType: "application/json",
      }),
    );

    return true;
  } catch (error) {
    console.error(`❌ Failed to update heartbeat: ${error}`);
    return false;
  }
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
