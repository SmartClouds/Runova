//! Recovery phrases on the phone (E108). A computer shows a phrase it made (E107) as a QR code;
//! the phone scans it and keeps it in the secure store, one item per phrase, with an index that
//! holds only names. The words show after the phone's own check, hide again when the app leaves
//! the screen, and can unlock the Vault on the connected computer. A full sign-out forgets them.

use crate::engine::{Engine, Runner};
use crate::labels::ago_label;
use crate::view::{BiometricRequestView, RecoveryPhraseItem, RevealedPhraseView};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_crypto::handshake::os_random;
use runova_crypto::phrase::parse_phrase_qr;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, Zeroizing};

const INDEX: &str = "recovery-phrases";
const NOT_A_PHRASE: &str = "That isn't a recovery phrase.";
const ALREADY_SAVED: &str = "That phrase is already saved.";
const NO_COMPUTER: &str = "Connect to the computer whose Vault this opens first.";
const NOT_CONFIRMED: &str = "Couldn't confirm it's you, so the words stay hidden.";
const PLAIN_NAME: &str = "Recovery phrase";

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    id: String,
    label: String,
    purpose: Option<String>,
    saved_at_ms: u64,
}

fn phrase_key(id: &str) -> String {
    format!("recovery-phrase.{id}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn opens(purpose: Option<&str>) -> &'static str {
    match purpose {
        Some("sync") => "Synced data",
        Some("sync-recovery") => "Synced data (recovery key)",
        Some("vault") => "The Vault on a computer",
        Some("server-backup") => "Server backups",
        Some("app-backup") => "Environments in a settings backup",
        Some("servers-passkey") => "Saved server sign-ins",
        _ => "Not said",
    }
}

fn qr_payload(saved: &Saved, phrase: &str) -> String {
    match &saved.purpose {
        Some(purpose) => format!(
            "RUNOVA-PHRASE:1:{purpose}:{}:{phrase}",
            URL_SAFE_NO_PAD.encode(saved.label.as_bytes())
        ),
        None => phrase.to_owned(),
    }
}

fn file_name(label: &str) -> String {
    let clean: String = label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("Runova recovery phrase - {clean}.txt")
}

/// The phrase waiting for the phone's check.
pub(crate) struct PendingPhraseReveal {
    id: String,
}

impl Runner {
    fn saved_phrases(&self) -> Vec<Saved> {
        self.deps
            .secure
            .get(INDEX.to_owned())
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    fn save_index(&self, saved: &[Saved]) {
        if saved.is_empty() {
            self.deps.secure.remove(INDEX.to_owned());
        } else if let Ok(json) = serde_json::to_string(saved) {
            self.deps.secure.set(INDEX.to_owned(), json);
        }
    }

    fn stored_phrase(&self, id: &str) -> Option<Zeroizing<String>> {
        self.deps.secure.get(phrase_key(id)).map(Zeroizing::new)
    }

    pub(crate) fn load_recovery_phrases(&mut self) {
        let now = now_ms();
        self.view.recovery_phrases.items = self
            .saved_phrases()
            .into_iter()
            .map(|s| RecoveryPhraseItem {
                opens: opens(s.purpose.as_deref()).to_owned(),
                saved: format!(
                    "Saved {}",
                    ago_label(now.saturating_sub(s.saved_at_ms) as i64)
                ),
                id: s.id,
                label: s.label,
            })
            .collect();
    }

    fn phrase_scan(&mut self, text: String) {
        let screen = &mut self.view.recovery_phrases;
        screen.error = None;
        screen.notice = None;
        let Some(read) = parse_phrase_qr(&text) else {
            screen.error = Some(NOT_A_PHRASE.to_owned());
            return;
        };
        let mut saved = self.saved_phrases();
        let known = saved.iter().any(|s| {
            self.stored_phrase(&s.id)
                .is_some_and(|p| p.as_str() == read.phrase.as_str())
        });
        if known {
            self.view.recovery_phrases.notice = Some(ALREADY_SAVED.to_owned());
            return;
        }
        let id = URL_SAFE_NO_PAD.encode(os_random(9));
        let label = read
            .label
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| PLAIN_NAME.to_owned());
        self.deps
            .secure
            .set(phrase_key(&id), read.phrase.as_str().to_owned());
        saved.push(Saved {
            id,
            label: label.clone(),
            purpose: read.purpose,
            saved_at_ms: now_ms(),
        });
        self.save_index(&saved);
        self.load_recovery_phrases();
        self.view.recovery_phrases.notice = Some(format!("Saved {label}."));
    }

    fn phrase_reveal(&mut self, id: String) {
        let Some(saved) = self.saved_phrases().into_iter().find(|s| s.id == id) else {
            return;
        };
        self.biometric_serial = self.biometric_serial.wrapping_add(1);
        self.view.recovery_phrases.error = None;
        self.view.recovery_phrases.biometric = Some(BiometricRequestView {
            id: self.biometric_serial,
            reason: format!("Show the recovery phrase {}", saved.label),
        });
        self.pending_phrase = Some(PendingPhraseReveal { id });
    }

    /// True when the answer was for a phrase, so the other checks leave it alone.
    pub(crate) fn phrase_biometric_result(&mut self, id: u64, confirmed: bool) -> bool {
        if self.view.recovery_phrases.biometric.as_ref().map(|b| b.id) != Some(id) {
            return false;
        }
        self.view.recovery_phrases.biometric = None;
        let Some(pending) = self.pending_phrase.take() else {
            return true;
        };
        if !confirmed {
            self.view.recovery_phrases.error = Some(NOT_CONFIRMED.to_owned());
            return true;
        }
        let saved = self
            .saved_phrases()
            .into_iter()
            .find(|s| s.id == pending.id);
        if let (Some(saved), Some(phrase)) = (saved, self.stored_phrase(&pending.id)) {
            self.view.recovery_phrases.revealed = Some(RevealedPhraseView {
                words: phrase.split(' ').map(str::to_owned).collect(),
                qr_payload: qr_payload(&saved, &phrase),
                can_unlock_vault: matches!(saved.purpose.as_deref(), None | Some("vault")),
                file_name: file_name(&saved.label),
                id: saved.id,
                label: saved.label,
            });
        }
        true
    }

    pub(crate) fn phrase_hide(&mut self) {
        self.pending_phrase = None;
        self.view.recovery_phrases.biometric = None;
        if let Some(mut shown) = self.view.recovery_phrases.revealed.take() {
            shown.words.iter_mut().for_each(Zeroize::zeroize);
            shown.qr_payload.zeroize();
        }
    }

    fn phrase_delete(&mut self, id: String) {
        if self.saved_phrases().iter().any(|s| s.id == id) {
            self.view.recovery_phrases.confirm_delete = Some(id);
        }
    }

    fn phrase_delete_answer(&mut self, yes: bool) {
        let Some(id) = self.view.recovery_phrases.confirm_delete.take() else {
            return;
        };
        if !yes {
            return;
        }
        if self
            .view
            .recovery_phrases
            .revealed
            .as_ref()
            .is_some_and(|r| r.id == id)
        {
            self.phrase_hide();
        }
        let saved: Vec<Saved> = self
            .saved_phrases()
            .into_iter()
            .filter(|s| s.id != id)
            .collect();
        self.deps.secure.remove(phrase_key(&id));
        self.save_index(&saved);
        self.load_recovery_phrases();
        self.view.recovery_phrases.notice = Some("Deleted the phrase from this phone.".to_owned());
    }

    fn phrase_unlock_vault(&mut self, id: String) {
        // Only a phrase already shown after the check, so this needs no second one.
        let shown = self
            .view
            .recovery_phrases
            .revealed
            .as_ref()
            .is_some_and(|r| r.id == id && r.can_unlock_vault);
        if !shown {
            return;
        }
        if self.client().is_none() {
            self.view.recovery_phrases.error = Some(NO_COMPUTER.to_owned());
            return;
        }
        if let Some(phrase) = self.stored_phrase(&id) {
            self.vault_unlock(phrase.as_str().to_owned());
            self.view.recovery_phrases.notice =
                Some("Sent to the computer to unlock its Vault.".to_owned());
        }
    }

    /// Forgets every phrase, for a full sign-out.
    pub(crate) fn remove_recovery_phrases(&mut self) {
        self.phrase_hide();
        for saved in self.saved_phrases() {
            self.deps.secure.remove(phrase_key(&saved.id));
        }
        self.deps.secure.remove(INDEX.to_owned());
        self.view.recovery_phrases = Default::default();
    }
}

#[uniffi::export]
impl Engine {
    /// The text of a QR code the camera read on the recovery phrases screen.
    pub fn phrase_scan(&self, text: String) {
        self.run(move |r| r.phrase_scan(text));
    }

    /// Asks for the phone's check, then shows the words.
    pub fn phrase_reveal(&self, id: String) {
        self.run(move |r| r.phrase_reveal(id));
    }

    pub fn phrase_hide(&self) {
        self.run(Runner::phrase_hide);
    }

    /// Asks "Delete it?" first; `phrase_delete_answer` carries the answer.
    pub fn phrase_delete(&self, id: String) {
        self.run(move |r| r.phrase_delete(id));
    }

    pub fn phrase_delete_answer(&self, yes: bool) {
        self.run(move |r| r.phrase_delete_answer(yes));
    }

    /// Unlocks the Vault on the connected computer with a phrase on screen.
    pub fn phrase_unlock_vault(&self, id: String) {
        self.run(move |r| r.phrase_unlock_vault(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_saved_file_without_characters_a_disk_refuses() {
        assert_eq!(
            file_name("Vault: work laptop ✓"),
            "Runova recovery phrase - Vault work laptop.txt"
        );
    }

    #[test]
    fn a_phrase_from_another_tool_keeps_its_bare_words_in_the_code() {
        let saved = Saved {
            id: "x".into(),
            label: PLAIN_NAME.into(),
            purpose: None,
            saved_at_ms: 0,
        };
        assert_eq!(qr_payload(&saved, "a b"), "a b");
    }
}
