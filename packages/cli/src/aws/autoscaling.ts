import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
  DeleteAutoScalingGroupCommand,
  StartInstanceRefreshCommand,
  DescribeInstanceRefreshesCommand,
} from "@aws-sdk/client-auto-scaling";
import { Config } from "../types";

export class AutoScalingManager {
  private clients: Map<string, AutoScalingClient> = new Map();

  private getClient(region: string): AutoScalingClient {
    if (!this.clients.has(region)) {
      this.clients.set(region, new AutoScalingClient({ region }));
    }
    return this.clients.get(region)!;
  }

  async createOrUpdateAutoScalingGroup(
    region: string,
    config: Config,
    desiredCount: number,
    availabilityZones: string[],
  ): Promise<void> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;
    const templateName = "night-cloud-miner-template";

    // Check if ASG exists
    try {
      const describeCommand = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [asgName],
      });

      const response = await client.send(describeCommand);

      if (response.AutoScalingGroups && response.AutoScalingGroups.length > 0) {
        // Update existing ASG
        const updateCommand = new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: asgName,
          LaunchTemplate: {
            LaunchTemplateName: templateName,
            Version: "$Latest",
          },
          MinSize: desiredCount,
          MaxSize: desiredCount,
          DesiredCapacity: desiredCount,
        });

        await client.send(updateCommand);
        return;
      }
    } catch (error) {
      // ASG doesn't exist, create it
    }

    // Create new ASG
    const createCommand = new CreateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      LaunchTemplate: {
        LaunchTemplateName: templateName,
        Version: "$Latest",
      },
      MinSize: desiredCount,
      MaxSize: desiredCount,
      DesiredCapacity: desiredCount,
      AvailabilityZones: availabilityZones,
      Tags: [
        {
          Key: "Name",
          Value: "night-cloud-miner-instance",
          PropagateAtLaunch: true,
        },
        {
          Key: "Project",
          Value: "NightCloudMiner",
          PropagateAtLaunch: true,
        },
      ],
    });

    await client.send(createCommand);
  }

  async scaleAutoScalingGroup(region: string, desiredCount: number): Promise<void> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    const command = new SetDesiredCapacityCommand({
      AutoScalingGroupName: asgName,
      DesiredCapacity: desiredCount,
    });

    await client.send(command);
  }

  async setAutoScalingGroupCapacity(
    region: string,
    minSize: number,
    maxSize: number,
    desiredCapacity: number,
  ): Promise<void> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    const command = new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      MinSize: minSize,
      MaxSize: maxSize,
      DesiredCapacity: desiredCapacity,
    });

    await client.send(command);
  }

  async getAutoScalingGroupSize(region: string): Promise<number> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    try {
      const command = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [asgName],
      });

      const response = await client.send(command);

      if (response.AutoScalingGroups && response.AutoScalingGroups.length > 0) {
        return response.AutoScalingGroups[0].DesiredCapacity || 0;
      }
    } catch (error) {
      // ASG doesn't exist
    }

    return 0;
  }

  async getAutoScalingGroupInstances(region: string): Promise<string[]> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    try {
      const command = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [asgName],
      });

      const response = await client.send(command);

      if (response.AutoScalingGroups && response.AutoScalingGroups.length > 0) {
        const instances = response.AutoScalingGroups[0].Instances || [];
        return instances.map((i) => i.InstanceId).filter((id): id is string => !!id);
      }
    } catch (error) {
      // ASG doesn't exist
    }

    return [];
  }

  async deleteAutoScalingGroup(region: string, forceDelete: boolean = true): Promise<void> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    const command = new DeleteAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      ForceDelete: forceDelete,
    });

    await client.send(command);
  }

  async startInstanceRefresh(region: string): Promise<string> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    const command = new StartInstanceRefreshCommand({
      AutoScalingGroupName: asgName,
      Strategy: "Rolling",
      Preferences: {
        MinHealthyPercentage: 50, // Keep at least 50% of instances running during refresh
        InstanceWarmup: 300, // Wait 5 minutes for new instances to warm up
      },
    });

    const response = await client.send(command);
    return response.InstanceRefreshId || "";
  }

  async checkInstanceRefreshStatus(region: string, refreshId: string): Promise<string> {
    const client = this.getClient(region);
    const asgName = `night-cloud-miner-asg-${region}`;

    const command = new DescribeInstanceRefreshesCommand({
      AutoScalingGroupName: asgName,
      InstanceRefreshIds: [refreshId],
    });

    const response = await client.send(command);
    if (response.InstanceRefreshes && response.InstanceRefreshes.length > 0) {
      return response.InstanceRefreshes[0].Status || "Unknown";
    }

    return "Unknown";
  }
}
