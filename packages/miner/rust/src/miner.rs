use anyhow::Result;
use tracing::{debug, info};
use rand::Rng;

use crate::hasher::AshMaizeHasher;

/// Mine a solution for a single address
/// Returns (nonce, preimage, hash) if solution found
pub fn mine_solution(
    address: &str,
    challenge_id: &str,
    difficulty: &str,
    no_pre_mine: &str,
    latest_submission: &str,
    no_pre_mine_hour: &str,
    max_attempts: u64,
) -> Result<Option<(String, String, String)>> {
    // Initialize hasher with ROM
    let hasher = AshMaizeHasher::new(no_pre_mine);

    let mut rng = rand::thread_rng();

    for attempt in 0..max_attempts {
        // Generate random nonce (16 hex characters = 8 bytes)
        let nonce = format!("{:016x}", rng.gen::<u64>());

        // Construct preimage following the spec
        let preimage = construct_preimage(
            &nonce,
            address,
            challenge_id,
            difficulty,
            no_pre_mine,
            latest_submission,
            no_pre_mine_hour,
        );

        // Hash with AshMaize
        let hash = hasher.hash(preimage.as_bytes());
        let hash_hex = hex::encode(&hash);

        // Check if hash meets difficulty
        if check_difficulty(&hash_hex, difficulty) {
            info!(
                "Found solution after {} attempts: nonce={}",
                attempt + 1, nonce
            );
            return Ok(Some((nonce, preimage, hash_hex)));
        }

        // Log progress every 100k attempts
        if attempt > 0 && attempt % 100_000 == 0 {
            debug!("{} attempts...", attempt);
        }
    }

    Ok(None)
}

/// Construct preimage following the Scavenger Mine spec
fn construct_preimage(
    nonce: &str,
    address: &str,
    challenge_id: &str,
    difficulty: &str,
    no_pre_mine: &str,
    latest_submission: &str,
    no_pre_mine_hour: &str,
) -> String {
    format!(
        "{}{}{}{}{}{}{}",
        nonce, address, challenge_id, difficulty, no_pre_mine, latest_submission, no_pre_mine_hour
    )
}

/// Check if hash meets difficulty using bitwise OR check
/// 
/// This matches the browser implementation:
/// (hash_value | diff_value) == diff_value
/// 
/// This checks if all bits in hash_value are also set in diff_value
fn check_difficulty(hash_hex: &str, difficulty: &str) -> bool {
    // Take prefix of hash matching difficulty length
    let hash_prefix = &hash_hex[..difficulty.len().min(hash_hex.len())];
    
    // Parse as hex integers
    let hash_value = match u128::from_str_radix(hash_prefix, 16) {
        Ok(v) => v,
        Err(_) => return false,
    };
    
    let diff_value = match u128::from_str_radix(difficulty, 16) {
        Ok(v) => v,
        Err(_) => return false,
    };
    
    // Bitwise OR check (hash is subset of difficulty's bits)
    (hash_value | diff_value) == diff_value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preimage_construction() {
        let preimage = construct_preimage(
            "0019c96b6a30ee38",
            "addr_test1qq4dl3nhr0axurgcrpun9xyp04pd2r2dwu5x7eeam98psv6dhxlde8ucc1v2p46hm077ds4vzelf5565fg3ky794uhrq5up0he",
            "**D07C10",
            "000FFFFF",
            "fd651ac2725e3b9d804cc8b161c0709af14d6264f93e8d4afef0fd1142a3f011",
            "2025-10-19T08:59:59.000Z",
            "509681483",
        );
        
        assert!(preimage.contains("0019c96b6a30ee38"));
        assert!(preimage.contains("addr_test1"));
        assert!(preimage.contains("**D07C10"));
    }

    #[test]
    fn test_difficulty_check() {
        // Hash that meets difficulty
        assert!(check_difficulty("000694200fb04137", "000FFFFF"));
        
        // Hash that doesn't meet difficulty
        assert!(!check_difficulty("FFFFFFFF", "000FFFFF"));
        
        // Edge cases
        assert!(check_difficulty("00000000", "FFFFFFFF"));
        assert!(check_difficulty("000FFFFF", "000FFFFF"));
    }
}
