//! Which items are sealed so only the person's own devices can read them, and opening what was.

use crate::backend::BackendError;
use crate::engine::{Apply, Done, Engine, Runner};
use crate::secure::identity_seed;
use crate::view::{EncryptionItemView, EncryptionScreen};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_crypto::sealed::SealKey;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

const ENCRYPTION: &str = "/api/v1/accounts/me/encryption-preferences";
const FOOTNOTE: &str = "Your connection to the server uses TLS either way. Alerts the server writes itself, such as cloud monitors, can't be sealed.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemDto {
    item: String,
    label: String,
    enabled: bool,
    #[serde(default)]
    lapsed: bool,
    #[serde(default)]
    needs_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusDto {
    entitled: bool,
    plan_name: String,
    items: Vec<ItemDto>,
}

/// One phone's copy of a sealed item.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyDto {
    key_id: String,
    sealed: String,
}

fn detail_of(item: &ItemDto) -> String {
    if item.needs_key {
        return "Set a key on your computer first.".to_owned();
    }
    match item.item.as_str() {
        "notifications" => {
            "What your computers tell this phone. The server sees that something happened and when, but not what it says."
        }
        "sync" => "Every record in your own sync, not only passwords and keys.",
        _ => "",
    }
    .to_owned()
}

fn screen_of(dto: StatusDto) -> EncryptionScreen {
    let lapsed: Vec<&str> = dto
        .items
        .iter()
        .filter(|item| item.lapsed)
        .map(|item| item.label.as_str())
        .collect();
    let warning = (!lapsed.is_empty()).then(|| {
        format!(
            "Your plan no longer includes encryption, so {} went back to normal. What is already sealed stays sealed.",
            lapsed.join(" and ")
        )
    });
    let note = (!dto.entitled && warning.is_none()).then(|| {
        format!(
            "Included with Go, Pro and Ultra. You are on {}.",
            dto.plan_name
        )
    });
    let entitled = dto.entitled;
    EncryptionScreen {
        note,
        warning,
        footnote: FOOTNOTE.to_owned(),
        items: dto
            .items
            .iter()
            .map(|item| EncryptionItemView {
                detail: detail_of(item),
                // Turning something off always works, whatever the plan.
                can_change: item.enabled || (entitled && !item.needs_key),
                item: item.item.clone(),
                label: item.label.clone(),
                enabled: item.enabled,
            })
            .collect(),
    }
}

fn context_of(category: &str) -> String {
    format!("notification:{category}")
}

/// The line in this phone's copy, or None when there is no copy for it or the copy won't open.
pub(crate) fn open_copy(copies: &[CopyDto], key: &SealKey, category: &str) -> Option<String> {
    let id = key.key_id();
    let copy = copies.iter().find(|copy| copy.key_id == id)?;
    open_text(key, category, &copy.sealed)
}

fn open_text(key: &SealKey, category: &str, sealed: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(sealed).ok()?;
    let opened = key.open(&bytes, &context_of(category)).ok()?;
    String::from_utf8(opened).ok()
}

/// What a push handler needs to open a sealed line without the rest of the app running.
#[uniffi::export]
pub fn notification_secret(identity_seed: String) -> Option<String> {
    let seed: [u8; 32] = URL_SAFE_NO_PAD
        .decode(identity_seed)
        .ok()?
        .try_into()
        .ok()?;
    Some(URL_SAFE_NO_PAD.encode(SealKey::from_identity_seed(&seed).secret_bytes()))
}

/// Opens a sealed push. None means show the generic line that came with it.
#[uniffi::export]
pub fn open_sealed_notification(
    secret: String,
    category: String,
    sealed: String,
) -> Option<String> {
    let secret: [u8; 32] = URL_SAFE_NO_PAD.decode(secret).ok()?.try_into().ok()?;
    open_text(&SealKey::from_secret(secret), &category, &sealed)
}

impl Runner {
    pub(crate) fn seal_key(&mut self) -> Arc<SealKey> {
        let secure = self.deps.secure.clone();
        self.seal_key
            .get_or_insert_with(|| {
                Arc::new(SealKey::from_identity_seed(&identity_seed(secure.as_ref())))
            })
            .clone()
    }

    /// Goes around `rest` because a server too old to answer shouldn't put an error on the screen.
    pub(crate) fn load_encryption(&mut self) {
        let backend = self.deps_backend();
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let Ok(value) = backend.get_json(ENCRYPTION).await else {
                return;
            };
            let Ok(dto) = serde_json::from_value::<StatusDto>(value) else {
                return;
            };
            let apply: Apply = Box::new(move |view| view.encryption = Some(screen_of(dto)));
            let _ = done.send(Done::Apply { attempt, apply });
        });
    }

    /// Tells the computer which key to seal for. A computer too old to know the method just says so.
    pub(crate) fn share_seal_key(&mut self) {
        let Some(client) = self.client() else {
            return;
        };
        let public = URL_SAFE_NO_PAD.encode(self.seal_key().public_key());
        tokio::spawn(async move {
            let _ = client
                .call("phone.setSealKey", Some(json!({ "publicKey": public })))
                .await;
        });
    }

    fn flip(&mut self, item: &str, enabled: bool) -> bool {
        let Some(screen) = self.view.encryption.as_mut() else {
            return false;
        };
        let Some(row) = screen.items.iter_mut().find(|row| row.item == item) else {
            return false;
        };
        row.enabled = enabled;
        true
    }

    fn set_encryption(&mut self, item: String, enabled: bool) {
        // Moves at once, and goes back only if the server says no.
        if !self.flip(&item, enabled) {
            return;
        }
        let backend = self.deps_backend();
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        tokio::spawn(async move {
            let path = format!("{ENCRYPTION}/{item}");
            let outcome = backend
                .send_json("PUT", &path, json!({ "enabled": enabled }))
                .await;
            let task = move |runner: &mut Runner| match outcome {
                Ok(value) => {
                    if let Ok(dto) = serde_json::from_value::<StatusDto>(value) {
                        runner.view.encryption = Some(screen_of(dto));
                    }
                }
                Err(error) => {
                    runner.flip(&item, !enabled);
                    match error {
                        BackendError::SignedOut => runner.on_signed_out(),
                        BackendError::Failed(message) => runner.view.error = Some(message),
                    }
                }
            };
            let _ = done.send(Done::Run {
                attempt,
                task: Box::new(task),
            });
        });
    }
}

#[uniffi::export]
impl Engine {
    pub fn set_encryption(&self, item: String, enabled: bool) {
        self.run(move |r| r.set_encryption(item, enabled));
    }
}
