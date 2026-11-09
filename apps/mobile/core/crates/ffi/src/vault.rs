//! The computer's Vault. A revealed value lives only in the view, and is wiped when it goes.

use crate::engine::{Engine, Runner};
use crate::view::{
    AppView, BiometricRequestView, ConfirmView, RevealedSecretView, VaultEntryView, VaultLockState,
    VaultScreen, VaultSecretField,
};
use runova_rpc::RpcError;
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusDto {
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlockDto {
    ok: bool,
    reason: Option<String>,
    #[serde(default)]
    retry_after_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldDto {
    id: String,
    label: String,
    concealed: bool,
    has_value: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryDto {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    title: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    service: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    has_password: bool,
    #[serde(default)]
    has_totp: bool,
    #[serde(default)]
    has_secret: bool,
    #[serde(default)]
    has_notes: bool,
    #[serde(default)]
    fields: Vec<FieldDto>,
}

#[derive(Deserialize)]
struct RevealDto {
    value: String,
}

/// Wiped when it ends up unused. What the link and JSON layers held on the way here is not.
impl Drop for RevealDto {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn named(key: &str, label: &str) -> VaultSecretField {
    VaultSecretField {
        key: key.to_owned(),
        label: label.to_owned(),
        custom: false,
    }
}

fn entry_of(dto: EntryDto) -> VaultEntryView {
    let mut secrets = Vec::new();
    if dto.has_password {
        secrets.push(named("password", "Password"));
    }
    if dto.has_totp {
        secrets.push(named("totpSecret", "Two-factor secret"));
    }
    if dto.has_secret {
        secrets.push(named("secret", "Secret"));
    }
    if dto.has_notes {
        secrets.push(named("notes", "Notes"));
    }
    secrets.extend(
        dto.fields
            .into_iter()
            .filter(|f| f.concealed && f.has_value)
            .map(|f| VaultSecretField {
                key: f.id,
                label: f.label,
                custom: true,
            }),
    );
    VaultEntryView {
        editable: dto.kind == "login",
        id: dto.id,
        title: dto.title,
        subtitle: [dto.username, dto.service, dto.host]
            .into_iter()
            .find(|text| !text.is_empty()),
        favorite: dto.favorite,
        secrets,
    }
}

fn state_of(state: &str) -> VaultLockState {
    match state {
        "uninitialized" => VaultLockState::Uninitialized,
        "locked" => VaultLockState::Locked,
        "unlocked" => VaultLockState::Unlocked,
        _ => VaultLockState::Unknown,
    }
}

fn unlock_message(reason: Option<&str>, retry_after_ms: u64) -> String {
    match reason {
        Some("wrong-password") => "That password isn't right.".to_owned(),
        Some("throttled") => {
            format!(
                "Too many tries. Wait {} seconds.",
                retry_after_ms.div_ceil(1000)
            )
        }
        _ => "The vault is busy. Try again.".to_owned(),
    }
}

pub(crate) struct PendingReveal {
    field: String,
    custom: bool,
    label: String,
}

impl Runner {
    pub(crate) fn refresh_vault(&mut self) {
        self.view.vault.loading = self.view.vault.state == VaultLockState::Unknown;
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        self.call(
            "vault.status",
            None,
            move |view: &mut AppView, dto: StatusDto| {
                view.vault.loading = false;
                let state = state_of(&dto.state);
                let unlocked = state == VaultLockState::Unlocked;
                view.vault.state = state;
                // The computer locks on its own: idle, the screen locking, or someone at it.
                if unlocked {
                    let _ = done.send(crate::engine::Done::Run {
                        attempt,
                        task: Box::new(Runner::load_vault_list_once),
                    });
                } else {
                    let _ = done.send(crate::engine::Done::Run {
                        attempt,
                        task: Box::new(Runner::vault_is_locked),
                    });
                }
            },
            |view| view.vault.loading = false,
        );
    }

    fn load_vault_list_once(&mut self) {
        if self.view.vault.entries.is_empty() && !self.vault_listing {
            self.load_vault_list();
        }
    }

    fn load_vault_list(&mut self) {
        self.vault_listing = true;
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        let finished = move || {
            let _ = done.send(crate::engine::Done::Run {
                attempt,
                task: Box::new(|runner: &mut Runner| runner.vault_listing = false),
            });
        };
        let failed = finished.clone();
        self.call(
            "vault.list",
            None,
            move |view: &mut AppView, items: Vec<EntryDto>| {
                // A reply still on its way when the vault locked must not bring the list back.
                if view.vault.state == VaultLockState::Unlocked {
                    view.vault.entries = items.into_iter().map(entry_of).collect();
                }
                finished();
            },
            move |_| failed(),
        );
    }

    fn vault_is_locked(&mut self) {
        self.forget_secret();
        self.view.vault.entries.clear();
        self.view.vault.open_entry = None;
        self.view.vault.biometric = None;
        self.pending_reveal = None;
    }

    /// Wipes the value from the copies the engine holds. The JVM or Swift copy it published can't
    /// be reached from here, and goes when that side frees it.
    pub(crate) fn forget_secret(&mut self) {
        if let Some(mut secret) = self.view.vault.revealed.take() {
            secret.value.zeroize();
        }
        // Wiped in place and kept, or the view would look unchanged and never reach the screen.
        if let Some(secret) = self
            .published
            .as_mut()
            .and_then(|view| view.vault.revealed.as_mut())
        {
            secret.value.zeroize();
        }
    }

    pub(crate) fn clear_vault(&mut self) {
        self.forget_secret();
        self.pending_reveal = None;
        self.vault_listing = false;
        self.view.vault = VaultScreen::default();
    }

    fn vault_unlock(&mut self, password: String) {
        let Some(client) = self.client() else {
            return;
        };
        self.view.vault.unlock_error = None;
        self.view.busy = true;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let mut params = json!({ "password": password });
            let outcome = client.call("vault.unlock", Some(params.clone())).await;
            if let Some(Value::String(sent)) = params.get_mut("password") {
                sent.zeroize();
            }
            let task = move |runner: &mut Runner| {
                runner.view.busy = false;
                match outcome.map(serde_json::from_value::<UnlockDto>) {
                    Ok(Ok(UnlockDto { ok: true, .. })) => runner.refresh_vault(),
                    Ok(Ok(dto)) => {
                        runner.view.vault.unlock_error =
                            Some(unlock_message(dto.reason.as_deref(), dto.retry_after_ms));
                    }
                    Ok(Err(_)) | Err(RpcError::Closed) => {}
                    Err(error) => runner.view.vault.unlock_error = Some(error.to_string()),
                }
            };
            let _ = done.send(crate::engine::Done::Run {
                attempt,
                task: Box::new(task),
            });
        });
    }

    fn vault_lock(&mut self) {
        self.vault_is_locked();
        self.view.vault.state = VaultLockState::Locked;
        self.call(
            "vault.lock",
            None,
            |view: &mut AppView, _: Value| view.vault.state = VaultLockState::Locked,
            |_| {},
        );
    }

    fn request_reveal(&mut self, field: String, custom: bool) {
        let Some(entry) = self.open_vault_entry() else {
            return;
        };
        let Some(secret) = entry
            .secrets
            .iter()
            .find(|s| s.key == field && s.custom == custom)
            .cloned()
        else {
            return;
        };
        self.biometric_serial = self.biometric_serial.wrapping_add(1);
        self.view.vault.biometric = Some(BiometricRequestView {
            id: self.biometric_serial,
            reason: format!("Reveal {} for {}", secret.label, entry.title),
        });
        self.pending_reveal = Some(PendingReveal {
            field,
            custom,
            label: secret.label,
        });
    }

    fn open_vault_entry(&self) -> Option<VaultEntryView> {
        let id = self.view.vault.open_entry.as_ref()?;
        self.view
            .vault
            .entries
            .iter()
            .find(|e| &e.id == id)
            .cloned()
    }

    fn biometric_result(&mut self, id: u64, confirmed: bool) {
        if self.view.vault.biometric.as_ref().map(|b| b.id) != Some(id) {
            return;
        }
        self.view.vault.biometric = None;
        let pending = self.pending_reveal.take();
        if !confirmed {
            self.view.error =
                Some("Couldn't confirm it's you, so nothing was revealed.".to_owned());
            return;
        }
        let (Some(pending), Some(entry)) = (pending, self.view.vault.open_entry.clone()) else {
            return;
        };
        self.forget_secret();
        let field = if pending.custom {
            json!({ "customFieldId": pending.field })
        } else {
            Value::String(pending.field)
        };
        let asked_for = entry.clone();
        let label = pending.label;
        self.call(
            "vault.reveal",
            Some(json!({ "id": entry, "field": field })),
            move |view: &mut AppView, mut dto: RevealDto| {
                // Still looking at this entry and still on this screen, or it is dropped and wiped.
                let wanted = view.vault.on_show
                    && !view.vault.in_background
                    && view.vault.open_entry.as_deref() == Some(&asked_for);
                if wanted {
                    view.vault.revealed = Some(RevealedSecretView {
                        label,
                        value: std::mem::take(&mut dto.value),
                    });
                }
            },
            |_| {},
        );
    }

    fn vault_save(
        &mut self,
        id: Option<String>,
        title: String,
        username: Option<String>,
        password: Option<String>,
    ) {
        let mut params = json!({ "title": title });
        if let Some(id) = id {
            params["id"] = Value::String(id);
        }
        if let Some(username) = username {
            params["username"] = Value::String(username);
        }
        if let Some(password) = password {
            params["password"] = Value::String(password);
        }
        self.op_value("vault.save", params, "Saved.", Self::load_vault_list);
    }

    fn vault_remove(&mut self, id: String) {
        self.ask(
            ConfirmView {
                title: "Delete this entry?".to_owned(),
                detail: "It's removed from the vault on this computer.".to_owned(),
                action: "Delete".to_owned(),
                danger: true,
            },
            move |runner| {
                runner.forget_secret();
                runner.view.vault.open_entry = None;
                runner.op_value(
                    "vault.remove",
                    json!({ "id": id }),
                    "Deleted.",
                    Self::load_vault_list,
                );
            },
        );
    }

    /// Runs a change that answers with data rather than `{ok, message}`.
    fn op_value(
        &mut self,
        method: &'static str,
        params: Value,
        notice: &'static str,
        after: fn(&mut Runner),
    ) {
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        self.view.busy = true;
        self.call(
            method,
            Some(params),
            move |view: &mut AppView, _: Value| {
                view.busy = false;
                view.notice = Some(notice.to_owned());
                let _ = done.send(crate::engine::Done::Run {
                    attempt,
                    task: Box::new(after),
                });
            },
            |view| view.busy = false,
        );
    }
}

#[uniffi::export]
impl Engine {
    pub fn vault_unlock(&self, password: String) {
        self.run(move |r| r.vault_unlock(password));
    }

    pub fn vault_lock(&self) {
        self.run(Runner::vault_lock);
    }

    pub fn vault_open_entry(&self, id: String) {
        self.run(move |r| {
            r.forget_secret();
            r.view.vault.open_entry = Some(id);
        });
    }

    pub fn vault_close_entry(&self) {
        self.run(|r| {
            r.forget_secret();
            r.view.vault.open_entry = None;
            r.view.vault.biometric = None;
            r.pending_reveal = None;
        });
    }

    /// Puts up the phone's own check. The value is only asked for once that passes.
    pub fn vault_request_reveal(&self, field: String, custom: bool) {
        self.run(move |r| r.request_reveal(field, custom));
    }

    pub fn biometric_result(&self, id: u64, confirmed: bool) {
        self.run(move |r| r.biometric_result(id, confirmed));
    }

    pub fn vault_hide(&self) {
        self.run(Runner::forget_secret);
    }

    pub fn vault_save(
        &self,
        id: Option<String>,
        title: String,
        username: Option<String>,
        password: Option<String>,
    ) {
        self.run(move |r| r.vault_save(id, title, username, password));
    }

    pub fn vault_remove(&self, id: String) {
        self.run(move |r| r.vault_remove(id));
    }
}
