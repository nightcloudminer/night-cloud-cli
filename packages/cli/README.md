# Night Cloud Miner CLI

Open source cloud mining CLI for Midnight's Scavenger Mine. Deploy in one click on AWS with the fastest Rust implementation.

## ⚠️ IMPORTANT DISCLAIMERS

**USE AT YOUR OWN RISK**

- **AWS Costs**: This software deploys cloud infrastructure that will incur AWS charges. You are solely responsible for all costs.
- **No Guarantees**: Mining profitability is not guaranteed and may result in losses.
- **Security**: You are responsible for securing your private keys and credentials.
- **Monitoring**: Always monitor your AWS billing and resource usage.
- **Testing**: Start with small deployments to understand costs before scaling.

The authors provide no warranty and are not liable for any losses, damages, or costs incurred.

## Features

- 🚀 One-click AWS deployment
- ⚡ Fastest Rust-based mining implementation
- 📊 Real-time status monitoring
- 🔄 Auto-scaling support
- 💰 Multi-wallet management
- 📝 CloudWatch logs integration
- 💻 Local mining support for development

## Quick Start

### Using npx (no installation required)

```bash
# 1. Initialize configuration
npx @night-cloud/cli init

# 2. Generate wallets
npx @night-cloud/cli wallet --region ap-south-1 --auto

# 3. Deploy to AWS
# As of latest difficulty, 6 addresses per EC2 instance (c7g.xlarge) is sufficient
npx @night-cloud/cli deploy --region ap-south-1 --instances 100 --addresses-per-instance 6

# 4. Monitor your deployment
npx @night-cloud/cli dashboard
```

### Global Installation

```bash
# Install globally
npm install -g @night-cloud/cli

# Follow the same steps
night-cloud init
night-cloud wallet --region ap-south-1 --auto
night-cloud deploy --region ap-south-1 --instances 100 --addresses-per-instance 6
night-cloud status
```

### Understanding Wallets & Performance

**Why you need wallets first**: Each Cardano wallet address can submit one solution per challenge. More wallets = more potential solutions.

**Wallet-to-instance ratio**: By default, each EC2 instance (c7g.xlarge) is assigned 10 wallet addresses. This is typically more than enough since:
- Each instance can find multiple solutions per challenge
- Solutions are distributed across the 10 addresses automatically
- You can adjust this with `--addresses-per-instance` if needed

**Planning your deployment**:
NOTE: These numbers of frequently changing as the difficulty increases. You may want to lower your addresses per instance configuration over time.
- Target 10 solutions/hour? Generate ~25 wallets
- Target 100 solutions/hour? Generate ~250 wallets
- Target 1000 solutions/hour? Generate ~2500 wallets
- Deploy instances based on compute needs, not wallet count

**Region selection - Cost optimization**:
⚠️ **IMPORTANT**: `ap-south-1` (Mumbai) has the cheapest c7g.xlarge spot instances (~$0.06-0.08/hour vs $0.08-0.12/hour in other regions).

**Recommended strategy**:
1. **Start with ap-south-1** - Deploy as many instances as you need here first
2. **Max out ap-south-1** - Scale to your AWS account limits in this region
3. **Only then expand** - If you need more capacity, deploy to other cheaper regions like `ap-northeast-2`, `ap-northeast-3`, `us-east-2`, etc.

This can save you 30-40% on infrastructure costs compared to deploying across multiple regions from the start.

## Prerequisites

- Node.js 18 or higher
- AWS account with credentials configured
- AWS CLI installed and configured (recommended)

## Commands

### `init`
Initialize configuration and validate AWS credentials

```bash
night-cloud init
```

### `deploy`
Deploy mining infrastructure to AWS

```bash
night-cloud deploy --region ap-south-1 --instances 5
```

Options:
- `--region, -r`: AWS region (default: ap-south-1)
- `--instances, -i`: Number of instances
- `--miners-per-instance, -m`: Addresses per instance (default: 10)

### `status`
Show current deployment status

```bash
night-cloud status --region ap-south-1
```

### `scale`
Scale instances up or down

```bash
night-cloud scale --region ap-south-1 --instances 10
```

### `stop`
Stop mining in a region

```bash
night-cloud stop --region ap-south-1
night-cloud stop --region ap-south-1 --terminate  # Terminate instances
```

### `kill`
Emergency kill switch - immediately terminate all mining operations

```bash
night-cloud kill --region ap-south-1
night-cloud kill --region ap-south-1 --force  # Skip confirmation prompts
```

**⚠️ WARNING**: This is an emergency command that:
- Sets Auto Scaling Group capacity to 0
- Terminates all running instances immediately
- Stops all mining operations
- Cannot be undone

Options:
- `--region, -r`: AWS region (required)
- `--force, -f`: Skip confirmation prompts (use with caution!)

**When to use**: Use this command when you need to immediately stop all mining operations, such as:
- Emergency cost control
- Unexpected AWS billing alerts
- Critical issues requiring immediate shutdown

**Note**: Unlike `stop`, this command requires double confirmation (type "KILL" to confirm) unless you use the `--force` flag. After killing, you can resume mining with the `scale` command.

### `wallet`
Manage Cardano wallets

```bash
# Generate wallets repeatedly (while avoiding rate limits)
night-cloud wallet --region ap-south-1 --auto

# Generate a specific number of wallets (automatically registers them)
night-cloud wallet --region ap-south-1 --generate 50

# Generate without registering
night-cloud wallet --region ap-south-1 --generate 50 --register=false

# List wallets
night-cloud wallet --region ap-south-1 --list

# Register existing wallets with API
night-cloud wallet --region ap-south-1 --register
```

### `logs`
View CloudWatch logs from instances

```bash
night-cloud logs --region ap-south-1
night-cloud logs --region ap-south-1 --follow  # Follow logs
```

### `dashboard`
Live dashboard monitoring **all regions** at once

```bash
night-cloud dashboard
night-cloud dashboard --refresh 5  # Refresh every 5 seconds
```

Shows:
- **Global totals** across all regions (instances, wallets, solutions)
- Current challenge and difficulty
- **Per-region breakdown** with instances, wallets, and solution rates
- Automatically filters to show only active regions

**Perfect for**: Multi-region deployments where you want a single pane of glass to monitor everything!

### `mine`
Run the miner locally (for development/testing)

```bash
night-cloud mine --region ap-south-1
night-cloud mine --region ap-south-1 --addresses 5 --workers 4
```

Options:
- `--region, -r`: AWS region to load wallets from (required)
- `--addresses, -a`: Number of addresses to mine with (default: all)
- `--workers, -w`: Number of worker processes (default: CPU cores)
- `--poll-interval, -p`: Challenge polling interval in ms (default: 60000)

**Note**: Local mining still uses AWS S3 for solution tracking and challenge queue management. This is useful for testing the mining logic without deploying to EC2.

## Configuration

Configuration is stored in `.night-config.json` in your working directory.

During initialization, you'll be prompted for:
- AWS region
- Spot instance max price
- Addresses per instance
- **Keys directory** - where to store wallet keys (default: `./keys`)

## Cost Estimation

Typical costs (as of 2025):
- c7g.xlarge spot instance: ~$0.06-0.10/hour
- 10 instances: ~$7-12/day
- Always monitor your actual AWS billing

## Security Best Practices

1. Never commit your keys directory or `.night-config.json`
2. Use AWS IAM roles with minimal required permissions
3. Enable AWS billing alerts
4. Regularly rotate credentials
5. Keep private keys secure and backed up
6. Add your keys directory to `.gitignore`

## Support

- GitHub Issues: https://github.com/nightcloudminer/night-cloud-cli/issues
- Documentation: https://github.com/nightcloudminer/night-cloud-cli#readme

## License

MIT License - See LICENSE file for details

**Remember: You are solely responsible for all costs, security, and compliance when using this software.**

