#![cfg(target_arch = "wasm32")]

use ashmaize_web::{RomBuilder, RomBuilderError};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

const B: usize = 1;
const KB: usize = 1_024 * B;
const MB: usize = 1_024 * KB;

const DEFAULT_KEY: [u8; 32] = [0; 32];

#[wasm_bindgen_test]
fn rom_builder_missing_key() {
    let mut builder = RomBuilder::new();
    builder.size(1 * MB);
    builder.gen_full_random();

    assert!(matches!(builder.build(), Err(RomBuilderError::MissingKey)));
}

#[wasm_bindgen_test]
fn rom_builder_missing_size() {
    let mut builder = RomBuilder::new();
    builder.key(&DEFAULT_KEY);
    builder.gen_full_random();

    assert!(matches!(builder.build(), Err(RomBuilderError::MissingSize)));
}

#[wasm_bindgen_test]
fn rom_builder_missing_gen_type() {
    let mut builder = RomBuilder::new();
    builder.size(1 * MB);
    builder.key(&DEFAULT_KEY);

    assert!(matches!(
        builder.build(),
        Err(RomBuilderError::MissingGenType)
    ));
}

#[wasm_bindgen_test]
fn rom_builder_pre_size_not_power_of_two() {
    let mut builder = RomBuilder::new();
    builder.size(1 * MB);
    builder.key(&DEFAULT_KEY);
    builder.gen_two_steps(17, 8);

    assert!(matches!(
        builder.build(),
        Err(RomBuilderError::PreSizeNotPowerOfTwo)
    ));
}

#[wasm_bindgen_test]
fn rom_build_size_0() {
    let mut builder = RomBuilder::new();
    builder.size(0 * MB);
    builder.key(&DEFAULT_KEY);
    builder.gen_full_random();

    assert!(matches!(builder.build(), Err(RomBuilderError::SizeIsZero)));
}

#[wasm_bindgen_test]
fn rom_build_full_random() {
    let mut builder = RomBuilder::new();
    builder.size(1 * MB);
    builder.key(&DEFAULT_KEY);
    builder.gen_full_random();

    assert!(matches!(builder.build(), Ok(..)));
}

#[wasm_bindgen_test]
fn rom_build_two_steps() {
    let mut builder = RomBuilder::new();
    builder.size(1 * MB);
    builder.key(&DEFAULT_KEY);
    builder.gen_two_steps(256, 8);

    assert!(matches!(builder.build(), Ok(..)));
}

#[wasm_bindgen_test]
fn rom_hash() {
    const PRE_SIZE: usize = 16 * 1024;
    const SIZE: usize = 10 * 1024 * 1024;
    const NB_INSTR: u32 = 256;
    const EXPECTED: [u8; 64] = [
        56, 148, 1, 228, 59, 96, 211, 173, 9, 98, 68, 61, 89, 171, 124, 171, 124, 183, 200, 196,
        29, 43, 133, 168, 218, 217, 255, 71, 234, 182, 97, 158, 231, 156, 56, 230, 61, 54, 248,
        199, 150, 15, 66, 0, 149, 185, 85, 177, 192, 220, 237, 77, 195, 106, 140, 223, 175, 93,
        238, 220, 57, 159, 180, 243,
    ];

    let mut builder = RomBuilder::new();
    builder.size(SIZE);
    builder.key(b"123");
    builder.gen_two_steps(PRE_SIZE, 4);

    let rom = builder.build().unwrap();
    let hash = rom.hash(b"hello", 8, NB_INSTR);

    assert_eq!(hash, EXPECTED);
}
