import { EC2Client, DescribeSpotPriceHistoryCommand, DescribeRegionsCommand } from "@aws-sdk/client-ec2";

async function getAllAvailableRegions(): Promise<string[]> {
  // Use us-east-1 as the base region to query for all regions
  const client = new EC2Client({ region: "us-east-1" });

  try {
    const command = new DescribeRegionsCommand({
      AllRegions: false, // Only get regions that are enabled for your account
    });

    const response = await client.send(command);

    if (!response.Regions) {
      console.warn("⚠️  Could not fetch regions, falling back to default list");
      return getDefaultRegions();
    }

    const regions = response.Regions.filter((region) => region.RegionName && region.OptInStatus !== "not-opted-in")
      .map((region) => region.RegionName!)
      .sort();

    console.log(`✅ Found ${regions.length} available regions\n`);
    return regions;
  } catch (error: any) {
    console.warn(`⚠️  Error fetching regions: ${error.message}`);
    console.warn("Falling back to default region list\n");
    return getDefaultRegions();
  }
}

function getDefaultRegions(): string[] {
  return [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "ca-central-1",
    "ca-west-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "ap-south-1",
    "ap-south-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-east-1",
    "sa-east-1",
    "me-south-1",
    "me-central-1",
    "af-south-1",
    "il-central-1",
  ];
}

interface SpotPrice {
  region: string;
  availabilityZone: string;
  price: number;
  timestamp: Date;
}

interface RegionQueryResult {
  region: string;
  prices: SpotPrice[];
  error?: string;
}

async function getSpotPriceForRegion(region: string, instanceType: string): Promise<RegionQueryResult> {
  const client = new EC2Client({ region });

  try {
    const command = new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [instanceType],
      ProductDescriptions: ["Linux/UNIX"],
      StartTime: new Date(Date.now() - 3600000), // Last hour
      MaxResults: 100,
    });

    const response = await client.send(command);

    if (!response.SpotPriceHistory || response.SpotPriceHistory.length === 0) {
      return { region, prices: [] };
    }

    // Get the latest price for each AZ
    const azPrices = new Map<string, SpotPrice>();

    for (const item of response.SpotPriceHistory) {
      const az = item.AvailabilityZone!;
      const price = parseFloat(item.SpotPrice!);
      const timestamp = item.Timestamp!;

      if (!azPrices.has(az) || azPrices.get(az)!.timestamp < timestamp) {
        azPrices.set(az, {
          region,
          availabilityZone: az,
          price,
          timestamp,
        });
      }
    }

    return { region, prices: Array.from(azPrices.values()) };
  } catch (error: any) {
    // Region might not support this instance type or we don't have access
    return { region, prices: [], error: error.message };
  }
}

async function findCheapestSpotPrice(instanceType: string) {
  console.log(`🔍 Querying spot prices for ${instanceType} across all AWS regions...\n`);

  // Get all available regions for your account
  const regions = await getAllAvailableRegions();

  const allPrices: SpotPrice[] = [];

  // Query all regions in parallel
  const promises = regions.map((region) => getSpotPriceForRegion(region, instanceType));
  const results = await Promise.all(promises);

  // Collect results and errors
  const successfulRegions: string[] = [];
  const failedRegions: Array<{ region: string; error: string }> = [];
  const emptyRegions: string[] = [];

  for (const result of results) {
    if (result.error) {
      failedRegions.push({ region: result.region, error: result.error });
    } else if (result.prices.length === 0) {
      emptyRegions.push(result.region);
    } else {
      successfulRegions.push(result.region);
      allPrices.push(...result.prices);
    }
  }

  // Show summary
  console.log(`📊 Query Summary:`);
  console.log(`   ✅ ${successfulRegions.length} regions with pricing data`);
  console.log(`   ⚠️  ${emptyRegions.length} regions with no spot prices for this instance type`);
  console.log(`   ❌ ${failedRegions.length} regions failed to query\n`);

  if (failedRegions.length > 0) {
    console.log(`Failed regions:`);
    failedRegions.forEach(({ region, error }) => {
      console.log(`   - ${region}: ${error}`);
    });
    console.log();
  }

  if (allPrices.length === 0) {
    console.log("❌ No spot prices found for this instance type in any region");
    return;
  }

  // Sort by price
  allPrices.sort((a, b) => a.price - b.price);

  console.log("📊 ALL AVAILABILITY ZONE PRICES (sorted by price):\n");
  console.log("Rank | Region          | AZ              | Price/hour | Monthly Est | Timestamp");
  console.log("-----|-----------------|-----------------|------------|-------------|-------------------------");

  allPrices.forEach((price, index) => {
    const rank = (index + 1).toString().padStart(4);
    const region = price.region.padEnd(15);
    const az = price.availabilityZone.padEnd(15);
    const priceStr = `$${price.price.toFixed(4)}`.padEnd(10);
    const monthlyStr = `$${(price.price * 730).toFixed(2)}`.padEnd(11);
    const timestamp = price.timestamp.toISOString();
    console.log(`${rank} | ${region} | ${az} | ${priceStr} | ${monthlyStr} | ${timestamp}`);
  });

  // Group by region to show price variance
  const regionGroups = new Map<string, SpotPrice[]>();
  for (const price of allPrices) {
    if (!regionGroups.has(price.region)) {
      regionGroups.set(price.region, []);
    }
    regionGroups.get(price.region)!.push(price);
  }

  console.log("\n\n📈 PRICE VARIANCE BY REGION:\n");
  console.log("Region          | AZs | Min Price  | Max Price  | Variance | Avg Price");
  console.log("----------------|-----|------------|------------|----------|----------");

  const regionStats = Array.from(regionGroups.entries())
    .map(([region, prices]) => {
      const min = Math.min(...prices.map((p) => p.price));
      const max = Math.max(...prices.map((p) => p.price));
      const avg = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
      const variance = max - min;
      const variancePct = min > 0 ? (variance / min) * 100 : 0;
      return { region, prices, min, max, avg, variance, variancePct };
    })
    .sort((a, b) => b.variancePct - a.variancePct);

  regionStats.forEach((stat) => {
    const region = stat.region.padEnd(15);
    const azCount = stat.prices.length.toString().padStart(3);
    const minStr = `$${stat.min.toFixed(4)}`.padEnd(10);
    const maxStr = `$${stat.max.toFixed(4)}`.padEnd(10);
    const varianceStr = `${stat.variancePct.toFixed(1)}%`.padStart(8);
    const avgStr = `$${stat.avg.toFixed(4)}`;
    console.log(`${region} | ${azCount} | ${minStr} | ${maxStr} | ${varianceStr} | ${avgStr}`);
  });

  console.log("\n\n🏆 CHEAPEST AVAILABILITY ZONE:");
  const cheapest = allPrices[0];
  console.log(`   Region: ${cheapest.region}`);
  console.log(`   AZ: ${cheapest.availabilityZone}`);
  console.log(`   Price: $${cheapest.price.toFixed(4)}/hour`);
  console.log(`   Monthly estimate (730 hours): $${(cheapest.price * 730).toFixed(2)}`);

  console.log("\n💰 TOP 10 CHEAPEST AVAILABILITY ZONES:");
  allPrices.slice(0, 10).forEach((price, index) => {
    console.log(
      `   ${index + 1}. ${price.availabilityZone.padEnd(17)} (${price.region.padEnd(15)}): $${price.price.toFixed(
        4,
      )}/hour ($${(price.price * 730).toFixed(2)}/month)`,
    );
  });

  console.log("\n⚠️  REGIONS WITH HIGHEST PRICE VARIANCE:");
  regionStats.slice(0, 5).forEach((stat, index) => {
    const minAz = stat.prices.find((p) => p.price === stat.min)!.availabilityZone;
    const maxAz = stat.prices.find((p) => p.price === stat.max)!.availabilityZone;
    console.log(`   ${index + 1}. ${stat.region}: ${stat.variancePct.toFixed(1)}% variance`);
    console.log(`      Cheapest: ${minAz} at $${stat.min.toFixed(4)}/hour`);
    console.log(`      Most expensive: ${maxAz} at $${stat.max.toFixed(4)}/hour`);
  });
}

// Run the query
const instanceType = process.argv[2] || "c7g.xlarge";
findCheapestSpotPrice(instanceType).catch(console.error);
