/*!
# Ashmaize wrapper for Night Cloud Miner

This wraps the official ashmaize crate for use in our miner.
*/

use ashmaize::{hash as hash_internal, Rom, RomGenerationType};

const NB_LOOPS: u32 = 8;
const NB_INSTRS: u32 = 256;
const PRE_SIZE: usize = 16 * 1024 * 1024; // 16 MiB
const ROM_SIZE: usize = 1_073_741_824; // 1 GiB
const MIXING_NUMBERS: usize = 4;

/// AshMaize hasher - wrapper around official implementation
pub struct AshMaizeHasher {
    rom: Rom,
}

impl AshMaizeHasher {
    /// Create a new hasher with ROM initialized from no_pre_mine value
    pub fn new(no_pre_mine_hex: &str) -> Self {
        let seed = no_pre_mine_hex.as_bytes();
        
        let rom = Rom::new(
            seed,
            RomGenerationType::TwoStep {
                pre_size: PRE_SIZE,
                mixing_numbers: MIXING_NUMBERS,
            },
            ROM_SIZE,
        );
        
        Self { rom }
    }

    /// Hash data using AshMaize algorithm
    pub fn hash(&self, preimage: &[u8]) -> Vec<u8> {
        hash_internal(preimage, &self.rom, NB_LOOPS, NB_INSTRS).to_vec()
    }
}
