//! Where a sent file's bytes come from. A file is opened only when its turn comes, so a pick of
//! hundreds of files never holds hundreds open at once.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// The bytes of one file, read at any offset, as many times as a resend needs.
pub trait FileSource: Send {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize>;
}

impl FileSource for std::fs::File {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        self.seek(SeekFrom::Start(offset))?;
        let mut filled = 0;
        while filled < buf.len() {
            let read = self.read(&mut buf[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        Ok(filled)
    }
}

/// Opens a file of the batch by its transfer id.
pub trait SourceOpener: Send + Sync {
    fn open(&self, transfer_id: &str) -> Result<Box<dyn FileSource>, String>;
}

/// Files on this device's own disk, by transfer id.
#[derive(Default, Clone)]
pub struct PathOpener {
    paths: HashMap<String, PathBuf>,
}

impl PathOpener {
    pub fn add(&mut self, transfer_id: &str, path: PathBuf) {
        self.paths.insert(transfer_id.to_owned(), path);
    }
}

impl SourceOpener for PathOpener {
    fn open(&self, transfer_id: &str) -> Result<Box<dyn FileSource>, String> {
        let path = self
            .paths
            .get(transfer_id)
            .ok_or_else(|| "That file is not in this send.".to_owned())?;
        std::fs::File::open(path)
            .map(|file| Box::new(file) as Box<dyn FileSource>)
            .map_err(|_| "It is not there any more.".to_owned())
    }
}
