//! snarkjs `.wtns` binary witness parser (BN254 only).
//!
//! Format:
//!   magic "wtns" (4) | version u32 | nSections u32
//!   section 1 (header): n8 u32 | prime[n8] | nWitness u32
//!   section 2 (witness): nWitness * n8 LE bytes

use std::io::{Cursor, Read};

use ark_bn254::Fr;
use ark_ff::PrimeField;
use byteorder::{LittleEndian, ReadBytesExt};

const MAGIC: &[u8; 4] = b"wtns";
const FIELD_BYTES: u32 = 32;

pub fn parse_bn254(bytes: &[u8]) -> Result<Vec<Fr>, String> {
    let mut cur = Cursor::new(bytes);
    read_magic(&mut cur)?;
    let _version = read_u32(&mut cur)?;
    let n_sections = read_u32(&mut cur)?;

    let mut header: Option<Header> = None;
    let mut witness_off: Option<u64> = None;

    for _ in 0..n_sections {
        let id = read_u32(&mut cur)?;
        let size = read_u64(&mut cur)?;
        let start = cur.position();
        match id {
            1 => header = Some(read_header(&mut cur, start)?),
            2 => witness_off = Some(start),
            _ => {}
        }
        cur.set_position(start + size);
    }

    let header = header.ok_or("missing wtns section 1")?;
    let off = witness_off.ok_or("missing wtns section 2")?;

    if header.n8 != FIELD_BYTES {
        return Err(format!("expected n8={FIELD_BYTES}, got {}", header.n8));
    }

    cur.set_position(off);
    let mut limbs = [0u8; FIELD_BYTES as usize];
    let mut out = Vec::with_capacity(header.n_witness as usize);
    for _ in 0..header.n_witness {
        cur.read_exact(&mut limbs).map_err(io_err)?;
        out.push(Fr::from_le_bytes_mod_order(&limbs));
    }
    Ok(out)
}

struct Header {
    n8: u32,
    n_witness: u32,
}

fn read_header(cur: &mut Cursor<&[u8]>, sec_start: u64) -> Result<Header, String> {
    let n8 = read_u32(cur)?;
    cur.set_position(sec_start + 4 + n8 as u64); // skip prime
    let n_witness = read_u32(cur)?;
    Ok(Header { n8, n_witness })
}

fn read_magic(cur: &mut Cursor<&[u8]>) -> Result<(), String> {
    let mut buf = [0u8; 4];
    cur.read_exact(&mut buf).map_err(io_err)?;
    if &buf != MAGIC {
        return Err("not a .wtns file".into());
    }
    Ok(())
}

fn read_u32(cur: &mut Cursor<&[u8]>) -> Result<u32, String> {
    cur.read_u32::<LittleEndian>().map_err(io_err)
}

fn read_u64(cur: &mut Cursor<&[u8]>) -> Result<u64, String> {
    cur.read_u64::<LittleEndian>().map_err(io_err)
}

fn io_err(e: std::io::Error) -> String {
    e.to_string()
}
