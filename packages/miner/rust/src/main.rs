use anyhow::Result;
use clap::Parser;
use tracing::info;

mod miner;
mod hasher;

#[derive(Parser, Debug)]
#[command(name = "night-cloud")]
#[command(about = "Night Cloud Miner - Single address mining worker", long_about = None)]
struct Args {
    /// Cardano address to mine for
    #[arg(long)]
    address: String,

    /// Challenge ID
    #[arg(long)]
    challenge_id: String,

    /// Difficulty (hex string)
    #[arg(long)]
    difficulty: String,

    /// No pre-mine value (hex string)
    #[arg(long)]
    no_pre_mine: String,

    /// Latest submission timestamp
    #[arg(long)]
    latest_submission: String,

    /// No pre-mine hour
    #[arg(long)]
    no_pre_mine_hour: String,

    /// Maximum attempts before giving up
    #[arg(long, default_value = "10000000")]
    max_attempts: u64,
}

fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("night_miner=info")
        .init();

    let args = Args::parse();

    info!("☁️⛏️  Night Cloud Miner - Mining for single address");
    info!("Address: {}...", &args.address[..20]);
    info!("Challenge: {}", args.challenge_id);
    info!("Difficulty: {}", args.difficulty);
    info!("Max attempts: {}", args.max_attempts);

    // Mine solution
    match miner::mine_solution(
        &args.address,
        &args.challenge_id,
        &args.difficulty,
        &args.no_pre_mine,
        &args.latest_submission,
        &args.no_pre_mine_hour,
        args.max_attempts,
    )? {
        Some((nonce, preimage, hash)) => {
            // Output as JSON for easy parsing by TypeScript
            println!("{{");
            println!("  \"success\": true,");
            println!("  \"nonce\": \"{}\",", nonce);
            println!("  \"preimage\": \"{}\",", preimage);
            println!("  \"hash\": \"{}\"", hash);
            println!("}}");
            Ok(())
        }
        None => {
            // No solution found
            println!("{{");
            println!("  \"success\": false,");
            println!("  \"message\": \"No solution found in {} attempts\"", args.max_attempts);
            println!("}}");
            Ok(())
        }
    }
}

