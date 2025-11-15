#!/usr/bin/env node

/**
 * Registry cleanup script that removes stale assignments.
 * Should be run periodically (e.g., every 15-30 minutes) by a single instance.
 * Uses ETag-based optimistic locking to safely update the registry.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import axios from "axios";

const REGISTRY_KEY = "registry.json";
const MAX_RETRIES = 60; // Retry for ~10 minutes (exponential backoff: 1s, 2s, 4s, 8s, then 10s per retry)
const STALE_THRESHOLD = 1800 * 1000; // 30 minutes

interface Registry {
  assignments: Record<string, Assignment>;
  addresses: string[];
  lastUpdated: string;
  addressesPerInstance?: number;
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

/**
 * Leader election: check if this instance is the alphabetically first running instance
 * This ensures only one instance runs cleanup at a time
 */
async function isLeader(instanceId: string, region: string): Promise<boolean> {
  try {
    const ec2 = new EC2Client({ region });

    // Get all running instances with the night-cloud-miner tag
    const response = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          {
            Name: "instance-state-name",
            Values: ["running"],
          },
          {
            Name: "tag:Name",
            Values: ["night-cloud-miner-instance"],
          },
        ],
      }),
    );

    // Collect all running instance IDs
    const runningInstances: string[] = [];
    if (response.Reservations) {
      for (const reservation of response.Reservations) {
        if (reservation.Instances) {
          for (const instance of reservation.Instances) {
            if (instance.InstanceId) {
              runningInstances.push(instance.InstanceId);
            }
          }
        }
      }
    }

    if (runningInstances.length === 0) {
      console.log(`⚠️  No running instances found`);
      return false;
    }

    // Sort alphabetically and check if we're first
    runningInstances.sort();
    const leader = runningInstances[0];
    const isLeaderInstance = instanceId === leader;

    console.log(`📊 Leader election: ${runningInstances.length} running instances, leader is ${leader}`);
    if (isLeaderInstance) {
      console.log(`👑 This instance (${instanceId}) is the leader`);
    } else {
      console.log(`⏭️  This instance (${instanceId}) is not the leader, skipping cleanup`);
    }

    return isLeaderInstance;
  } catch (error) {
    console.error(`⚠️  Error during leader election: ${error}`);
    // On error, don't run cleanup to be safe
    return false;
  }
}

/**
 * Scan all heartbeat files and return a map of instance IDs to their last heartbeat times
 */
async function scanHeartbeats(s3: S3Client, bucket: string): Promise<Map<string, number>> {
  const heartbeats = new Map<string, number>();

  try {
    const heartbeatsResponse = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "heartbeats/",
      }),
    );

    if (heartbeatsResponse.Contents) {
      // Fetch all heartbeat files in parallel for speed
      const heartbeatPromises = heartbeatsResponse.Contents.map(async (obj) => {
        if (!obj.Key || !obj.Key.endsWith(".json")) return null;

        const instanceId = obj.Key.replace("heartbeats/", "").replace(".json", "");

        try {
          const heartbeatResponse = await s3.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: obj.Key,
            }),
          );

          const body = await heartbeatResponse.Body?.transformToString();
          if (body) {
            const heartbeatData = JSON.parse(body);
            const lastHeartbeat = new Date(heartbeatData.lastHeartbeat).getTime();
            return { instanceId, lastHeartbeat };
          }
        } catch (error) {
          console.error(`⚠️  Failed to read heartbeat for ${instanceId}: ${error}`);
        }

        return null;
      });

      const results = await Promise.all(heartbeatPromises);

      for (const result of results) {
        if (result) {
          heartbeats.set(result.instanceId, result.lastHeartbeat);
        }
      }
    }
  } catch (error) {
    console.error(`⚠️  Failed to scan heartbeats: ${error}`);
  }

  return heartbeats;
}

/**
 * Clean up stale assignments with ETag-based optimistic locking
 */
async function cleanupRegistry(region: string): Promise<void> {
  const s3 = new S3Client({ region });
  const bucket = await getBucketName(region);
  const now = Date.now();

  console.log(`🧹 Starting registry cleanup for ${region}...`);

  // Scan all heartbeat files first (doesn't require locking)
  console.log(`📊 Scanning heartbeat files...`);
  const heartbeats = await scanHeartbeats(s3, bucket);
  console.log(`📊 Found ${heartbeats.size} heartbeat files`);

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

      console.log(`📊 Registry has ${Object.keys(registry.assignments).length} assignments`);

      // Identify stale assignments
      const staleInstances: string[] = [];

      for (const [instanceId, assignment] of Object.entries(registry.assignments)) {
        const lastHeartbeat = heartbeats.get(instanceId);

        if (!lastHeartbeat) {
          // No heartbeat file - check if assignment is old
          const assignedAt = new Date(assignment.assignedAt).getTime();
          if (now - assignedAt > STALE_THRESHOLD) {
            staleInstances.push(instanceId);
          }
        } else {
          // Has heartbeat - check if it's stale
          if (now - lastHeartbeat > STALE_THRESHOLD) {
            staleInstances.push(instanceId);
          }
        }
      }

      if (staleInstances.length === 0) {
        console.log(`✅ No stale assignments found`);
        return;
      }

      console.log(`🧹 Found ${staleInstances.length} stale assignments to clean up`);

      // Remove stale assignments
      for (const instanceId of staleInstances) {
        const assignment = registry.assignments[instanceId];
        const lastHeartbeat = heartbeats.get(instanceId);
        const lastHeartbeatStr = lastHeartbeat ? new Date(lastHeartbeat).toISOString() : "never";

        console.log(
          `   🗑️  Removing ${instanceId} (addresses ${assignment.startAddress}-${assignment.endAddress}, last heartbeat: ${lastHeartbeatStr})`,
        );
        delete registry.assignments[instanceId];
      }

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

        console.log(`✅ Registry cleanup completed - removed ${staleInstances.length} stale assignments`);
        return;
      } catch (error: any) {
        if (error.name === "PreconditionFailed") {
          // Someone else modified the registry, retry
          const backoff = Math.min(2 ** attempt * 1000, 10000);
          console.log(`⚠️  Registry was modified by another process, retrying in ${backoff}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        const backoff = 2000;
        console.error(`⚠️  Error during cleanup (attempt ${attempt + 1}/${MAX_RETRIES}): ${error}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } else {
        console.error(`❌ Failed to cleanup registry after ${MAX_RETRIES} attempts: ${error}`);
        process.exit(1);
      }
    }
  }
}

async function main() {
  const region = await getRegion();
  const instanceId = await getInstanceId();

  // Leader election: only the alphabetically first running instance runs cleanup
  const leader = await isLeader(instanceId, region);
  if (!leader) {
    console.log(`✅ Cleanup skipped (not leader)`);
    process.exit(0);
  }

  // This instance is the leader, proceed with cleanup
  await cleanupRegistry(region);
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${error}`);
  process.exit(1);
});
