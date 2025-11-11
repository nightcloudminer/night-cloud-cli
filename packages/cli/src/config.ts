import fs from "fs";
import path from "path";
import { Config } from "./types";

const CONFIG_FILE = path.join(process.cwd(), ".night-config.json");

const DEFAULT_CONFIG: Config = {
  awsRegions: ["ap-south-1"],
  securityGroupName: "night-cloud-miner-sg",
  instanceType: "c7g.xlarge",
  spotMaxPrice: "0.10",
  minersPerInstance: 10,
  apiUrl: "https://scavenger.prod.gd.midnighttge.io",
  amiNamePattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*",
  keysDirectory: "./keys",
};

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }

  try {
    const data = fs.readFileSync(CONFIG_FILE, "utf-8");
    const config = JSON.parse(data);
    return { ...DEFAULT_CONFIG, ...config };
  } catch (error) {
    console.warn("Failed to load config, using defaults");
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: Partial<Config>): void {
  const currentConfig = loadConfig();
  const newConfig = { ...currentConfig, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
