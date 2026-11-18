//! What the recovery phrases screen shows (E108). The words appear only in `revealed`, after the
//! phone's own check, and never in a debug print.

use crate::view::BiometricRequestView;

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct RecoveryPhrasesScreen {
    pub items: Vec<RecoveryPhraseItem>,
    /// The one phrase on screen, after the check. Cleared when the app leaves the screen.
    pub revealed: Option<RevealedPhraseView>,
    /// Native code runs the phone's check and answers with `biometric_result`.
    pub biometric: Option<BiometricRequestView>,
    /// The id of a phrase waiting for "Delete it?" to be answered.
    pub confirm_delete: Option<String>,
    pub notice: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RecoveryPhraseItem {
    pub id: String,
    pub label: String,
    /// What it opens, from the code the computer showed.
    pub opens: String,
    /// When it was scanned, as "Saved 3d ago".
    pub saved: String,
}

#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct RevealedPhraseView {
    pub id: String,
    pub label: String,
    pub words: Vec<String>,
    /// The same code again, for showing it to another phone or computer.
    pub qr_payload: String,
    /// A Vault phrase (or one that does not say) can unlock the Vault on the connected computer.
    pub can_unlock_vault: bool,
    /// The name for a saved file.
    pub file_name: String,
}

impl std::fmt::Debug for RevealedPhraseView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RevealedPhraseView")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("words", &"<hidden>")
            .finish()
    }
}
