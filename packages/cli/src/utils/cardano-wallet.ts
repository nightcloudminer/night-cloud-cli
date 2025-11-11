import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ScavengerMineAPI } from "../shared";
const CardanoWasm = require("@emurgo/cardano-serialization-lib-nodejs");

export interface CardanoWallet {
  minerNumber: number;
  address: string;
  paymentVkey: string;
  publicKey: string;
}

export interface WalletGenerationOptions {
  startNumber: number;
  count: number;
  keysDir?: string;
  network?: "mainnet" | "testnet";
}

export interface RegistrationResult {
  address: string;
  success: boolean;
  receipt?: any;
  error?: string;
}

/**
 * Cardano Wallet Manager using cardano-signer
 * Handles wallet generation, signing, and registration
 * Supports region-based folder organization: keys/{region}/miner{N}.payment.{skey,vkey,addr}
 */
export class CardanoWalletManager {
  private signerPath: string;
  private keysDir: string;
  private region?: string;
  private api: ScavengerMineAPI;

  constructor(apiUrl: string, keysDir: string = "./keys", region?: string) {
    // When bundled, __dirname points to the dist directory where cli.js is
    // The cardano-signer.js is in dist/lib/cardano-signer.js
    this.signerPath = path.join(__dirname, "lib", "cardano-signer.js");
    this.keysDir = keysDir;
    this.region = region;
    this.api = new ScavengerMineAPI(apiUrl);

    // Ensure keys directory exists
    const targetDir = this.getTargetDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  /**
   * Get the target directory for keys (with or without region)
   */
  private getTargetDir(): string {
    return this.region ? path.join(this.keysDir, this.region) : this.keysDir;
  }

  /**
   * Generate a new Cardano wallet using cardano-signer
   */
  async generateWallet(minerNumber: number): Promise<CardanoWallet> {
    const targetDir = this.getTargetDir();
    const minerDir = path.join(targetDir, `miner${minerNumber}`);

    // Create miner subdirectory
    if (!fs.existsSync(minerDir)) {
      fs.mkdirSync(minerDir, { recursive: true });
    }

    const skeyPath = path.join(minerDir, "payment.skey");
    const vkeyPath = path.join(minerDir, "payment.vkey");
    const addrPath = path.join(minerDir, "payment.addr");

    // Generate payment key pair
    await this.runCardanoSigner("keygen", ["--path", "payment", "--out-skey", skeyPath, "--out-vkey", vkeyPath]);

    // Read the vkey to get the public key
    const vkeyData = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    const vkeyCborHex = vkeyData.cborHex;

    // Extract the actual public key bytes (remove CBOR prefix "5820" which is 2 bytes)
    const publicKeyHex = vkeyCborHex.substring(4);

    // Derive address from public key using Cardano serialization library
    const publicKey = CardanoWasm.PublicKey.from_bytes(Buffer.from(publicKeyHex, "hex"));

    // Create an enterprise address (payment credential only, no stake credential)
    // This is simpler and matches what most wallets generate
    const enterpriseAddr = CardanoWasm.EnterpriseAddress.new(
      CardanoWasm.NetworkInfo.mainnet().network_id(),
      CardanoWasm.Credential.from_keyhash(publicKey.hash()),
    );
    const address = enterpriseAddr.to_address().to_bech32();

    // Save address to file
    fs.writeFileSync(addrPath, address);

    return {
      minerNumber,
      address,
      paymentVkey: vkeyCborHex,
      publicKey: publicKeyHex,
    };
  }

  /**
   * Generate multiple wallets in batch
   */
  async generateWallets(options: WalletGenerationOptions): Promise<CardanoWallet[]> {
    const { startNumber, count } = options;
    const wallets: CardanoWallet[] = [];

    console.log(`Generating ${count} wallets starting from miner${startNumber}...`);

    for (let i = 0; i < count; i++) {
      const minerNumber = startNumber + i;
      try {
        const wallet = await this.generateWallet(minerNumber);
        wallets.push(wallet);
        console.log(`✓ Generated miner${minerNumber}: ${wallet.address}`);
      } catch (error: any) {
        console.error(`✗ Failed to generate miner${minerNumber}: ${error.message}`);
      }
    }

    return wallets;
  }

  /**
   * Sign a message using CIP-30 standard
   * Returns COSE_Sign1 signature and 64-char hex public key as required by the API
   */
  async signMessage(
    message: string,
    skeyPath: string,
    address: string,
  ): Promise<{ signature: string; publicKey: string }> {
    const tempOutFile = path.join(this.keysDir, `.temp-signature-${Date.now()}.json`);

    try {
      await this.runCardanoSigner("sign", [
        "--cip30",
        "--data",
        message,
        "--secret-key",
        skeyPath,
        "--address",
        address,
        "--json",
        "--out-file",
        tempOutFile,
      ]);

      const result = JSON.parse(fs.readFileSync(tempOutFile, "utf8"));
      fs.unlinkSync(tempOutFile); // Clean up temp file

      // CIP-30 returns COSE_Sign1_hex and COSE_Key_hex
      // We need to extract the raw 64-char public key from COSE_Key_hex
      // COSE_Key format: a4010103272006215820{publicKey}
      // The public key is after the last "5820" prefix (which is CBOR for 32-byte bytestring)
      const coseKey = result.COSE_Key_hex;
      const pubKeyMatch = coseKey.match(/5820([0-9a-f]{64})/);
      const publicKey = pubKeyMatch ? pubKeyMatch[1] : "";

      return {
        signature: result.COSE_Sign1_hex,
        publicKey: publicKey,
      };
    } catch (error) {
      if (fs.existsSync(tempOutFile)) {
        fs.unlinkSync(tempOutFile);
      }
      throw error;
    }
  }

  /**
   * Register a wallet address with the Scavenger Mine API
   */
  async registerWallet(wallet: CardanoWallet): Promise<RegistrationResult> {
    try {
      // Get Terms and Conditions
      const tandc = await this.api.getTermsAndConditions();

      // Sign the T&C message
      const targetDir = this.getTargetDir();
      const minerDir = path.join(targetDir, `miner${wallet.minerNumber}`);
      const skeyPath = path.join(minerDir, "payment.skey");
      const { signature, publicKey } = await this.signMessage(tandc.message, skeyPath, wallet.address);

      // Register with API
      const receipt = await this.api.registerAddress(wallet.address, signature, publicKey);

      // Save registration receipt to file
      const receiptPath = path.join(minerDir, "registration.json");
      fs.writeFileSync(
        receiptPath,
        JSON.stringify(
          {
            address: wallet.address,
            receipt,
            registeredAt: new Date().toISOString(),
            termsVersion: tandc.version,
          },
          null,
          2,
        ),
      );

      return {
        address: wallet.address,
        success: true,
        receipt,
      };
    } catch (error: any) {
      return {
        address: wallet.address,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if a wallet already has a registration receipt
   */
  hasRegistrationReceipt(wallet: CardanoWallet): boolean {
    const targetDir = this.getTargetDir();
    const minerDir = path.join(targetDir, `miner${wallet.minerNumber}`);
    const receiptPath = path.join(minerDir, "registration.json");
    return fs.existsSync(receiptPath);
  }

  /**
   * Register multiple wallets in batch (skips wallets that already have receipts)
   */
  async registerWallets(wallets: CardanoWallet[]): Promise<RegistrationResult[]> {
    // Filter out wallets that already have receipts
    const walletsToRegister = wallets.filter((w) => !this.hasRegistrationReceipt(w));
    const alreadyRegistered = wallets.filter((w) => this.hasRegistrationReceipt(w));

    if (alreadyRegistered.length > 0) {
      console.log(`ℹ️  Skipping ${alreadyRegistered.length} wallet(s) that already have registration receipts`);
    }

    if (walletsToRegister.length === 0) {
      console.log(`✓ All wallets are already registered!`);
      return [];
    }

    console.log(`Registering ${walletsToRegister.length} wallet(s)...`);
    const results: RegistrationResult[] = [];

    for (const wallet of walletsToRegister) {
      try {
        const result = await this.registerWallet(wallet);
        results.push(result);

        if (result.success) {
          console.log(`✓ Registered ${wallet.address}`);
        } else {
          console.error(`✗ Failed to register ${wallet.address}: ${result.error}`);
        }

        // Add small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error: any) {
        console.error(`✗ Error registering ${wallet.address}: ${error.message}`);
        results.push({
          address: wallet.address,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Load existing wallet from files
   */
  loadWallet(minerNumber: number): CardanoWallet | null {
    const targetDir = this.getTargetDir();
    const minerDir = path.join(targetDir, `miner${minerNumber}`);
    const skeyPath = path.join(minerDir, "payment.skey");
    const vkeyPath = path.join(minerDir, "payment.vkey");
    const addrPath = path.join(minerDir, "payment.addr");

    if (!fs.existsSync(skeyPath) || !fs.existsSync(vkeyPath) || !fs.existsSync(addrPath)) {
      return null;
    }

    const vkey = fs.readFileSync(vkeyPath, "utf8").trim();
    const address = fs.readFileSync(addrPath, "utf8").trim();

    const vkeyJson = JSON.parse(vkey);
    const publicKey = vkeyJson.cborHex;

    return {
      minerNumber,
      address,
      paymentVkey: vkey,
      publicKey,
    };
  }

  /**
   * Load all existing wallets from keys directory (or region subdirectory)
   */
  loadAllWallets(): CardanoWallet[] {
    const targetDir = this.getTargetDir();
    if (!fs.existsSync(targetDir)) {
      return [];
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const minerDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("miner"));

    const wallets: CardanoWallet[] = [];
    for (const minerDir of minerDirs) {
      const minerNumber = parseInt(minerDir.name.match(/miner(\d+)/)?.[1] || "0");
      if (minerNumber > 0) {
        const wallet = this.loadWallet(minerNumber);
        if (wallet) {
          wallets.push(wallet);
        }
      }
    }

    return wallets.sort((a, b) => a.minerNumber - b.minerNumber);
  }

  /**
   * Get list of all regions that have wallets
   */
  static getAvailableRegions(keysDir: string = "./keys"): string[] {
    if (!fs.existsSync(keysDir)) {
      return [];
    }

    const entries = fs.readdirSync(keysDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /**
   * Get the next available miner number
   */
  getNextMinerNumber(): number {
    const wallets = this.loadAllWallets();
    if (wallets.length === 0) {
      return 1;
    }
    return Math.max(...wallets.map((w) => w.minerNumber)) + 1;
  }

  /**
   * Run cardano-signer command
   */
  private async runCardanoSigner(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [this.signerPath, command, ...args]);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`cardano-signer exited with code ${code}: ${stderr}`));
          return;
        }
        resolve(stdout);
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to spawn cardano-signer: ${error.message}`));
      });
    });
  }
}
