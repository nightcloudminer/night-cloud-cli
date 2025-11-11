use ashmaize::{hash, Rom, RomGenerationType};

fn main() {
    // Test vector from spec
    let no_pre_mine_hex = "fd651ac2725e3b9d804cc8b161c0709af14d6264f93e8d4afef0fd1142a3f011";
    let preimage = "0019c96b6a30ee38addr_test1qq4dl3nhr0axurgcrpun9xyp04pd2r2dwu5x7eeam98psv6dhxlde8ucc1v2p46hm077ds4vzelf5565fg3ky794uhrq5up0he**D07C10000FFFFFfd651ac2725e3b9d804cc8b161c0709af14d6264f93e8d4afef0fd1142a3f0112025-10-19T08:59:59.000Z509681483";
    
    let expected = "000694200fb04137812fb7f35fab2f0e07adf8465397d268bcd97d2f4c7b875fe6d42f12f377b5b83bcfbd70d6ba55441650c37b8fc80851216b3a1aed7e23c8";
    
    // Decode hex seed
    let seed = hex::decode(no_pre_mine_hex).unwrap();
    
    // Create ROM with spec parameters
    let rom = Rom::new(
        &seed,
        RomGenerationType::TwoStep {
            pre_size: 16 * 1024 * 1024,  // 16 MiB
            mixing_numbers: 4,
        },
        1_073_741_824,  // 1 GiB
    );
    
    // Hash with spec parameters
    let digest = hash(preimage.as_bytes(), &rom, 8, 256);
    let computed = hex::encode(digest);
    
    println!("Expected: {}", expected);
    println!("Computed: {}", computed);
    println!("Match: {}", computed == expected);
}
