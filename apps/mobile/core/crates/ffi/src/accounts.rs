//! Several accounts on one phone (E118). One account is in use at a time, with the hub, the feed
//! and any computer link; the others wait in the secure store with their own tokens, and each one
//! still gets its push notifications. The phone's identity (seed, device id, seal key, passcode,
//! recovery phrases) is shared by all of them and only goes when the last account does.
//!
//! The index lives under `accounts`: which account is in use and, for each, what the screens show
//! and the opaque tag its pushes carry. Tokens live in `tokens:{id}`, and a sign-in waits in
//! `tokens:pending` until the first start tells the phone whose account it is.

use crate::engine::{Command, Done, Engine, Runner};
use crate::labels::ago_label;
use crate::secure::{SecureStore, SlotTokens};
use crate::view::{AccountItem, AuthState, ConfirmView, PushLabelView};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::{AuthError, Session};
use runova_crypto::handshake::os_random;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const INDEX: &str = "accounts";
pub(crate) const PENDING: &str = "tokens:pending";
pub(crate) const ME: &str = "/api/v1/accounts/me";
const CURRENT_SESSION: &str = "/api/v1/sessions/current";
const PUSH_DEVICE: &str = "/api/v1/accounts/me/push-devices/current";
/// How many avatar colours the screens have.
const TONES: i64 = 6;
/// A sign-out never waits longer than this on the network.
const SIGN_OUT_WAIT: Duration = Duration::from_secs(3);
const STILL_LOADING: &str = "This account is still loading. Try again in a moment.";

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct Index {
    pub(crate) active: Option<i64>,
    #[serde(default)]
    pub(crate) items: Vec<Saved>,
}

impl Index {
    fn item(&self, id: i64) -> Option<&Saved> {
        self.items.iter().find(|i| i.id == id)
    }

    fn item_mut(&mut self, id: i64) -> Option<&mut Saved> {
        self.items.iter_mut().find(|i| i.id == id)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Saved {
    pub(crate) id: i64,
    pub(crate) email: String,
    pub(crate) name: String,
    /// Sent with the push token, and back with every push, so the phone knows whose it is.
    pub(crate) tag: String,
    pub(crate) added_ms: u64,
    pub(crate) used_ms: u64,
    /// The start of the hash of the push token last registered for this account.
    #[serde(default)]
    pub(crate) push_sent: Option<String>,
    /// The server ended this account's session: it stays listed until it is signed in again.
    #[serde(default)]
    pub(crate) signed_out: bool,
}

/// Who the website says the tokens belong to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Me {
    id: i64,
    email: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// A tapped push waiting for its account to finish starting.
pub(crate) struct Tap {
    pub(crate) id: Option<i64>,
    pub(crate) category: String,
    pub(crate) item_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct AccountsState {
    /// Bumped whenever another account takes over, so a late start for the old one is dropped.
    pub(crate) generation: u64,
    /// The account starting now came from a sign-in, not from a switch or a cold start.
    joined: bool,
    /// What to say once the account switched to has started.
    after_boot_notice: Option<String>,
    pub(crate) pending_tap: Option<Tap>,
    /// The account the sign-in screen is asking to have signed in again.
    reauth: Option<i64>,
    /// Held by work on an account that is not in use and by a start, so the same refresh token is
    /// never used by two sessions at once (the server ends every session on a reused one).
    pub(crate) token_lock: Arc<tokio::sync::Mutex<()>>,
}

pub(crate) fn slot_of(id: Option<i64>) -> String {
    match id {
        Some(id) => format!("tokens:{id}"),
        None => PENDING.to_owned(),
    }
}

pub(crate) fn read_index(store: &dyn SecureStore) -> Index {
    store
        .get(INDEX.to_owned())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_index(store: &dyn SecureStore, index: &Index) {
    if index.items.is_empty() && index.active.is_none() {
        store.remove(INDEX.to_owned());
        return;
    }
    if let Ok(text) = serde_json::to_string(index) {
        store.set(INDEX.to_owned(), text);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_tag() -> String {
    URL_SAFE_NO_PAD.encode(os_random(16))
}

/// The start of a push token's hash: enough to tell whether it changed, without keeping it.
pub(crate) fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn initials(name: &str, email: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let letters: String = match (words.first(), words.last()) {
        (Some(first), Some(last)) if !name.contains('@') && words.len() > 1 => [first, last]
            .iter()
            .filter_map(|w| w.chars().next())
            .collect(),
        (Some(only), _) if !name.contains('@') => only.chars().next().into_iter().collect(),
        _ => email.chars().next().into_iter().collect(),
    };
    letters.to_uppercase()
}

fn item_view(saved: &Saved, active: bool, now: u64) -> AccountItem {
    AccountItem {
        id: saved.id,
        name: saved.name.clone(),
        email: saved.email.clone(),
        initials: initials(&saved.name, &saved.email),
        tone: saved.id.rem_euclid(TONES) as u8,
        active,
        needs_sign_in: saved.signed_out,
        last_used: if active {
            "In use".to_owned()
        } else {
            format!(
                "Used {}",
                ago_label(now.saturating_sub(saved.used_ms) as i64)
            )
        },
    }
}

/// What a push for `tag` should say it is for: the account's email, but only while the phone holds
/// more than one account. Native code calls this as a push arrives, with the stored index.
#[uniffi::export]
pub fn push_account_label(accounts_json: Option<String>, tag: Option<String>) -> Option<String> {
    let index: Index = serde_json::from_str(&accounts_json?).ok()?;
    let tag = tag?;
    if index.items.len() < 2 {
        return None;
    }
    index
        .items
        .iter()
        .find(|i| i.tag == tag)
        .map(|i| i.email.clone())
}

impl Runner {
    fn accounts_index(&self) -> Index {
        read_index(self.deps.secure.as_ref())
    }

    fn save_accounts(&self, index: &Index) {
        write_index(self.deps.secure.as_ref(), index);
    }

    /// The account in use, `None` while it is not known yet.
    pub(crate) fn active_account(&self) -> Option<i64> {
        self.accounts_index().active
    }

    /// The tag the active account's pushes carry, once it is known.
    pub(crate) fn active_push_tag(&self) -> Option<String> {
        let index = self.accounts_index();
        index
            .active
            .and_then(|id| index.item(id).map(|i| i.tag.clone()))
    }

    pub(crate) fn refresh_accounts_view(&mut self) {
        let index = self.accounts_index();
        let now = now_ms();
        let mut items: Vec<&Saved> = index.items.iter().collect();
        items.sort_by_key(|i| i.added_ms);
        let signed_in = self.view.auth == AuthState::SignedIn;
        let screen = &mut self.view.accounts;
        screen.items = items
            .iter()
            .map(|i| item_view(i, signed_in && index.active == Some(i.id), now))
            .collect();
        let reauth = self.accounts.reauth.or(match self.view.auth {
            AuthState::SignedOut => index
                .active
                .filter(|id| index.item(*id).is_some_and(|i| i.signed_out)),
            _ => None,
        });
        screen.reauth = reauth.and_then(|id| index.item(id).map(|i| item_view(i, false, now)));
        screen.push_labels = if index.items.len() > 1 {
            items
                .iter()
                .map(|i| PushLabelView {
                    tag: i.tag.clone(),
                    label: i.email.clone(),
                })
                .collect()
        } else {
            Vec::new()
        };
    }

    /// A session for a sign-in on its way: its tokens wait in the pending slot, away from the
    /// account in use, until it has worked.
    pub(crate) fn sign_in_session(&self) -> Arc<Session> {
        Arc::new(self.deps.session.sibling(SlotTokens::new(
            self.deps.secure.clone(),
            PENDING.to_owned(),
        )))
    }

    /// A sign-in worked. Whatever account was in use steps aside and the new one starts; who it
    /// is comes back with the start.
    pub(crate) fn signed_in(&mut self) {
        self.view.accounts.adding = false;
        self.view.error = None;
        if self.view.auth == AuthState::SignedIn {
            self.reset_account_state();
        } else {
            self.accounts.generation += 1;
        }
        self.accounts.reauth = None;
        self.accounts.after_boot_notice = None;
        let mut index = self.accounts_index();
        index.active = None;
        self.save_accounts(&index);
        self.accounts.joined = true;
        self.view.auth = AuthState::SignedIn;
        self.refresh_accounts_view();
        self.boot();
    }

    /// The website said whose tokens these are. A sign-in becomes an account here, joining the
    /// one already listed if it is the same person.
    pub(crate) fn identified(&mut self, me: Me) {
        let mut index = self.accounts_index();
        let joined = std::mem::take(&mut self.accounts.joined);
        let now = now_ms();
        if index.active.is_none() {
            let earlier = index.item(me.id).map(|i| i.signed_out);
            let others = index.items.iter().filter(|i| i.id != me.id).count();
            self.deps.tokens.rename(slot_of(Some(me.id)));
            index.active = Some(me.id);
            if joined {
                self.view.notice = match earlier {
                    Some(false) => Some(format!("You were already signed in to {}.", me.email)),
                    None if others > 0 => Some(format!("Added {}.", me.email)),
                    _ => None,
                };
            }
        } else if index.active != Some(me.id) {
            return;
        }
        let name = me
            .display_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| me.email.clone());
        match index.item_mut(me.id) {
            Some(item) => {
                item.email = me.email;
                item.name = name;
                item.used_ms = now;
                item.signed_out = false;
            }
            None => index.items.push(Saved {
                id: me.id,
                email: me.email,
                name,
                tag: new_tag(),
                added_ms: now,
                used_ms: now,
                push_sent: None,
                signed_out: false,
            }),
        }
        self.save_accounts(&index);
        self.refresh_accounts_view();
    }

    /// A start finished for the account in use.
    pub(crate) fn account_started(&mut self) {
        self.view.accounts.switching = None;
        if let Some(notice) = self.accounts.after_boot_notice.take() {
            self.view.notice = Some(notice);
        }
        if let Some(tap) = self.accounts.pending_tap.take() {
            self.route_tap(tap.id, tap.category, tap.item_id);
        }
    }

    /// The session in use ended without the person asking: keep the account listed, to be signed
    /// in again.
    pub(crate) fn mark_active_signed_out(&mut self) {
        let mut index = self.accounts_index();
        if let Some(id) = index.active
            && let Some(item) = index.item_mut(id)
        {
            item.signed_out = true;
            item.push_sent = None;
            self.save_accounts(&index);
        }
    }

    fn add_account(&mut self) {
        if self.view.auth != AuthState::SignedIn {
            return;
        }
        if self.active_account().is_none() {
            self.view.notice = Some(STILL_LOADING.to_owned());
            return;
        }
        self.view.error = None;
        self.view.accounts.adding = true;
    }

    fn cancel_add_account(&mut self) {
        self.stop_sign_ins();
        self.view.accounts.adding = false;
        self.view.error = None;
        if self.view.auth == AuthState::SignedIn {
            self.accounts.reauth = None;
        }
        self.refresh_accounts_view();
    }

    pub(crate) fn stop_sign_ins(&mut self) {
        self.stop_qr();
        self.stop_passkey();
        self.stop_provider_sign_in();
    }

    pub(crate) fn switch_account(&mut self, id: i64) {
        let index = self.accounts_index();
        let Some(item) = index.item(id).cloned() else {
            return;
        };
        let signed_in = self.view.auth == AuthState::SignedIn;
        if item.signed_out {
            // Its session ended: the sign-in screen asks for this account.
            self.accounts.reauth = Some(id);
            if signed_in {
                self.view.accounts.adding = true;
            }
            self.refresh_accounts_view();
            return;
        }
        if signed_in && index.active == Some(id) {
            self.view.accounts.adding = false;
            return;
        }
        if signed_in && self.transfers_busy() {
            self.ask(
                ConfirmView {
                    title: format!("Switch to {}?", item.email),
                    detail: "Files on their way stop when you switch accounts.".to_owned(),
                    action: "Switch".to_owned(),
                    danger: false,
                },
                move |r| r.do_switch(id),
            );
            return;
        }
        self.do_switch(id);
    }

    fn do_switch(&mut self, id: i64) {
        self.stop_sign_ins();
        self.view.accounts.adding = false;
        self.view.error = None;
        self.accounts.reauth = None;
        self.reset_account_state();
        let mut index = self.accounts_index();
        let Some(item) = index.item_mut(id) else {
            return;
        };
        item.used_ms = now_ms();
        let email = item.email.clone();
        index.active = Some(id);
        self.save_accounts(&index);
        self.accounts.after_boot_notice = Some(format!("Now using {email}."));
        self.view.auth = AuthState::SignedIn;
        self.refresh_accounts_view();
        self.view.accounts.switching = self
            .view
            .accounts
            .items
            .iter()
            .find(|i| i.id == id)
            .cloned();
        self.boot();
    }

    /// A session for an account that is not in use, on its own tokens.
    fn session_for(&self, id: i64) -> Arc<Session> {
        Arc::new(
            self.deps
                .session
                .sibling(SlotTokens::new(self.deps.secure.clone(), slot_of(Some(id)))),
        )
    }

    /// Signs out of `target`, or of the account in use when it is `None`. The last account going
    /// clears the phone, as signing out always did before there could be more than one.
    pub(crate) async fn sign_out_account_now(&mut self, target: Option<i64>) {
        let index = self.accounts_index();
        let active = index.active;
        let target = target.or(active);
        if target != active {
            if let Some(id) = target {
                self.sign_out_in_background(id).await;
            }
            return;
        }
        if index.items.iter().all(|i| Some(i.id) == active) {
            self.sign_out_fully().await;
            self.on_signed_out();
            return;
        }
        let email = active
            .and_then(|id| index.item(id).map(|i| i.email.clone()))
            .unwrap_or_else(|| "this account".to_owned());
        let backend = self.deps_backend();
        let _ = tokio::time::timeout(
            SIGN_OUT_WAIT,
            backend.send_json("DELETE", CURRENT_SESSION, json!({})),
        )
        .await;
        self.deps.session.sign_out().await;
        let mut index = self.accounts_index();
        index.items.retain(|i| Some(i.id) != active);
        let next = index
            .items
            .iter()
            .filter(|i| !i.signed_out)
            .max_by_key(|i| i.used_ms)
            .or_else(|| index.items.iter().max_by_key(|i| i.used_ms))
            .cloned();
        let Some(next) = next else {
            return;
        };
        index.active = Some(next.id);
        self.save_accounts(&index);
        if next.signed_out {
            self.reset_account_state();
            let tokens = self.deps.tokens.clone();
            self.deps
                .session
                .switch(|| tokens.point_at(slot_of(Some(next.id))))
                .await;
            self.view.auth = AuthState::SignedOut;
            self.view.notice = Some(format!("Signed out of {email}."));
            self.refresh_accounts_view();
            return;
        }
        self.do_switch(next.id);
        self.accounts.after_boot_notice =
            Some(format!("Signed out of {email}. Now using {}.", next.email));
    }

    async fn sign_out_in_background(&mut self, id: i64) {
        let index = self.accounts_index();
        let Some(item) = index.item(id).cloned() else {
            return;
        };
        let session = self.session_for(id);
        let backend = self.deps_backend();
        let lock = self.accounts.token_lock.clone();
        let _ = tokio::time::timeout(SIGN_OUT_WAIT, async move {
            let _held = lock.lock().await;
            if let Ok(token) = session.access_token().await {
                let _ = backend
                    .send_json_as(&token, "DELETE", CURRENT_SESSION, json!({}))
                    .await;
            }
        })
        .await;
        self.deps.secure.remove(slot_of(Some(id)));
        let mut index = self.accounts_index();
        index.items.retain(|i| i.id != id);
        self.save_accounts(&index);
        if self.accounts.reauth == Some(id) {
            self.accounts.reauth = None;
        }
        self.view.notice = Some(format!("Signed out of {}.", item.email));
        self.refresh_accounts_view();
    }

    /// Ends every account's session, then clears the phone.
    pub(crate) async fn sign_out_all_now(&mut self) {
        let index = self.accounts_index();
        let backend = self.deps_backend();
        let mut ending = tokio::task::JoinSet::new();
        for item in index.items.iter().filter(|i| Some(i.id) != index.active) {
            let session = self.session_for(item.id);
            let backend = backend.clone();
            ending.spawn(async move {
                if let Ok(token) = session.access_token().await {
                    let _ = backend
                        .send_json_as(&token, "DELETE", CURRENT_SESSION, json!({}))
                        .await;
                }
            });
        }
        let _ = tokio::time::timeout(SIGN_OUT_WAIT, ending.join_all()).await;
        self.sign_out_fully().await;
        self.on_signed_out();
    }

    /// Part of clearing the phone: every account's tokens and the index.
    pub(crate) fn forget_accounts(&mut self) {
        let index = self.accounts_index();
        for item in &index.items {
            self.deps.secure.remove(slot_of(Some(item.id)));
        }
        self.deps.secure.remove(PENDING.to_owned());
        self.deps.secure.remove(INDEX.to_owned());
        self.deps.tokens.point_at(PENDING.to_owned());
        self.accounts.reauth = None;
        self.accounts.pending_tap = None;
        self.accounts.after_boot_notice = None;
    }

    pub(crate) fn push_sent(&mut self, id: i64, hash: String) {
        let mut index = self.accounts_index();
        if let Some(item) = index.item_mut(id) {
            item.push_sent = Some(hash);
            self.save_accounts(&index);
        }
    }

    fn background_signed_out(&mut self, id: i64) {
        let mut index = self.accounts_index();
        if Some(id) != index.active
            && let Some(item) = index.item_mut(id)
        {
            item.signed_out = true;
            item.push_sent = None;
            self.save_accounts(&index);
            self.refresh_accounts_view();
        }
    }

    /// Registers the push token for each account not in use that does not have it yet, so every
    /// account on the phone gets its notifications.
    pub(crate) fn push_to_others(&mut self) {
        let Some(token) = self.push_token.clone() else {
            return;
        };
        let hash = token_hash(&token);
        let index = self.accounts_index();
        let platform = self.platform_name();
        let seal_key_id = self.seal_key().key_id();
        let backend = self.deps_backend();
        for item in index.items.iter().filter(|i| {
            Some(i.id) != index.active && !i.signed_out && i.push_sent.as_ref() != Some(&hash)
        }) {
            let session = self.session_for(item.id);
            let lock = self.accounts.token_lock.clone();
            let backend = backend.clone();
            let done = self.done_tx.clone();
            let (id, hash) = (item.id, hash.clone());
            let body = json!({
                "platform": platform,
                "pushToken": token,
                "sealKeyId": seal_key_id,
                "accountTag": item.tag,
            });
            tokio::spawn(async move {
                let _held = lock.lock().await;
                let task: crate::engine::Task = match session.access_token().await {
                    Ok(access) => {
                        if backend
                            .send_json_as(&access, "PUT", PUSH_DEVICE, body)
                            .await
                            .is_err()
                        {
                            return;
                        }
                        Box::new(move |r: &mut Runner| r.push_sent(id, hash))
                    }
                    Err(AuthError::SignedOut) => {
                        Box::new(move |r: &mut Runner| r.background_signed_out(id))
                    }
                    Err(_) => return,
                };
                let _ = done.send(Done::Local(task));
            });
        }
    }

    /// A push tapped for an account not in use switches to it, then opens what it is about.
    pub(crate) fn tapped_for(&mut self, tag: &str, tap: Tap) -> bool {
        let index = self.accounts_index();
        let Some(item) = index.items.iter().find(|i| i.tag == tag) else {
            return false;
        };
        if index.active == Some(item.id) && self.view.auth == AuthState::SignedIn {
            return false;
        }
        if item.signed_out {
            self.switch_account(item.id);
            return true;
        }
        self.accounts.pending_tap = Some(tap);
        self.switch_account(item.id);
        true
    }
}

#[uniffi::export]
impl Engine {
    /// Shows the sign-in screen over the account in use, which stays signed in. A sign-in there
    /// adds an account and switches to it.
    pub fn add_account(&self) {
        self.run(Runner::add_account);
    }

    pub fn cancel_add_account(&self) {
        self.run(Runner::cancel_add_account);
    }

    /// Uses account `id` from now on. One whose session ended goes to the sign-in screen instead.
    pub fn switch_account(&self, id: i64) {
        self.run(move |r| r.switch_account(id));
    }

    /// Asks first, then signs out of account `id`, in use or not.
    pub fn sign_out_account(&self, id: i64) {
        self.run(move |r| {
            let index = r.accounts_index();
            let Some(item) = index.item(id) else {
                return;
            };
            let last = index.items.len() == 1;
            r.ask(
                ConfirmView {
                    title: format!("Sign out of {}?", item.email),
                    detail: if last {
                        "This is the only account on this phone, so its passcode and recovery phrases go too.".to_owned()
                    } else {
                        "Your other accounts stay signed in.".to_owned()
                    },
                    action: "Sign out".to_owned(),
                    danger: last,
                },
                move |r| r.queue(Command::SignOutAccount(id)),
            );
        });
    }

    /// Asks first, then signs out of every account and clears the phone.
    pub fn sign_out_all(&self) {
        self.run(|r| {
            r.ask(
                ConfirmView {
                    title: "Sign out of all accounts?".to_owned(),
                    detail: "Every account on this phone is signed out, and the passcode and recovery phrases are removed.".to_owned(),
                    action: "Sign out of all".to_owned(),
                    danger: true,
                },
                |r| r.queue(Command::SignOutAll),
            );
        });
    }
}
