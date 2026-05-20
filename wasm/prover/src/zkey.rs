//! snarkjs ZKey parser → arkworks `ProvingKey<Bn254>` + `ConstraintMatrices<Fr>`.
//!
//! Section layout:
//!   1  Header              (prover type)
//!   2  HeaderGroth         (n8q | q | n8r | r | nVars | nPub | domainSize | vk fields)
//!   3  IC                  (G1 × (nPub + 1))
//!   4  Coefficients        (matrices A, B)
//!   5  PointsA             (G1 × nVars)
//!   6  PointsB1            (G1 × nVars)
//!   7  PointsB2            (G2 × nVars)
//!   8  PointsC / L query   (G1 × (nVars - nPub - 1))
//!   9  PointsH             (G1 × domainSize)
//!  10  Contributions

use std::io::{Read, Seek, SeekFrom};

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::PrimeField;
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_serialize::{CanonicalDeserialize, SerializationError};
use byteorder::{LittleEndian, ReadBytesExt};
use num_traits::Zero;

#[cfg(feature = "parallel")]
use rayon::prelude::*;

const G1_BYTES: usize = 64;
const G2_BYTES: usize = 128;
const FQ_BYTES: usize = 32;

type IoResult<T> = Result<T, SerializationError>;

// Section IDs are 1..=10 in snarkjs groth16 zkey. Index 0 unused.
const NUM_SECTION_SLOTS: usize = 11;
const SEC_HEADER_GROTH: u32 = 2;
const SEC_IC: u32 = 3;
const SEC_COEFFS: u32 = 4;
const SEC_A: u32 = 5;
const SEC_B1: u32 = 6;
const SEC_B2: u32 = 7;
const SEC_L: u32 = 8;
const SEC_H: u32 = 9;

/// Reads a snarkjs zkey into an arkworks `ProvingKey` + R1CS matrices.
pub fn read_zkey<R: Read + Seek>(
    reader: &mut R,
) -> IoResult<(ProvingKey<Bn254>, ConstraintMatricesFr)> {
    let mut bin = BinFile::new(reader)?;
    let header = bin.groth_header()?;
    let pk = bin.proving_key(&header)?;
    let matrices = bin.matrices(&header)?;
    Ok((pk, matrices))
}

pub type ConstraintMatricesFr = ark_relations::r1cs::ConstraintMatrices<Fr>;

struct Section {
    position: u64,
}

struct BinFile<'a, R> {
    sections: [Option<Section>; NUM_SECTION_SLOTS],
    reader: &'a mut R,
}

impl<'a, R: Read + Seek> BinFile<'a, R> {
    fn new(reader: &'a mut R) -> IoResult<Self> {
        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic)?;
        let _version = reader.read_u32::<LittleEndian>()?;
        let num_sections = reader.read_u32::<LittleEndian>()?;

        let mut sections: [Option<Section>; NUM_SECTION_SLOTS] = Default::default();
        for _ in 0..num_sections {
            let id = reader.read_u32::<LittleEndian>()?;
            let len = reader.read_u64::<LittleEndian>()?;
            let position = reader.stream_position()?;
            // First occurrence wins; snarkjs writes each section once for groth16.
            // IDs outside the known 1..=10 range are silently skipped.
            if let Some(slot) = sections.get_mut(id as usize) {
                slot.get_or_insert(Section { position });
            }
            reader.seek(SeekFrom::Current(len as i64))?;
        }
        Ok(Self { sections, reader })
    }

    fn seek_to(&mut self, id: u32) -> IoResult<()> {
        let pos = self.sections[id as usize]
            .as_ref()
            .expect("section id missing from zkey")
            .position;
        self.reader.seek(SeekFrom::Start(pos))?;
        Ok(())
    }

    fn groth_header(&mut self) -> IoResult<HeaderGroth> {
        self.seek_to(SEC_HEADER_GROTH)?;
        HeaderGroth::read(&mut self.reader)
    }

    fn proving_key(&mut self, h: &HeaderGroth) -> IoResult<ProvingKey<Bn254>> {
        let ic = self.read_g1_section(SEC_IC, h.n_public + 1)?;
        let a_query = self.read_g1_section(SEC_A, h.n_vars)?;
        let b_g1_query = self.read_g1_section(SEC_B1, h.n_vars)?;
        let b_g2_query = self.read_g2_section(SEC_B2, h.n_vars)?;
        let l_query = self.read_g1_section(SEC_L, h.n_vars - h.n_public - 1)?;
        let h_query = self.read_g1_section(SEC_H, h.domain_size as usize)?;

        let vk = VerifyingKey::<Bn254> {
            alpha_g1: h.vk.alpha_g1,
            beta_g2: h.vk.beta_g2,
            gamma_g2: h.vk.gamma_g2,
            delta_g2: h.vk.delta_g2,
            gamma_abc_g1: ic,
        };
        Ok(ProvingKey::<Bn254> {
            vk,
            beta_g1: h.vk.beta_g1,
            delta_g1: h.vk.delta_g1,
            a_query,
            b_g1_query,
            b_g2_query,
            h_query,
            l_query,
        })
    }

    fn matrices(&mut self, h: &HeaderGroth) -> IoResult<ConstraintMatricesFr> {
        self.seek_to(SEC_COEFFS)?;
        let num_coeffs = self.reader.read_u32::<LittleEndian>()?;

        // Grow rows on demand instead of preallocating `domain_size` empty Vec slots.
        // snarkjs domains can be 2^20+, so the dense preallocation wastes >10MB
        // of outer-Vec headers in wasm32 even though most slots stay empty.
        let mut a_rows: Vec<Vec<(Fr, usize)>> = Vec::new();
        let mut b_rows: Vec<Vec<(Fr, usize)>> = Vec::new();
        let mut max_constraint = 0u32;

        for _ in 0..num_coeffs {
            let matrix = self.reader.read_u32::<LittleEndian>()?;
            let constraint = self.reader.read_u32::<LittleEndian>()?;
            let signal = self.reader.read_u32::<LittleEndian>()?;
            let value = read_fr(&mut self.reader)?;
            max_constraint = max_constraint.max(constraint);
            let rows = match matrix {
                0 => &mut a_rows,
                1 => &mut b_rows,
                _ => continue, // snarkjs only emits 0/1 for groth16
            };
            let idx = constraint as usize;
            if idx >= rows.len() {
                rows.resize_with(idx + 1, Vec::new);
            }
            rows[idx].push((value, signal as usize));
        }

        // Drop the trailing rows snarkjs adds for public-input constraints; arkworks re-adds them.
        let num_constraints = max_constraint as usize - h.n_public;
        a_rows.truncate(num_constraints);
        b_rows.truncate(num_constraints);
        a_rows.shrink_to_fit();
        b_rows.shrink_to_fit();

        let a_num_non_zero = a_rows.iter().map(Vec::len).sum();
        let b_num_non_zero = b_rows.iter().map(Vec::len).sum();
        Ok(ConstraintMatricesFr {
            num_instance_variables: h.n_public + 1,
            num_witness_variables: h.n_vars - h.n_public,
            num_constraints,
            a_num_non_zero,
            b_num_non_zero,
            c_num_non_zero: 0,
            a: a_rows,
            b: b_rows,
            c: vec![],
        })
    }

    fn read_g1_section(&mut self, id: u32, count: usize) -> IoResult<Vec<G1Affine>> {
        self.seek_to(id)?;
        let mut buf = vec![0u8; count * G1_BYTES];
        self.reader.read_exact(&mut buf)?;
        parse_points(&buf, G1_BYTES, parse_g1)
    }

    fn read_g2_section(&mut self, id: u32, count: usize) -> IoResult<Vec<G2Affine>> {
        self.seek_to(id)?;
        let mut buf = vec![0u8; count * G2_BYTES];
        self.reader.read_exact(&mut buf)?;
        parse_points(&buf, G2_BYTES, parse_g2)
    }
}

#[cfg(feature = "parallel")]
fn parse_points<T, F>(buf: &[u8], stride: usize, f: F) -> IoResult<Vec<T>>
where
    T: Send,
    F: Fn(&[u8]) -> IoResult<T> + Sync + Send,
{
    buf.par_chunks_exact(stride).map(f).collect()
}

#[cfg(not(feature = "parallel"))]
fn parse_points<T, F>(buf: &[u8], stride: usize, f: F) -> IoResult<Vec<T>>
where
    F: Fn(&[u8]) -> IoResult<T>,
{
    buf.chunks_exact(stride).map(f).collect()
}

struct VkPoints {
    alpha_g1: G1Affine,
    beta_g1: G1Affine,
    beta_g2: G2Affine,
    gamma_g2: G2Affine,
    delta_g1: G1Affine,
    delta_g2: G2Affine,
}

impl VkPoints {
    fn read<R: Read>(reader: &mut R) -> IoResult<Self> {
        Ok(Self {
            alpha_g1: read_g1(reader)?,
            beta_g1: read_g1(reader)?,
            beta_g2: read_g2(reader)?,
            gamma_g2: read_g2(reader)?,
            delta_g1: read_g1(reader)?,
            delta_g2: read_g2(reader)?,
        })
    }
}

struct HeaderGroth {
    n_vars: usize,
    n_public: usize,
    domain_size: u32,
    vk: VkPoints,
}

impl HeaderGroth {
    fn read<R: Read + Seek>(mut reader: &mut R) -> IoResult<Self> {
        let n8q = u32::deserialize_uncompressed(&mut reader)?;
        reader.seek(SeekFrom::Current(n8q as i64))?; // q
        let n8r = u32::deserialize_uncompressed(&mut reader)?;
        reader.seek(SeekFrom::Current(n8r as i64))?; // r
        let n_vars = u32::deserialize_uncompressed(&mut reader)? as usize;
        let n_public = u32::deserialize_uncompressed(&mut reader)? as usize;
        let domain_size = u32::deserialize_uncompressed(&mut reader)?;
        let vk = VkPoints::read(&mut reader)?;
        Ok(Self {
            n_vars,
            n_public,
            domain_size,
            vk,
        })
    }
}

/// snarkjs writes Fr coefficients pre-multiplied by R^2. `Fr::new_unchecked(bigint)` then
/// `.into_bigint()` divides by R once; wrapping again with `new_unchecked` divides by R again,
/// landing in standard (non-Montgomery) form expected by arkworks consumers.
fn read_fr<R: Read>(reader: &mut R) -> IoResult<Fr> {
    let bigint = <Fr as PrimeField>::BigInt::deserialize_uncompressed(reader)?;
    Ok(Fr::new_unchecked(Fr::new_unchecked(bigint).into_bigint()))
}

fn read_g1<R: Read>(reader: &mut R) -> IoResult<G1Affine> {
    let mut buf = [0u8; G1_BYTES];
    reader.read_exact(&mut buf)?;
    parse_g1(&buf)
}

fn read_g2<R: Read>(reader: &mut R) -> IoResult<G2Affine> {
    let mut buf = [0u8; G2_BYTES];
    reader.read_exact(&mut buf)?;
    parse_g2(&buf)
}

fn parse_fq(bytes: &[u8]) -> IoResult<Fq> {
    let mut slice = bytes;
    let bigint = <Fq as PrimeField>::BigInt::deserialize_uncompressed(&mut slice)?;
    Ok(Fq::new_unchecked(bigint))
}

fn parse_fq2(bytes: &[u8]) -> IoResult<Fq2> {
    Ok(Fq2::new(
        parse_fq(&bytes[..FQ_BYTES])?,
        parse_fq(&bytes[FQ_BYTES..])?,
    ))
}

fn parse_g1(bytes: &[u8]) -> IoResult<G1Affine> {
    let x = parse_fq(&bytes[..FQ_BYTES])?;
    let y = parse_fq(&bytes[FQ_BYTES..])?;
    if x.is_zero() && y.is_zero() {
        Ok(G1Affine::identity())
    } else {
        // Trusted setup: points pre-validated, skip on-curve + subgroup checks.
        Ok(G1Affine::new_unchecked(x, y))
    }
}

fn parse_g2(bytes: &[u8]) -> IoResult<G2Affine> {
    let x = parse_fq2(&bytes[..2 * FQ_BYTES])?;
    let y = parse_fq2(&bytes[2 * FQ_BYTES..])?;
    if x.is_zero() && y.is_zero() {
        Ok(G2Affine::identity())
    } else {
        Ok(G2Affine::new_unchecked(x, y))
    }
}
