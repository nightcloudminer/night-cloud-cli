#!/usr/bin/env node

/**
 * Registry cleanup script that removes assignments for instances that are no longer running.
 * Should be run periodically (e.g., every 15-30 minutes) by a single instance.
 * Uses ETag-based optimistic locking to safely update the registry.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import axios from "axios";

const REGISTRY_KEY = "registry.json";
const MAX_RETRIES = 60; // Retry for ~10 minutes (exponential backoff: 1s, 2s, 4s, 8s, then 10s per retry)

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
 * Get all running instance IDs and perform leader election
 * Returns the set of running instance IDs and whether this instance is the leader
 */
async function getRunningInstancesAndCheckLeader(
  instanceId: string,
  region: string,
): Promise<{ runningInstances: Set<string>; isLeader: boolean }> {
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
      return { runningInstances: new Set(), isLeader: false };
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

    return { runningInstances: new Set(runningInstances), isLeader: isLeaderInstance };
  } catch (error) {
    console.error(`⚠️  Error during leader election: ${error}`);
    // On error, don't run cleanup to be safe
    return { runningInstances: new Set(), isLeader: false };
  }
}

/**
 * Clean up assignments for instances that are no longer running
 * Uses ETag-based optimistic locking for safe concurrent updates
 */
async function cleanupRegistry(region: string, runningInstances: Set<string>): Promise<void> {
  const s3 = new S3Client({ region });
  const bucket = await getBucketName(region);

  console.log(`🧹 Starting registry cleanup for ${region}...`);
  console.log(`📊 Currently running instances: ${Array.from(runningInstances).join(", ")}`);

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

      // Identify assignments for instances that are no longer running
      const staleInstances: string[] = [];

      for (const instanceId of Object.keys(registry.assignments)) {
        if (!runningInstances.has(instanceId)) {
          staleInstances.push(instanceId);
        }
      }

      if (staleInstances.length === 0) {
        console.log(`✅ No stale assignments found - all assignments are for running instances`);
        return;
      }

      console.log(`🧹 Found ${staleInstances.length} assignments for instances that are no longer running`);

      // Remove stale assignments
      for (const instanceId of staleInstances) {
        const assignment = registry.assignments[instanceId];
        console.log(`   🗑️  Removing ${instanceId} (addresses ${assignment.startAddress}-${assignment.endAddress})`);
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

  // Get running instances and perform leader election
  const { runningInstances, isLeader } = await getRunningInstancesAndCheckLeader(instanceId, region);
  if (!isLeader) {
    console.log(`✅ Cleanup skipped (not leader)`);
    process.exit(0);
  }

  // This instance is the leader, proceed with cleanup
  await cleanupRegistry(region, runningInstances);
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${error}`);
  process.exit(1);
});
