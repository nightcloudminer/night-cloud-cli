import { InstanceState } from "@aws-sdk/client-ec2";

export interface Config {
  readonly awsRegions: string[];
  readonly securityGroupName: string;
  readonly instanceType: string;
  readonly spotMaxPrice: string;
  readonly addressesPerInstance: number;
  readonly apiUrl: string;
  readonly amiNamePattern: string;
  readonly keysDirectory: string;
}

export interface Instance {
  readonly instanceId: string | undefined;
  readonly publicIp: string;
  readonly state: InstanceState | undefined;
  readonly region: string;
  readonly launchTime: Date | undefined;
  readonly instanceType: string | undefined;
  readonly availabilityZone?: string;
}

export interface MinerRange {
  readonly start: number;
  readonly end: number;
  readonly count: number;
}

export type MinerStatus = "mining" | "idle" | "error";

export interface RegistryEntry {
  readonly ip: string;
  readonly range: MinerRange;
  readonly lastSeen: Date;
  readonly status: MinerStatus;
}

export interface RegistryInstanceData {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly lastSeen: string;
}

export interface Registry {
  readonly instances: Record<string, RegistryInstanceData>;
  readonly version: string;
}

export interface DeploymentOptions {
  readonly region: string;
  readonly instances?: number;
  readonly addressesPerInstance?: number;
  readonly keyName?: string;
  readonly instance?: string;
  readonly force?: boolean;
  readonly refresh?: boolean;
  readonly allZones?: boolean;
}

export interface RegionAddOptions {
  readonly instances: number;
}

export interface MonitorOptions {
  readonly region?: string;
  readonly refresh: number;
}

export interface StatusOptions {
  readonly region?: string;
  readonly verbose: boolean;
}

export interface ScaleOptions {
  readonly region: string;
  readonly instances: number;
}

export interface StopOptions {
  readonly region?: string;
  readonly terminate: boolean;
}

export interface LogsOptions {
  readonly region: string;
  readonly instance?: string;
  readonly follow: boolean;
  readonly lines: number;
}

export interface WalletOptions {
  readonly list?: boolean;
  readonly generate?: number;
  readonly register?: boolean;
  readonly start?: number;
}

// Re-export Challenge from schemas for backward compatibility
export type { Challenge, NoChallenge, SolutionReceipt } from "./shared";

export interface MiningJob {
  readonly address: string;
  readonly minerNumber: number;
  readonly challenge: import("./shared").Challenge;
}

export interface Solution {
  readonly minerId: number;
  readonly address: string;
  readonly nonce: string;
  readonly challengeId: string;
  readonly timestamp: Date;
}
