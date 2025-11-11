import {
  EC2Client,
  DescribeImagesCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
  DescribeAvailabilityZonesCommand,
  DescribeLaunchTemplatesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  GetRoleCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  GetInstanceProfileCommand,
} from "@aws-sdk/client-iam";
import { Config, Instance } from "../types";

export class EC2Manager {
  private clients: Map<string, EC2Client> = new Map();
  private iamClient: IAMClient;

  constructor(region: string = "us-east-1") {
    // IAM is global but needs a region for the client
    this.iamClient = new IAMClient({ region });
  }

  private getClient(region: string): EC2Client {
    if (!this.clients.has(region)) {
      this.clients.set(region, new EC2Client({ region }));
    }
    return this.clients.get(region)!;
  }

  async getLatestUbuntuAMI(region: string, config: Config): Promise<string> {
    const client = this.getClient(region);

    const command = new DescribeImagesCommand({
      Owners: ["099720109477"], // Canonical
      Filters: [
        {
          Name: "name",
          Values: [config.amiNamePattern],
        },
        {
          Name: "state",
          Values: ["available"],
        },
      ],
    });

    const response = await client.send(command);

    if (!response.Images || response.Images.length === 0) {
      throw new Error(`No Ubuntu AMI found in ${region}`);
    }

    // Sort by creation date and get the latest
    const sortedImages = response.Images.sort((a, b) => {
      const dateA = new Date(a.CreationDate || 0);
      const dateB = new Date(b.CreationDate || 0);
      return dateB.getTime() - dateA.getTime();
    });

    return sortedImages[0].ImageId!;
  }

  async ensureInstanceProfile(): Promise<string> {
    const roleName = "NightCloudMinerRole";
    const profileName = "NightCloudMinerProfile";

    // Create IAM role if it doesn't exist
    try {
      await this.iamClient.send(new GetRoleCommand({ RoleName: roleName }));
    } catch (error) {
      // Role doesn't exist, create it
      const assumeRolePolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "ec2.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      };

      await this.iamClient.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicy),
          Description: "Role for Night Cloud Miner instances to access S3 registry",
        }),
      );

      // Attach policy to allow accessing S3 registry and CloudWatch Logs
      const policy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
            Resource: ["arn:aws:s3:::night-cloud-miner-registry-*", "arn:aws:s3:::night-cloud-miner-registry-*/*"],
          },
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
            Resource: "arn:aws:logs:*:*:log-group:/night-cloud-miner/*",
          },
        ],
      };

      await this.iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: "NightCloudMinerAccess",
          PolicyDocument: JSON.stringify(policy),
        }),
      );
    }

    // Create instance profile if it doesn't exist
    try {
      await this.iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
    } catch (error) {
      // Profile doesn't exist, create it
      await this.iamClient.send(
        new CreateInstanceProfileCommand({
          InstanceProfileName: profileName,
        }),
      );

      // Add role to profile
      await this.iamClient.send(
        new AddRoleToInstanceProfileCommand({
          InstanceProfileName: profileName,
          RoleName: roleName,
        }),
      );

      // Wait a bit for IAM to propagate
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    return profileName;
  }

  async ensureSecurityGroup(region: string, config: Config): Promise<string> {
    const client = this.getClient(region);

    // Check if security group exists
    try {
      const describeCommand = new DescribeSecurityGroupsCommand({
        Filters: [
          {
            Name: "group-name",
            Values: [config.securityGroupName],
          },
        ],
      });

      const response = await client.send(describeCommand);

      if (response.SecurityGroups && response.SecurityGroups.length > 0) {
        return response.SecurityGroups[0].GroupId!;
      }
    } catch (error) {
      // Security group doesn't exist, create it
    }

    // Get default VPC
    const vpcCommand = new DescribeVpcsCommand({
      Filters: [
        {
          Name: "is-default",
          Values: ["true"],
        },
      ],
    });

    const vpcResponse = await client.send(vpcCommand);
    const vpcId = vpcResponse.Vpcs?.[0]?.VpcId;

    if (!vpcId) {
      throw new Error("No default VPC found");
    }

    // Create security group (no ingress rules needed - instances only make outbound connections)
    const createCommand = new CreateSecurityGroupCommand({
      GroupName: config.securityGroupName,
      Description: "Security group for Night Cloud Miner instances (outbound only)",
      VpcId: vpcId,
    });

    const createResponse = await client.send(createCommand);
    const groupId = createResponse.GroupId!;

    return groupId;
  }

  async createOrUpdateLaunchTemplate(
    region: string,
    config: Config,
    amiId: string,
    securityGroupId: string,
    instanceProfileName: string,
  ): Promise<void> {
    const client = this.getClient(region);
    const templateName = "night-cloud-miner-template";

    // User data script - fully self-contained miner setup
    const userData = Buffer.from(
      `#!/bin/bash
set -e

# Logging
exec > >(tee /var/log/night-cloud-setup.log)
exec 2>&1

echo "🚀 Starting Night Cloud Miner setup..."

# Get IMDSv2 token
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)

# Get instance metadata using IMDSv2
AZ=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/availability-zone)
REGION=$(echo $AZ | sed 's/[a-z]$//')
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)

# Set hostname
hostnamectl set-hostname night-cloud-$INSTANCE_ID

# Wait for network
sleep 10

# Install dependencies
echo "📦 Installing dependencies..."
apt-get update -qq
apt-get install -y -qq git curl build-essential pkg-config libssl-dev jq unzip

# Install AWS CLI v2 for ARM64
echo "📦 Installing AWS CLI v2..."
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update
rm -rf aws awscliv2.zip

# Install CloudWatch Logs agent
echo "📦 Installing CloudWatch Logs agent..."
wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
dpkg -i -E ./amazon-cloudwatch-agent.deb
rm amazon-cloudwatch-agent.deb

# Install Node.js 20.x
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs

# Download miner code from S3 (region-specific bucket)
echo "📥 Downloading Night Cloud Miner from S3..."
export BUCKET="night-cloud-miner-registry-$REGION"
echo "Bucket: $BUCKET"
su - ubuntu -c "aws s3 cp s3://$BUCKET/miner-code.tar.gz /tmp/miner-code.tar.gz"
tar -xzf /tmp/miner-code.tar.gz -C /home/ubuntu
chown -R ubuntu:ubuntu /home/ubuntu/miner
rm /tmp/miner-code.tar.gz

# Miner code is pre-built and bundled with dependencies
# Just make scripts executable
chmod +x /home/ubuntu/miner/dist/scripts/*.js
chmod +x /home/ubuntu/miner/dist/cli.js

# Build Rust miner (need to compile on Linux for correct architecture)
echo "🦀 Building Rust miner..."
su - ubuntu -c '
cd /home/ubuntu/miner/rust
curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env
cargo build --release --quiet
'

# Create directory for address cache
mkdir -p /var/lib/night-cloud
chown ubuntu:ubuntu /var/lib/night-cloud

# Set REGION environment variable for scripts
echo "REGION=$REGION" >> /etc/environment

# Create systemd timer for heartbeat (every minute)
cat > /etc/systemd/system/night-cloud-heartbeat.service << 'HEARTBEAT_SERVICE'
[Unit]
Description=Night Cloud Miner Heartbeat
After=network.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/miner
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/node /home/ubuntu/miner/dist/scripts/heartbeat.js
HEARTBEAT_SERVICE

cat > /etc/systemd/system/night-cloud-heartbeat.timer << 'HEARTBEAT_TIMER'
[Unit]
Description=Night Cloud Miner Heartbeat Timer
After=network.target

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
HEARTBEAT_TIMER

# Enable heartbeat timer
systemctl daemon-reload
systemctl enable night-cloud-heartbeat.timer
systemctl start night-cloud-heartbeat.timer

# Configure CloudWatch Logs agent
echo "📊 Configuring CloudWatch Logs..."
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << CLOUDWATCH_CONFIG
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/night-cloud-miner.log",
            "log_group_name": "/night-cloud-miner/$REGION",
            "log_stream_name": "{instance_id}/miner",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/syslog",
            "log_group_name": "/night-cloud-miner/$REGION",
            "log_stream_name": "{instance_id}/syslog",
            "timezone": "UTC"
          }
        ]
      }
    }
  }
}
CLOUDWATCH_CONFIG

# Start CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\
  -a fetch-config \\
  -m ec2 \\
  -s \\
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Create startup script with infinite retry logic
cat > /usr/local/bin/night-cloud-start.sh << 'STARTUP_SCRIPT'
#!/bin/bash

echo "🚀 Night Cloud Miner starting..."

# Get region from environment (set earlier in user data)
source /etc/environment

# Infinite retry logic for address assignment
# This handles cases where all addresses are temporarily reserved
# We never give up - just keep retrying until addresses become available
RETRY_COUNT=0
ADDRESSES=""
RETRY_INTERVAL=30

while true; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "📍 Attempting to get addresses (attempt $RETRY_COUNT)..."
  
  # Get addresses (from cache or S3 registry)
  # First run: reserves from S3 and caches locally
  # Subsequent runs: uses cached addresses
  # Only capture stdout (addresses), let stderr go to logs
  ADDRESSES=$(node /home/ubuntu/miner/dist/scripts/assign-addresses.js 2>/dev/stderr)
  EXIT_CODE=$?
  
  if [ $EXIT_CODE -eq 0 ] && [ -n "$ADDRESSES" ]; then
    ADDRESS_COUNT=$(echo $ADDRESSES | tr ',' '\\n' | wc -l)
    echo "✅ Successfully assigned $ADDRESS_COUNT addresses"
    break
  fi
  
  echo "⏳ Address assignment failed (exit code: $EXIT_CODE). Retrying in \${RETRY_INTERVAL}s..."
  echo "   (Waiting for stale assignments to be cleaned up or addresses to become available)"
  sleep $RETRY_INTERVAL
done

# Start the TypeScript mining orchestrator
cd /home/ubuntu/miner
export PATH=/home/ubuntu/miner/rust/target/release:\$PATH
exec node dist/cli.js start \\
  --addresses "\$ADDRESSES" \\
  --rust-binary "/home/ubuntu/miner/rust/target/release/night-cloud" \\
  --poll-interval 60000 \\
  --region "\$REGION"
STARTUP_SCRIPT

chmod +x /usr/local/bin/night-cloud-start.sh

# Create systemd service
cat > /etc/systemd/system/night-cloud.service << 'SERVICE'
[Unit]
Description=Night Cloud Miner
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/miner
Environment="PATH=/home/ubuntu/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/local/bin/night-cloud-start.sh
Restart=always
RestartSec=10
StandardOutput=append:/var/log/night-cloud-miner.log
StandardError=append:/var/log/night-cloud-miner.log

[Install]
WantedBy=multi-user.target
SERVICE

# Enable and start the service
systemctl daemon-reload
systemctl enable night-cloud
systemctl start night-cloud

echo "✅ Night Cloud Miner setup complete!"
echo "📊 Service status:"
systemctl status night-cloud --no-pager || true
`,
    ).toString("base64");

    const launchTemplateData = {
      ImageId: amiId,
      InstanceType: config.instanceType,
      SecurityGroupIds: [securityGroupId],
      IamInstanceProfile: {
        Name: instanceProfileName,
      },
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/sda1",
          Ebs: {
            VolumeSize: 10,
            VolumeType: "gp3",
            DeleteOnTermination: true,
          },
        },
      ],
      UserData: userData,
      InstanceMarketOptions: {
        MarketType: "spot",
        SpotOptions: {
          MaxPrice: config.spotMaxPrice,
          SpotInstanceType: "one-time",
          InstanceInterruptionBehavior: "terminate",
        },
      },
    };

    // Check if template exists
    try {
      const describeCommand = new DescribeLaunchTemplatesCommand({
        LaunchTemplateNames: [templateName],
      });

      await client.send(describeCommand);

      // Template exists, create new version
      const versionCommand = new CreateLaunchTemplateVersionCommand({
        LaunchTemplateName: templateName,
        LaunchTemplateData: launchTemplateData as any,
      });

      await client.send(versionCommand);

      // Set as default version
      const modifyCommand = new ModifyLaunchTemplateCommand({
        LaunchTemplateName: templateName,
        DefaultVersion: "$Latest",
      });

      await client.send(modifyCommand);
    } catch (error) {
      // Template doesn't exist, create it
      const createCommand = new CreateLaunchTemplateCommand({
        LaunchTemplateName: templateName,
        VersionDescription: "Night Cloud Miner launch template",
        LaunchTemplateData: launchTemplateData as any,
      });

      await client.send(createCommand);
    }
  }

  async getAvailabilityZones(region: string): Promise<string[]> {
    const client = this.getClient(region);

    const command = new DescribeAvailabilityZonesCommand({
      Filters: [
        {
          Name: "state",
          Values: ["available"],
        },
      ],
    });

    const response = await client.send(command);
    return response.AvailabilityZones?.map((az) => az.ZoneName!) || [];
  }

  async getInstanceDetails(region: string, instanceIds: string[]): Promise<Instance[]> {
    if (instanceIds.length === 0) {
      return [];
    }

    const client = this.getClient(region);

    const command = new DescribeInstancesCommand({
      InstanceIds: instanceIds,
    });

    const response = await client.send(command);
    const instances: Instance[] = [];

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        instances.push({
          instanceId: instance.InstanceId,
          publicIp: instance.PublicIpAddress || "N/A",
          state: instance.State,
          region,
          launchTime: instance.LaunchTime ?? new Date(),
          instanceType: instance.InstanceType,
        });
      }
    }

    return instances;
  }

  async terminateInstances(region: string, instanceIds: string[]): Promise<void> {
    if (instanceIds.length === 0) {
      return;
    }

    const client = this.getClient(region);

    const command = new TerminateInstancesCommand({
      InstanceIds: instanceIds,
    });

    await client.send(command);
  }
}
