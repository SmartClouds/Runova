//! Sending files between this phone and a computer (E113, E114): the batch a send offers, the
//! resumable transfer of each file, and the receiving side, all over one secure link. The same
//! messages and checks as the desktop's `FileTransferManager` and send batches, so a phone and a
//! computer each take either part.

pub mod receiver;
pub mod sender;
pub mod source;
mod wire;
