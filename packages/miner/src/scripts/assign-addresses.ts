#!/usr/bin/env node

/**
 * Address reservation script with ETag-based optimistic locking.
 * Prevents race conditions when multiple instances start simultaneously.
 *
 * Caches assigned addresses locally so we don't need to fetch from S3 on every restart.
 * Returns comma-separated list of actual Cardano addresses for this instance.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

const REGISTRY_KEY = "registry.json";
const MAX_RETRIES = 10;
const DEFAULT_ADDRESSES_PER_INSTANCE = 10; // Fallback if not specified in registry
const CACHE_FILE = "/var/lib/night-cloud/addresses.json";

interface InstanceMetadata {
  instanceId: string;
  region: string;
  publicIp: string;
}

interface Registry {
  assignments: Record<string, Assignment>;
  addresses: string[];
  nextAvailable: number;
  lastUpdated: string;
  addressesPerInstance?: number; // Optional for backward compatibility
  region?: string;
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

async function getInstanceMetadata(): Promise<InstanceMetadata> {
  try {
    const token = await getIMDSv2Token();
    const headers = { "X-aws-ec2-metadata-token": token };

    const instanceId = (
      await axios.get("http://169.254.169.254/latest/meta-data/instance-id", { headers, timeout: 2000 })
    ).data;
    const az = (
      await axios.get("http://169.254.169.254/latest/meta-data/placement/availability-zone", { headers, timeout: 2000 })
    ).data;
    const publicIp = (
      await axios.get("http://169.254.169.254/latest/meta-data/public-ipv4", { headers, timeout: 2000 })
    ).data;
    const region = az.slice(0, -1); // Remove zone letter

    return { instanceId, region, publicIp };
  } catch (error) {
    console.error(`❌ Error getting metadata: ${error}`);
    process.exit(1);
  }
}

/**
 * Clean up stale assignments (no heartbeat for 1.5 minutes)
 * Returns true if any assignments were cleaned up
 */
function cleanupStaleAssignments(registry: Registry): boolean {
  const now = Date.now();
  const staleThreshold = 90 * 1000; // 1.5 minutes (90 seconds)
  let cleaned = false;

  for (const [instanceId, assignment] of Object.entries(registry.assignments)) {
    // Check if assignment has a heartbeat
    if (!assignment.lastHeartbeat) {
      // No heartbeat yet - check if assignment is old (>1.5 min)
      const assignedAt = new Date(assignment.assignedAt).getTime();
      if (now - assignedAt > staleThreshold) {
        console.error(`🧹 Cleaning stale assignment (no heartbeat): ${instanceId}`);
        delete registry.assignments[instanceId];
        cleaned = true;
      }
    } else {
      // Has heartbeat - check if it's stale (>1.5 min)
      const lastHeartbeat = new Date(assignment.lastHeartbeat).getTime();
      if (now - lastHeartbeat > staleThreshold) {
        console.error(
          `🧹 Cleaning stale assignment (old heartbeat): ${instanceId} (last: ${assignment.lastHeartbeat})`,
        );
        delete registry.assignments[instanceId];
        cleaned = true;
      }
    }
  }

  return cleaned;
}

async function reserveAddresses(instanceId: string, region: string, publicIp: string): Promise<string[]> {
  const s3 = new S3Client({ region });
  const bucket = await getBucketName(region);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Load current registry with ETag
      let registry: Registry;
      let etag: string;

      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: REGISTRY_KEY,
          }),
        );

        const body = await response.Body?.transformToString();
        if (!body) throw new Error("Empty response body");

        registry = JSON.parse(body);
        etag = response.ETag || "";
      } catch (error: any) {
        if (error.name === "NoSuchKey") {
          console.error(`⏳ Registry not ready, waiting... (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        throw error;
      }

      // Clean up stale assignments (opportunistic cleanup)
      const cleaned = cleanupStaleAssignments(registry);
      if (cleaned) {
        console.error(`✅ Cleaned up stale assignments`);
      }

      // Check if already assigned
      if (registry.assignments[instanceId]) {
        const assignment = registry.assignments[instanceId];
        console.error(`✅ Already assigned: ${assignment.addresses.length} addresses`);
        return assignment.addresses;
      }

      // Validate we have enough addresses
      if (!registry.addresses || registry.addresses.length === 0) {
        throw new Error("No addresses available in registry");
      }

      // Get addresses per instance from registry, or use default
      const addressesPerInstance = registry.addressesPerInstance || DEFAULT_ADDRESSES_PER_INSTANCE;
      console.error(`📊 Using ${addressesPerInstance} addresses per instance`);

      // Reserve new range
      const startAddress = registry.nextAvailable;
      const endAddress = startAddress + addressesPerInstance - 1;

      // Check if we have enough addresses
      if (endAddress >= registry.addresses.length) {
        throw new Error(`Not enough addresses in registry (need ${endAddress + 1}, have ${registry.addresses.length})`);
      }

      // Extract addresses for this instance
      const instanceAddresses = registry.addresses.slice(startAddress, endAddress + 1);

      registry.assignments[instanceId] = {
        instanceId,
        publicIp,
        startAddress,
        endAddress,
        addresses: instanceAddresses,
        assignedAt: new Date().toISOString(),
        region,
        lastHeartbeat: new Date().toISOString(), // Initialize with current time
      };

      registry.nextAvailable = endAddress + 1;
      registry.lastUpdated = new Date().toISOString();

      // Conditional write with ETag (optimistic lock)
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

        console.error(`✅ Reserved ${instanceAddresses.length} addresses (indices ${startAddress}-${endAddress})`);
        return instanceAddresses;
      } catch (error: any) {
        if (error.name === "PreconditionFailed") {
          // Someone else modified the registry, retry
          const backoff = Math.min(2 ** attempt, 10);
          console.error(`⚠️  Lock conflict, retrying in ${backoff}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
          continue;
        }
        throw error;
      }
    } catch (error) {
      console.error(`⚠️  Error on attempt ${attempt + 1}/${MAX_RETRIES}: ${error}`);
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        throw error;
      }
    }
  }

  console.error("❌ Failed to reserve addresses after all retries");
  process.exit(1);
}

function loadCachedAddresses(): string[] | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, "utf-8");
      const cached = JSON.parse(data);
      console.error(`✅ Using cached addresses (${cached.addresses.length} addresses)`);
      return cached.addresses;
    }
  } catch (error) {
    console.error(`⚠️  Failed to load cached addresses: ${error}`);
  }
  return null;
}

function saveCachedAddresses(addresses: string[], instanceId: string): void {
  try {
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const data = {
      addresses,
      instanceId,
      cachedAt: new Date().toISOString(),
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    console.error(`✅ Cached ${addresses.length} addresses to ${CACHE_FILE}`);
  } catch (error) {
    console.error(`⚠️  Failed to cache addresses: ${error}`);
  }
}

async function main() {
  // Try to load from cache first
  const cachedAddresses = loadCachedAddresses();
  if (cachedAddresses) {
    console.log(cachedAddresses.join(","));
    return;
  }

  // No cache, reserve from S3
  console.error("📥 No cached addresses, reserving from S3...");
  const { instanceId, region, publicIp } = await getInstanceMetadata();
  const addresses = await reserveAddresses(instanceId, region, publicIp);

  // Cache for future use
  saveCachedAddresses(addresses, instanceId);

  // Output addresses as comma-separated list (stdout for script capture)
  console.log(addresses.join(","));
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${error}`);
  process.exit(1);
});
