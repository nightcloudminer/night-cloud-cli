import chalk from "chalk";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { LogsOptions } from "../types";
import ora from "ora";
import { AutoScalingManager } from "../aws/autoscaling";
import { EC2Manager } from "../aws/ec2";

export async function logsCommand(options: LogsOptions): Promise<void> {
  console.log(chalk.blue.bold("\n📜 CloudWatch Logs\n"));

  const region = options.region;
  const instanceId = options.instance;
  const follow = options.follow || false;
  const lines = options.lines || 100;

  const logGroupName = `/night-cloud-miner/${region}`;
  const client = new CloudWatchLogsClient({ region });

  console.log(chalk.gray(`Region: ${region}`));
  console.log(chalk.gray(`Log Group: ${logGroupName}`));
  if (instanceId) {
    console.log(chalk.gray(`Instance: ${instanceId}`));
  }
  console.log(chalk.gray(`Lines: ${lines}\n`));

  try {
    if (instanceId) {
      // Show logs for specific instance
      const logStreamName = `${instanceId}/miner`;

      if (follow) {
        console.log(chalk.yellow("Following logs (Ctrl+C to stop)...\n"));
        await followLogs(client, logGroupName, logStreamName);
      } else {
        await fetchLogs(client, logGroupName, logStreamName, lines);
      }
    } else {
      // Show logs for all running instances in the region
      const spinner = ora("Fetching running instances...").start();

      try {
        // Get running instances from ASG
        const asgManager = new AutoScalingManager();
        const instanceIds = await asgManager.getAutoScalingGroupInstances(region);

        if (instanceIds.length === 0) {
          spinner.stop();
          console.log(chalk.yellow("No running instances found"));
          return;
        }

        spinner.text = "Fetching log streams...";

        const streamsResponse = await client.send(
          new DescribeLogStreamsCommand({
            logGroupName,
            orderBy: "LastEventTime",
            descending: true,
            limit: 50,
          }),
        );

        spinner.stop();

        if (!streamsResponse.logStreams || streamsResponse.logStreams.length === 0) {
          console.log(chalk.yellow("No log streams found"));
          return;
        }

        // Filter for miner logs from running instances only
        const runningInstanceSet = new Set(instanceIds);
        const minerStreams = streamsResponse.logStreams.filter((s) => {
          if (!s.logStreamName?.includes("/miner")) return false;
          const streamInstanceId = s.logStreamName.split("/")[0];
          return runningInstanceSet.has(streamInstanceId);
        });

        if (minerStreams.length === 0) {
          console.log(chalk.yellow("No miner logs found for running instances"));
          return;
        }

        console.log(chalk.blue(`Found ${minerStreams.length} running instance(s) with logs:\n`));

        // Show recent logs from all running instances
        for (const stream of minerStreams) {
          const streamName = stream.logStreamName!;
          const instanceId = streamName.split("/")[0];

          console.log(chalk.cyan(`\n━━━ ${instanceId} ━━━\n`));
          await fetchLogs(client, logGroupName, streamName, Math.min(lines, 20));
        }
      } catch (error: any) {
        spinner.fail("Failed to fetch logs");
        if (error.name === "ResourceNotFoundException") {
          console.error(chalk.red(`\nLog group ${logGroupName} not found.`));
          console.log(chalk.yellow("Logs will be available after instances start up."));
        } else {
          throw error;
        }
      }
    }
  } catch (error: any) {
    console.error(chalk.red("Error:"), error.message);
    process.exit(1);
  }
}

async function fetchLogs(
  client: CloudWatchLogsClient,
  logGroupName: string,
  logStreamName: string,
  lines: number,
): Promise<void> {
  try {
    const response = await client.send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        limit: lines,
        startFromHead: false,
      }),
    );

    if (!response.events || response.events.length === 0) {
      console.log(chalk.gray("No log events found"));
      return;
    }

    for (const event of response.events) {
      const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : "";
      const message = event.message || "";
      console.log(chalk.gray(`[${timestamp}]`), message);
    }
  } catch (error: any) {
    if (error.name === "ResourceNotFoundException") {
      console.log(chalk.yellow(`Log stream not found: ${logStreamName}`));
    } else {
      throw error;
    }
  }
}

async function followLogs(
  client: CloudWatchLogsClient,
  logGroupName: string,
  logStreamName: string,
): Promise<void> {
  let nextToken: string | undefined;
  let lastTimestamp = Date.now() - 60000; // Start from 1 minute ago

  const pollInterval = 2000; // Poll every 2 seconds

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    console.log(chalk.gray("\n\nLog stream closed"));
    process.exit(0);
  });

  while (true) {
    try {
      const response = await client.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          startTime: lastTimestamp,
          startFromHead: true,
          nextToken,
        }),
      );

      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : "";
          const message = event.message || "";
          console.log(chalk.gray(`[${timestamp}]`), message);

          if (event.timestamp && event.timestamp > lastTimestamp) {
            lastTimestamp = event.timestamp + 1; // Move forward by 1ms to avoid duplicates
          }
        }
      }

      nextToken = response.nextForwardToken;

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        console.log(chalk.yellow("Waiting for log stream to be created..."));
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } else {
        throw error;
      }
    }
  }
}
