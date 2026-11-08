//! Just enough STUN (RFC 8489) to learn the address the internet sees this phone at.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
const BINDING_SUCCESS: [u8; 2] = [0x01, 0x01];
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const HEADER: usize = 20;

pub fn binding_request(id: &[u8; 12]) -> Vec<u8> {
    let mut request = Vec::with_capacity(HEADER);
    request.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
    request.extend_from_slice(&MAGIC);
    request.extend_from_slice(id);
    request
}

fn xor_address(value: &[u8], id: &[u8; 12]) -> Option<SocketAddr> {
    let family = *value.get(1)?;
    let port = u16::from_be_bytes([value[2] ^ MAGIC[0], value[3] ^ MAGIC[1]]);
    let ip = match family {
        1 => {
            let raw = value.get(4..8)?;
            IpAddr::V4(Ipv4Addr::new(
                raw[0] ^ MAGIC[0],
                raw[1] ^ MAGIC[1],
                raw[2] ^ MAGIC[2],
                raw[3] ^ MAGIC[3],
            ))
        }
        2 => {
            let raw = value.get(4..20)?;
            let mut mask = [0u8; 16];
            mask[..4].copy_from_slice(&MAGIC);
            mask[4..].copy_from_slice(id);
            let mut bytes = [0u8; 16];
            for (index, byte) in bytes.iter_mut().enumerate() {
                *byte = raw[index] ^ mask[index];
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// The mapped address in the answer to the request with this id.
pub fn read_mapped_address(packet: &[u8], id: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < HEADER
        || packet[..2] != BINDING_SUCCESS
        || packet[4..8] != MAGIC
        || packet[8..20] != id[..]
    {
        return None;
    }
    let mut rest = &packet[HEADER..];
    while rest.len() >= 4 {
        let kind = u16::from_be_bytes([rest[0], rest[1]]);
        let length = usize::from(u16::from_be_bytes([rest[2], rest[3]]));
        let value = rest.get(4..4 + length)?;
        if kind == XOR_MAPPED_ADDRESS && value.len() >= 8 {
            return xor_address(value, id);
        }
        let padded = (4 + length).next_multiple_of(4);
        rest = rest.get(padded..)?;
    }
    None
}
