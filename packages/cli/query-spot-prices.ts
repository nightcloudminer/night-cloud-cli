import { EC2Client, DescribeSpotPriceHistoryCommand } from "@aws-sdk/client-ec2";

// All AWS regions
const regions = [
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
  "ap-east-1",
  "sa-east-1",
  "me-south-1",
  "af-south-1",
  "il-central-1",
];

interface SpotPrice {
  region: string;
  availabilityZone: string;
  price: number;
  timestamp: Date;
}

async function getSpotPriceForRegion(region: string, instanceType: string): Promise<SpotPrice[]> {
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
      return [];
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
    
    return Array.from(azPrices.values());
  } catch (error: any) {
    // Region might not support this instance type or we don't have access
    console.error(`Error querying ${region}: ${error.message}`);
    return [];
  }
}

async function findCheapestSpotPrice(instanceType: string) {
  console.log(`🔍 Querying spot prices for ${instanceType} across all AWS regions...\n`);
  
  const allPrices: SpotPrice[] = [];
  
  // Query all regions in parallel
  const promises = regions.map(region => getSpotPriceForRegion(region, instanceType));
  const results = await Promise.all(promises);
  
  for (const regionPrices of results) {
    allPrices.push(...regionPrices);
  }
  
  if (allPrices.length === 0) {
    console.log("❌ No spot prices found for this instance type");
    return;
  }
  
  // Sort by price
  allPrices.sort((a, b) => a.price - b.price);
  
  // Group by region to show cheapest AZ per region
  const regionMap = new Map<string, SpotPrice>();
  for (const price of allPrices) {
    if (!regionMap.has(price.region) || regionMap.get(price.region)!.price > price.price) {
      regionMap.set(price.region, price);
    }
  }
  
  const regionPrices = Array.from(regionMap.values()).sort((a, b) => a.price - b.price);
  
  console.log("📊 Spot Prices by Region (cheapest AZ per region):\n");
  console.log("Rank | Region          | AZ              | Price/hour | Timestamp");
  console.log("-----|-----------------|-----------------|------------|-------------------------");
  
  regionPrices.forEach((price, index) => {
    const rank = (index + 1).toString().padStart(4);
    const region = price.region.padEnd(15);
    const az = price.availabilityZone.padEnd(15);
    const priceStr = `$${price.price.toFixed(4)}`.padEnd(10);
    const timestamp = price.timestamp.toISOString();
    console.log(`${rank} | ${region} | ${az} | ${priceStr} | ${timestamp}`);
  });
  
  console.log("\n🏆 CHEAPEST REGION:");
  const cheapest = regionPrices[0];
  console.log(`   Region: ${cheapest.region}`);
  console.log(`   AZ: ${cheapest.availabilityZone}`);
  console.log(`   Price: $${cheapest.price.toFixed(4)}/hour`);
  console.log(`   Monthly estimate (730 hours): $${(cheapest.price * 730).toFixed(2)}`);
  
  console.log("\n💰 TOP 5 CHEAPEST:");
  regionPrices.slice(0, 5).forEach((price, index) => {
    console.log(`   ${index + 1}. ${price.region} (${price.availabilityZone}): $${price.price.toFixed(4)}/hour`);
  });
}

// Run the query
const instanceType = process.argv[2] || "c7g.xlarge";
findCheapestSpotPrice(instanceType).catch(console.error);
