import chalk from "chalk";
import { loadConfig } from "../config";
import { S3RegistryManager } from "../utils/s3-registry";
import { EC2Manager } from "../aws/ec2";
import { AutoScalingManager } from "../aws/autoscaling";
import axios from "axios";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Config } from "../types";

// Session tracking
const SESSION_FILE = path.join(os.homedir(), ".night-cloud-session.json");

interface SessionData {
  startTime: string;
  startTotal: number;
}

function loadSession(): SessionData | null {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    // Ignore errors, will create new session
  }
  return null;
}

function saveSession(totalSolutions: number): void {
  const session: SessionData = {
    startTime: new Date().toISOString(),
    startTotal: totalSolutions,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

function resetSession(totalSolutions: number): void {
  saveSession(totalSolutions);
}

// Read version from package.json
function getVersion(): string {
  try {
    // Try multiple possible locations for package.json
    const possiblePaths = [
      path.join(__dirname, "../../package.json"), // From dist/commands/
      path.join(__dirname, "../../../package.json"), // One more level up
      path.join(process.cwd(), "package.json"), // Current working directory
    ];

    for (const pkgPath of possiblePaths) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.version) {
          return pkg.version;
        }
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export interface DashboardOptions {
  readonly refresh: number;
  readonly resetSession?: boolean;
}

interface RecentSolution {
  address: string;
  challengeId: string;
  timestamp: string;
  isDonation?: boolean;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const config = loadConfig();
  const { refresh, resetSession: resetSessionFlag } = options;

  // Handle reset session if requested
  if (resetSessionFlag) {
    console.log(chalk.yellow("\n🔄 Resetting session counters...\n"));

    // Fetch current totals
    const data = await fetchMultiRegionData(config.apiUrl);
    const currentTotal = data.totals.solutions;

    // Reset session to current total
    resetSession(currentTotal);

    console.log(chalk.green("✅ Session reset complete!\n"));
    console.log(chalk.gray(`   Session will now start from ${currentTotal} total solutions.\n`));
    return;
  }

  let iteration = 0;

  // Initialize or load session
  let session = loadSession();

  // Main refresh loop
  const refreshDashboard = async () => {
    try {
      iteration++;
      const data = await fetchMultiRegionData(config.apiUrl);

      // Initialize session on first run if needed
      if (!session) {
        session = {
          startTime: new Date().toISOString(),
          startTotal: data.totals.solutions,
        };
        saveSession(data.totals.solutions);
      }

      // Clear screen and redraw
      console.clear();

      renderMultiRegionDashboard(data, refresh, iteration, config, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(chalk.red(`\n❌ Error fetching dashboard data: ${errorMessage}`));
    }
  };

  // Initial render
  await refreshDashboard();

  // Set up auto-refresh
  const intervalId = setInterval(refreshDashboard, refresh * 1000);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(intervalId);
    console.log(chalk.yellow("\n\n👋 Dashboard closed"));
    process.exit(0);
  });
}
function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

async function fetchChallengeData(apiUrl: string) {
  try {
    const response = await axios.get(`${apiUrl}/challenge`, { timeout: 5000 });
    const data = response.data;

    if (data.code === "active" && data.challenge) {
      const challenge = data.challenge;
      const expiresAt = new Date(challenge.latest_submission);
      const now = new Date();
      const timeLeft = expiresAt.getTime() - now.getTime();

      const hours = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

      const difficultyValue = parseInt(challenge.difficulty, 16);
      const difficultyBits = difficultyValue.toString(2).split("1").length - 1;

      return {
        current: challenge.challenge_id,
        difficulty: challenge.difficulty,
        difficultyBits,
        expiresIn: timeLeft > 0 ? `${hours}h ${minutes}m` : "Expired",
      };
    }

    return {
      current: null,
      difficulty: null,
      difficultyBits: 0,
      expiresIn: null,
    };
  } catch (error) {
    return {
      current: null,
      difficulty: null,
      difficultyBits: 0,
      expiresIn: null,
    };
  }
}

async function fetchInstancesData(region: string, ec2Manager: EC2Manager, asgManager: AutoScalingManager) {
  try {
    const instanceIds = await asgManager.getAutoScalingGroupInstances(region);
    const instances = await ec2Manager.getInstanceDetails(region, instanceIds);
    const running = instances.filter((i: any) => i.state?.Name === "running").length;
    const pending = instances.filter((i: any) => i.state?.Name === "pending").length;

    return {
      total: instances.length,
      running,
      pending,
    };
  } catch (error) {
    return { total: 0, running: 0, pending: 0 };
  }
}

async function fetchSolutionsData(region: string, s3Registry: S3RegistryManager) {
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3Client = new S3Client({ region });
    const bucketName = `night-cloud-miner-registry-${region}`;

    // Read the stats file - single API call, super fast!
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: "solutions-stats.json",
      }),
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      return {
        total: 0,
        donations: 0,
        last24h: 0,
        lastHour: 0,
        hourlyRate: 0,
        recentSolutions: [],
      };
    }

    const stats = JSON.parse(body);
    const recentSolutions: RecentSolution[] = stats.recentSolutions || [];

    // Calculate hourly rate based on recent solutions
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentSolutionsInLastHour = recentSolutions.filter((s) => new Date(s.timestamp).getTime() > oneHourAgo);

    let hourlyRate = 0;
    if (recentSolutionsInLastHour.length >= 2) {
      // Calculate rate based on time span of recent solutions
      const timestamps = recentSolutionsInLastHour.map((s) => new Date(s.timestamp).getTime());
      const oldestTimestamp = Math.min(...timestamps);
      const newestTimestamp = Math.max(...timestamps);
      const timeSpanMs = newestTimestamp - oldestTimestamp;

      if (timeSpanMs > 0) {
        // Project to hourly rate: (solutions / timeSpanMs) * 1 hour in ms
        hourlyRate = (recentSolutionsInLastHour.length / timeSpanMs) * (60 * 60 * 1000);
      }
    }

    return {
      total: stats.totalSolutions || 0,
      donations: stats.donationSolutions || 0,
      errors: stats.totalErrors || 0,
      last24h: stats.totalSolutions || 0, // Session count (total solutions)
      lastHour: recentSolutionsInLastHour.length,
      hourlyRate,
      recentSolutions: recentSolutions.slice(0, 10),
      recentErrors: stats.recentErrors || [],
    };
  } catch (error: unknown) {
    // If stats file doesn't exist yet, return zeros
    if (error && typeof error === "object" && "name" in error && error.name === "NoSuchKey") {
      return {
        total: 0,
        donations: 0,
        errors: 0,
        last24h: 0,
        lastHour: 0,
        hourlyRate: 0,
        recentSolutions: [],
        recentErrors: [],
      };
    }
    return {
      total: 0,
      donations: 0,
      errors: 0,
      last24h: 0,
      lastHour: 0,
      hourlyRate: 0,
      recentSolutions: [],
      recentErrors: [],
    };
  }
}

async function fetchWalletsData(region: string) {
  try {
    // Read registry from S3 (contains both addresses and assignments)
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3Client = new S3Client({ region });
    const bucketName = `night-cloud-miner-registry-${region}`;

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: "registry.json",
      }),
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      return { total: 0, active: 0 };
    }

    const registry = JSON.parse(body);

    // Total addresses from registry
    const totalAddresses = (registry.addresses || []).length;

    // Count addresses from all assignments (actively mining)
    const activeCount = Object.values(registry.assignments || {}).reduce((sum: number, assignment: any) => {
      return sum + (assignment.addresses?.length || 0);
    }, 0);

    return {
      total: totalAddresses,
      active: activeCount,
    };
  } catch (error) {
    return { total: 0, active: 0 };
  }
}

async function fetchRewardsData(apiUrl: string, solutionsPerHour: number) {
  try {
    // Fetch work-to-star rate from API
    const response = await axios.get(`${apiUrl}/work_to_star_rate`);

    // The API returns an array of daily star allotments
    // We want the most recent (last) value
    const workToStarRateArray = response.data;
    const workToStarRate =
      Array.isArray(workToStarRateArray) && workToStarRateArray.length > 0
        ? workToStarRateArray[workToStarRateArray.length - 1]
        : null;

    return calculateRewards(workToStarRate, solutionsPerHour);
  } catch (error) {
    return {
      workToStarRate: null,
      estimatedStarsPerHour: 0,
      estimatedNightPerHour: 0,
      estimatedNightPer24h: 0,
    };
  }
}

function calculateRewards(starsPerSolution: number | null, solutionsPerHour: number) {
  if (!starsPerSolution || solutionsPerHour === 0) {
    return {
      workToStarRate: starsPerSolution,
      estimatedStarsPerHour: 0,
      estimatedNightPerHour: 0,
      estimatedNightPer24h: 0,
    };
  }

  // starsPerSolution = STAR units per solution (from API)
  // 1 million STAR = 1 NIGHT token
  // So: STAR per hour = solutions per hour * starsPerSolution
  const starsPerHour = solutionsPerHour * starsPerSolution;

  // Convert STAR to NIGHT (1 NIGHT = 1,000,000 STAR)
  const nightPerHour = starsPerHour / 1000000;
  const nightPer24h = nightPerHour * 24;

  return {
    workToStarRate: starsPerSolution,
    estimatedStarsPerHour: starsPerHour,
    estimatedNightPerHour: nightPerHour,
    estimatedNightPer24h: nightPer24h,
  };
}

// Multi-region dashboard types
interface RegionData {
  region: string;
  instances: {
    total: number;
    running: number;
    pending: number;
  };
  solutions: {
    total: number;
    donations: number;
    errors: number;
    last24h: number;
    lastHour: number;
    hourlyRate: number;
    recentSolutions: RecentSolution[];
    recentErrors: Array<{
      address: string;
      challengeId: string;
      timestamp: string;
      error: string;
      isDonation?: boolean;
    }>;
  };
  wallets: {
    total: number;
    active: number;
  };
  error?: string;
}

interface MultiRegionData {
  regions: RegionData[];
  challenges: {
    current: string | null;
    difficulty: string | null;
    difficultyBits: number;
    expiresIn: string | null;
  };
  totals: {
    instances: number;
    running: number;
    solutions: number;
    donations: number;
    errors: number;
    solutionsLast24h: number;
    solutionsLastHour: number;
    hourlyRate: number;
    wallets: number;
    activeMiners: number;
  };
  rewards: {
    workToStarRate: number | null;
    estimatedStarsPerHour: number;
    estimatedNightPerHour: number;
    estimatedNightPer24h: number;
  };
  recentSolutions: Array<RecentSolution & { region: string }>;
  recentErrors: Array<{
    address: string;
    challengeId: string;
    timestamp: string;
    error: string;
    isDonation?: boolean;
    region: string;
  }>;
}

// List of all supported regions
const ALL_REGIONS = [
  "ap-south-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
];

async function fetchMultiRegionData(apiUrl: string): Promise<MultiRegionData> {
  // Fetch challenge data once (same for all regions)
  const challengeData = await fetchChallengeData(apiUrl);

  // Fetch data from all regions in parallel
  const regionDataPromises = ALL_REGIONS.map(async (region): Promise<RegionData> => {
    try {
      const s3Registry = new S3RegistryManager(region);
      const ec2Manager = new EC2Manager(region);
      const asgManager = new AutoScalingManager();

      const [instancesData, solutionsData, walletsData] = await Promise.all([
        fetchInstancesData(region, ec2Manager, asgManager),
        fetchSolutionsData(region, s3Registry),
        fetchWalletsData(region),
      ]);

      return {
        region,
        instances: instancesData,
        solutions: {
          total: solutionsData.total,
          donations: solutionsData.donations,
          errors: solutionsData.errors,
          last24h: solutionsData.last24h,
          lastHour: solutionsData.lastHour,
          hourlyRate: solutionsData.hourlyRate,
          recentSolutions: solutionsData.recentSolutions,
          recentErrors: solutionsData.recentErrors,
        },
        wallets: walletsData,
      };
    } catch (error: unknown) {
      // Return empty data with error for regions that fail
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        region,
        instances: { total: 0, running: 0, pending: 0 },
        solutions: {
          total: 0,
          donations: 0,
          errors: 0,
          last24h: 0,
          lastHour: 0,
          hourlyRate: 0,
          recentSolutions: [],
          recentErrors: [],
        },
        wallets: { total: 0, active: 0 },
        error: errorMessage,
      };
    }
  });

  const regions = await Promise.all(regionDataPromises);

  // Calculate totals across all regions
  const totals = regions.reduce(
    (acc, region) => ({
      instances: acc.instances + region.instances.total,
      running: acc.running + region.instances.running,
      solutions: acc.solutions + region.solutions.total,
      donations: acc.donations + region.solutions.donations,
      errors: acc.errors + region.solutions.errors,
      solutionsLast24h: acc.solutionsLast24h + region.solutions.last24h,
      solutionsLastHour: acc.solutionsLastHour + region.solutions.lastHour,
      hourlyRate: acc.hourlyRate + region.solutions.hourlyRate,
      wallets: acc.wallets + region.wallets.total,
      activeMiners: acc.activeMiners + region.wallets.active,
    }),
    {
      instances: 0,
      running: 0,
      solutions: 0,
      donations: 0,
      errors: 0,
      solutionsLast24h: 0,
      solutionsLastHour: 0,
      hourlyRate: 0,
      wallets: 0,
      activeMiners: 0,
    },
  );

  // Fetch rewards data and calculate based on hourly rate
  const rewardsData = await fetchRewardsData(apiUrl, totals.hourlyRate);

  // Collect recent solutions from all regions and merge them
  const allRecentSolutions: Array<RecentSolution & { region: string }> = [];
  regions.forEach((region) => {
    region.solutions.recentSolutions.forEach((solution) => {
      allRecentSolutions.push({
        ...solution,
        region: region.region,
      });
    });
  });

  // Sort by timestamp (newest first) and take top 10
  const sortedRecentSolutions = allRecentSolutions
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

  // Collect recent errors from all regions and merge them
  const allRecentErrors: Array<{
    address: string;
    challengeId: string;
    timestamp: string;
    error: string;
    isDonation?: boolean;
    region: string;
  }> = [];
  regions.forEach((region) => {
    region.solutions.recentErrors.forEach((error) => {
      allRecentErrors.push({
        ...error,
        region: region.region,
      });
    });
  });

  // Sort by timestamp (newest first) and take top 5
  const sortedRecentErrors = allRecentErrors
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5);

  return {
    regions: regions.filter((r) => r.instances.total > 0 || r.wallets.total > 0), // Only show regions with activity
    challenges: challengeData,
    totals,
    rewards: rewardsData,
    recentSolutions: sortedRecentSolutions,
    recentErrors: sortedRecentErrors,
  };
}

function renderMultiRegionDashboard(
  data: MultiRegionData,
  refresh: number,
  iteration: number,
  config: Config,
  session: SessionData,
) {
  const version = getVersion();
  console.log(chalk.blue.bold(`⚡ Night Cloud Miner v${version} - Multi-Region Dashboard\n`));
  console.log(chalk.gray(`All Regions | Refresh: ${refresh}s | Updates: ${iteration} | Press Ctrl+C to exit\n`));

  // Global Totals Section
  console.log(chalk.cyan.bold("📊 GLOBAL TOTALS"));
  console.log(chalk.gray("─".repeat(60)));
  console.log(
    `  Instances:   ${chalk.white.bold(data.totals.instances)} (${chalk.green.bold(data.totals.running)} running)`,
  );
  console.log(
    `  Wallets:     ${chalk.white.bold(data.totals.wallets)} (${chalk.green.bold(data.totals.activeMiners)} active)`,
  );
  console.log(`  Solutions:   ${chalk.white.bold(data.totals.solutions)} total`);

  const donationRate = ((data.totals.donations / data.totals.solutions) * 100).toFixed(1);
  console.log(`  Donations:   ${chalk.magenta.bold(data.totals.donations)} ${chalk.gray(`(${donationRate}%)`)}`);

  const errorRate = ((data.totals.errors / (data.totals.solutions + data.totals.errors)) * 100).toFixed(1);
  console.log(`  Errors:      ${chalk.red.bold(data.totals.errors)} ${chalk.gray(`(${errorRate}% failure rate)`)}`);

  // Calculate estimated cost
  const spotPrice = parseFloat(config.spotMaxPrice);
  const ipv4CostPerHour = 0.005; // AWS IPv4 address cost per hour
  const instanceCostPerHour = spotPrice * data.totals.running;
  const ipv4TotalCostPerHour = ipv4CostPerHour * data.totals.running;
  const estimatedCostPerHour = instanceCostPerHour + ipv4TotalCostPerHour;
  const estimatedCostPerDay = estimatedCostPerHour * 24;
  console.log(
    `  Est. Cost:   ${chalk.yellow.bold(`$${estimatedCostPerHour.toFixed(4)}/hr`)} ${chalk.gray(
      `($${estimatedCostPerDay.toFixed(2)}/day)`,
    )}`,
  );

  // Calculate cost per NIGHT token and NIGHT per solution if we have reward estimates
  if (data.rewards.estimatedNightPerHour > 0) {
    const costPerNight = estimatedCostPerHour / data.rewards.estimatedNightPerHour;
    console.log(`  Cost/NIGHT:  ${chalk.yellow.bold(`$${costPerNight.toFixed(4)}`)} per token`);

    // Calculate NIGHT per solution
    const nightPerSolution =
      data.totals.hourlyRate > 0 ? data.rewards.estimatedNightPerHour / data.totals.hourlyRate : 0;

    if (nightPerSolution > 0) {
      console.log(`  NIGHT/Solution:   ${chalk.green.bold(`~${nightPerSolution.toFixed(4)} NIGHT`)} per solution`);
    }
  }

  console.log();

  // Session Section
  const sessionCount = Math.max(0, data.totals.solutions - session.startTotal);
  const sessionStartTime = new Date(session.startTime);
  const sessionDuration = Date.now() - sessionStartTime.getTime();
  const sessionHours = sessionDuration / (1000 * 60 * 60);

  console.log(chalk.cyan.bold("⏱️  CURRENT SESSION"));
  console.log(chalk.gray("─".repeat(60)));
  console.log(`  Started:     ${chalk.white.bold(sessionStartTime.toLocaleString())}`);
  console.log(`  Solutions:   ${chalk.green.bold(sessionCount)} solutions`);

  if (sessionHours > 0 && sessionCount > 0) {
    const sessionRate = sessionCount / sessionHours;
    console.log(`  Avg Rate:    ${chalk.green.bold(`~${sessionRate.toFixed(2)} solutions/hour`)}`);
  }

  console.log(`  Last hour:   ${chalk.green.bold(data.totals.solutionsLastHour)} solutions`);

  if (data.totals.hourlyRate > 0) {
    console.log(`  Live Rate:   ${chalk.green.bold(`~${data.totals.hourlyRate.toFixed(2)} solutions/hour`)}`);
  }

  // Estimated rewards subsection
  if (data.rewards.estimatedNightPerHour > 0) {
    console.log(chalk.gray(`  ${"─".repeat(58)}`));
    console.log(chalk.gray(`  Estimated Rewards:`));
    console.log(`    Per Hour:  ${chalk.green.bold(`~${data.rewards.estimatedNightPerHour.toFixed(2)} NIGHT`)}`);
    console.log(`    Per 24h:   ${chalk.green.bold(`~${data.rewards.estimatedNightPer24h.toFixed(2)} NIGHT`)}`);
  }

  console.log();

  // Challenge Section
  console.log(chalk.cyan.bold("🎯 CURRENT CHALLENGE"));
  console.log(chalk.gray("─".repeat(60)));
  if (data.challenges.current) {
    console.log(`  ID:         ${chalk.white.bold(data.challenges.current)}`);
    console.log(
      `  Difficulty: ${chalk.white.bold(data.challenges.difficulty)} ${chalk.gray(
        `(${data.challenges.difficultyBits} bits)`,
      )}`,
    );
    console.log(`  Expires in: ${chalk.yellow.bold(data.challenges.expiresIn)}`);
  } else {
    console.log(chalk.gray("  No active challenge"));
  }
  console.log();

  // Per-Region Breakdown
  if (data.regions.length > 0) {
    console.log(chalk.cyan.bold("🗺️  REGIONS"));
    console.log(chalk.gray("─".repeat(60)));

    // Sort regions by number of running instances (most active first)
    const sortedRegions = [...data.regions].sort((a, b) => b.instances.running - a.instances.running);

    sortedRegions.forEach((region) => {
      const regionName = chalk.white.bold(region.region.padEnd(15));
      const instances = `${region.instances.running}/${region.instances.total}`;
      const wallets = `${region.wallets.active}/${region.wallets.total}`;

      if (region.error) {
        console.log(`  ${regionName} ${chalk.red("(error)")}`);
      } else {
        console.log(
          `  ${regionName} Inst: ${chalk.cyan(instances.padEnd(8))} Wallets: ${chalk.cyan(wallets.padEnd(8))}`,
        );
      }
    });
    console.log();
  } else {
    console.log(chalk.yellow("No active regions found. Deploy miners to get started!\n"));
  }

  // Recent Solutions Stream
  if (data.recentSolutions.length > 0) {
    console.log(chalk.cyan.bold("🔥 RECENT SOLUTIONS"));
    console.log(chalk.gray("─".repeat(60)));

    data.recentSolutions.forEach((solution, i) => {
      const timeAgo = getTimeAgo(solution.timestamp);
      const addressShort = solution.address.substring(0, 20);
      const regionBadge = chalk.blue(`[${solution.region}]`);
      const donationBadge = solution.isDonation ? chalk.magenta(" 💝") : "";
      console.log(
        `  ${i + 1}. ${regionBadge} ${chalk.white(addressShort)}...${donationBadge} ${chalk.gray("→")} ${chalk.yellow(
          solution.challengeId,
        )} ${chalk.gray(`(${timeAgo})`)}`,
      );
    });
    console.log();
  }

  // Recent Errors Stream
  if (data.recentErrors.length > 0) {
    console.log(chalk.red.bold("❌ RECENT ERRORS"));
    console.log(chalk.gray("─".repeat(60)));

    data.recentErrors.forEach((error, i) => {
      const timeAgo = getTimeAgo(error.timestamp);
      const addressShort = error.address.substring(0, 20);
      const regionBadge = chalk.blue(`[${error.region}]`);
      const donationBadge = error.isDonation ? chalk.magenta(" 💝") : "";
      const errorShort = error.error.length > 40 ? error.error.substring(0, 40) + "..." : error.error;
      console.log(
        `  ${i + 1}. ${regionBadge} ${chalk.white(addressShort)}...${donationBadge} ${chalk.gray("→")} ${chalk.yellow(
          error.challengeId,
        )}`,
      );
      console.log(`     ${chalk.red(errorShort)} ${chalk.gray(`(${timeAgo})`)}`);
    });
    console.log();
  }

  // Footer
  console.log(chalk.gray("─".repeat(60)));
  console.log(chalk.gray(`Last updated: ${new Date().toLocaleTimeString()}`));
  console.log(chalk.gray(`Monitoring ${ALL_REGIONS.length} regions`));
}
