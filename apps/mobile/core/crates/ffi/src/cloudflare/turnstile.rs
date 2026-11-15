//! Turnstile and the Servers tab (E101): a domain's widgets, made, changed and deleted, a widget's
//! secret shown only after the phone's own check, and the DNS tokens the domain's servers hold for
//! wildcard certificates. A secret leaves the computer only when it is asked for, and is wiped from
//! memory as soon as it is off the screen.

use super::{OkDto, Pending, asking};
use crate::engine::{Engine, Runner};
use crate::view::{
    CloudflareDnsServerView, CloudflareOptionView, CloudflareRevealedSecretView,
    CloudflareWidgetFormView, CloudflareWidgetView, WidgetDraft,
};
use serde::Deserialize;
use serde_json::json;
use zeroize::{Zeroize, Zeroizing};

const SCRIPT: &str = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const NOT_CONFIRMED_SECRET: &str = "Couldn't confirm it's you, so the secret stays hidden.";
const NOT_CONFIRMED_TOKEN: &str = "Couldn't confirm it's you, so the token wasn't sent.";

const MODES: [(&str, &str); 3] = [
    ("managed", "Managed"),
    ("non-interactive", "Non-interactive"),
    ("invisible", "Invisible"),
];
const CLEARANCES: [(&str, &str); 4] = [
    ("no_clearance", "Off"),
    ("jschallenge", "Non-interactive"),
    ("managed", "Managed"),
    ("interactive", "Interactive"),
];
const REGIONS: [(&str, &str); 2] = [("world", "Worldwide"), ("china", "China")];

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct WidgetDto {
    sitekey: String,
    name: String,
    #[serde(default)]
    domains: Vec<String>,
    mode: String,
    clearance: String,
    #[serde(default = "world")]
    region: String,
    #[serde(default)]
    offlabel: bool,
    #[serde(default)]
    ephemeral_id: bool,
}

fn world() -> String {
    "world".to_owned()
}

#[derive(Deserialize)]
struct WithWidget {
    widget: WidgetDto,
}

#[derive(Deserialize)]
struct SecretDto {
    secret: String,
}

#[derive(Deserialize)]
struct ServerDto {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DnsTokenDto {
    zone: String,
    #[serde(default)]
    made_here: bool,
}

fn options(list: &[(&str, &str)]) -> Vec<CloudflareOptionView> {
    list.iter()
        .map(|(value, label)| CloudflareOptionView {
            value: (*value).to_owned(),
            label: (*label).to_owned(),
        })
        .collect()
}

fn label_of<'a>(list: &[(&'a str, &'a str)], value: &'a str) -> &'a str {
    list.iter()
        .find(|(v, _)| *v == value)
        .map_or(value, |(_, label)| label)
}

/// The HTML that puts the widget on a page, as the desktop's snippet writes it.
fn snippet(sitekey: &str) -> String {
    format!(
        "<script src=\"{SCRIPT}\" async defer></script>\n\n<form action=\"/submit\" method=\"post\">\n  <div class=\"cf-turnstile\" data-sitekey=\"{sitekey}\"></div>\n  <button type=\"submit\">Send</button>\n</form>"
    )
}

fn widget_view(widget: &WidgetDto) -> CloudflareWidgetView {
    CloudflareWidgetView {
        sitekey: widget.sitekey.clone(),
        name: widget.name.clone(),
        domains: widget.domains.clone(),
        mode_label: label_of(&MODES, &widget.mode).to_owned(),
        clearance_label: label_of(&CLEARANCES, &widget.clearance).to_owned(),
        snippet: snippet(&widget.sitekey),
    }
}

fn draft_of(widget: &WidgetDto) -> WidgetDraft {
    WidgetDraft {
        name: widget.name.clone(),
        domains: widget.domains.clone(),
        mode: widget.mode.clone(),
        clearance: widget.clearance.clone(),
        region: widget.region.clone(),
        offlabel: widget.offlabel,
        ephemeral_id: widget.ephemeral_id,
    }
}

/// Names as Cloudflare keeps them: trimmed, lower case, each once.
fn clean_domains(domains: &[String]) -> Vec<String> {
    let mut clean: Vec<String> = Vec::new();
    for domain in domains {
        let domain = domain.trim().trim_end_matches('.').to_lowercase();
        if !domain.is_empty() && !clean.contains(&domain) {
            clean.push(domain);
        }
    }
    clean
}

fn server_detail(has_token: bool, made_here: bool, zone: &str) -> String {
    match (has_token, made_here) {
        (true, true) => {
            format!("Holds a token Runova made for {zone}, for wildcard certificates.")
        }
        (true, false) => format!("Holds a token you pasted for {zone}, for wildcard certificates."),
        _ => format!("No DNS token for {zone}, so no wildcard certificates."),
    }
}

impl Runner {
    pub(super) fn load_widgets(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        if let Some(view) = self.view.cloudflare.zone.as_mut()
            && view.turnstile.widgets.is_empty()
        {
            view.turnstile.loading = true;
        }
        let asked = zone.clone();
        self.cf(
            "cloudflare.turnstileWidgets",
            Some(json!({ "zoneId": zone })),
            move |r, result: Result<Vec<WidgetDto>, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                match result {
                    Ok(widgets) => r.keep_widgets(widgets),
                    Err(problem) => {
                        if let Some(view) = r.view.cloudflare.zone.as_mut() {
                            view.turnstile.loading = false;
                            view.turnstile.problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn keep_widgets(&mut self, widgets: Vec<WidgetDto>) {
        if let Some(view) = self.view.cloudflare.zone.as_mut() {
            view.turnstile.loading = false;
            view.turnstile.problem = None;
            view.turnstile.widgets = widgets.iter().map(widget_view).collect();
        }
        self.cloudflare.widgets = widgets;
    }

    fn keep_widget(&mut self, widget: WidgetDto) {
        let mut widgets = self.cloudflare.widgets.clone();
        match widgets.iter().position(|w| w.sitekey == widget.sitekey) {
            Some(index) => widgets[index] = widget,
            None => widgets.push(widget),
        }
        self.keep_widgets(widgets);
    }

    fn widget(&self, sitekey: &str) -> Option<WidgetDto> {
        self.cloudflare
            .widgets
            .iter()
            .find(|w| w.sitekey == sitekey)
            .cloned()
    }

    fn open_widget_form(&mut self, sitekey: Option<String>) {
        let existing = sitekey.as_deref().and_then(|key| self.widget(key));
        let draft = existing.as_ref().map_or_else(
            || WidgetDraft {
                name: String::new(),
                domains: vec![self.zone_name()],
                mode: "managed".to_owned(),
                clearance: "no_clearance".to_owned(),
                region: "world".to_owned(),
                offlabel: false,
                ephemeral_id: false,
            },
            draft_of,
        );
        self.view.cloudflare.widget_form = Some(CloudflareWidgetFormView {
            sitekey: existing.as_ref().map(|w| w.sitekey.clone()),
            title: if existing.is_some() {
                "Edit widget"
            } else {
                "Add a widget"
            }
            .to_owned(),
            draft,
            modes: options(&MODES),
            clearances: options(&CLEARANCES),
            regions: options(&REGIONS),
            problem: None,
            saving: false,
        });
    }

    fn save_widget(&mut self, draft: WidgetDraft) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let Some(form) = self.view.cloudflare.widget_form.as_mut() else {
            return;
        };
        form.saving = true;
        form.problem = None;
        form.draft = draft.clone();
        let name = draft.name.trim().to_owned();
        let input = json!({
            "name": name,
            "domains": clean_domains(&draft.domains),
            "mode": draft.mode,
            "clearance": draft.clearance,
            "region": draft.region,
            "offlabel": draft.offlabel,
            "ephemeralId": draft.ephemeral_id,
        });
        let fail = |r: &mut Runner, problem: String| {
            if let Some(form) = r.view.cloudflare.widget_form.as_mut() {
                form.saving = false;
                form.problem = Some(problem);
            }
        };
        match form.sitekey.clone() {
            Some(sitekey) => self.cf(
                "cloudflare.updateTurnstileWidget",
                Some(json!({"zoneId": zone, "sitekey": sitekey, "input": input})),
                move |r, result: Result<WidgetDto, String>| match result {
                    Ok(widget) => {
                        r.view.cloudflare.widget_form = None;
                        r.view.notice = Some(format!("Saved the widget {}.", widget.name));
                        r.keep_widget(widget);
                    }
                    Err(problem) => fail(r, problem),
                },
            ),
            None => self.cf(
                "cloudflare.createTurnstileWidget",
                Some(json!({"zoneId": zone, "input": input})),
                move |r, result: Result<WithWidget, String>| match result {
                    Ok(made) => {
                        r.view.cloudflare.widget_form = None;
                        r.view.notice = Some(format!(
                            "Made the widget {}. Reveal its secret when your server needs it.",
                            made.widget.name
                        ));
                        r.keep_widget(made.widget);
                    }
                    Err(problem) => fail(r, problem),
                },
            ),
        }
    }

    fn delete_widget(&mut self, sitekey: String) {
        let (Some(zone), Some(widget)) = (self.zone_id(), self.widget(&sitekey)) else {
            return;
        };
        let name = widget.name;
        self.ask(
            asking(
                format!("Delete the widget {name}?"),
                "Pages that use its site key stop showing the check, and its secret stops working."
                    .to_owned(),
                "Delete widget",
            ),
            move |runner| {
                runner.view.busy = true;
                let asked = sitekey.clone();
                runner.cf(
                    "cloudflare.deleteTurnstileWidget",
                    Some(json!({"zoneId": zone, "sitekey": sitekey})),
                    move |r, result: Result<OkDto, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(done) => {
                                r.view.notice = Some(done.message);
                                let mut widgets = r.cloudflare.widgets.clone();
                                widgets.retain(|w| w.sitekey != asked);
                                r.keep_widgets(widgets);
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }

    fn reveal_secret(&mut self, sitekey: String) {
        let Some(widget) = self.widget(&sitekey) else {
            return;
        };
        self.hide_secret();
        self.ask_biometric(
            format!("Show the secret of {}", widget.name),
            Pending::Secret {
                sitekey,
                name: widget.name,
            },
        );
    }

    pub(super) fn secret_checked(&mut self, sitekey: String, name: String, confirmed: bool) {
        if !confirmed {
            self.view.error = Some(NOT_CONFIRMED_SECRET.to_owned());
            return;
        }
        let Some(zone) = self.zone_id() else {
            return;
        };
        let asked = sitekey.clone();
        self.cf(
            "cloudflare.turnstileSecret",
            Some(json!({"zoneId": zone, "sitekey": sitekey})),
            move |r, result: Result<SecretDto, String>| match result {
                Ok(mut found) => {
                    // Still on the widget's tab, or it is dropped and wiped.
                    let wanted = r
                        .view
                        .cloudflare
                        .zone
                        .as_ref()
                        .is_some_and(|z| z.tab == crate::view::CloudflareTab::Turnstile);
                    if wanted {
                        r.view.cloudflare.revealed_secret = Some(CloudflareRevealedSecretView {
                            sitekey: asked,
                            name,
                            value: std::mem::take(&mut found.secret),
                        });
                    } else {
                        found.secret.zeroize();
                    }
                }
                Err(problem) => r.view.error = Some(problem),
            },
        );
    }

    pub(super) fn hide_secret(&mut self) {
        if let Some(mut secret) = self.view.cloudflare.revealed_secret.take() {
            secret.value.zeroize();
        }
    }

    fn rotate_secret(&mut self, sitekey: String, now: bool) {
        let (Some(zone), Some(widget)) = (self.zone_id(), self.widget(&sitekey)) else {
            return;
        };
        let name = widget.name;
        let detail = if now {
            "The old secret stops working at once, so your server needs the new one before the next check."
        } else {
            "The old secret keeps working for two hours, while your server moves to the new one."
        };
        self.ask(
            asking(
                format!("Rotate the secret of {name}?"),
                detail.to_owned(),
                "Rotate",
            ),
            move |runner| {
                runner.hide_secret();
                runner.view.busy = true;
                runner.cf(
                    "cloudflare.rotateTurnstileSecret",
                    Some(json!({"zoneId": zone, "sitekey": sitekey, "now": now})),
                    move |r, result: Result<WithWidget, String>| {
                        r.view.busy = false;
                        match result {
                            Ok(rotated) => {
                                r.view.notice = Some(format!(
                                    "Rotated the secret of {name}. Reveal it to copy the new one."
                                ));
                                r.keep_widget(rotated.widget);
                            }
                            Err(problem) => r.view.error = Some(problem),
                        }
                    },
                );
            },
        );
    }

    pub(super) fn load_dns_servers(&mut self) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        if let Some(view) = self.view.cloudflare.zone.as_mut()
            && view.servers.servers.is_empty()
        {
            view.servers.loading = true;
        }
        let asked = zone;
        self.cf(
            "cloudflare.servers",
            None,
            move |r, result: Result<Vec<ServerDto>, String>| {
                if r.zone_id().as_deref() != Some(asked.as_str()) {
                    return;
                }
                let zone_name = r.zone_name();
                let Some(view) = r.view.cloudflare.zone.as_mut() else {
                    return;
                };
                view.servers.loading = false;
                match result {
                    Ok(servers) => {
                        let before = std::mem::take(&mut view.servers.servers);
                        view.servers.problem = None;
                        view.servers.servers = servers
                            .iter()
                            .map(|s| {
                                before.iter().find(|b| b.id == s.id).cloned().unwrap_or(
                                    CloudflareDnsServerView {
                                        id: s.id.clone(),
                                        name: s.name.clone(),
                                        has_token: false,
                                        made_here: false,
                                        detail: server_detail(false, false, &zone_name),
                                        loading: true,
                                        busy: false,
                                        problem: None,
                                    },
                                )
                            })
                            .collect();
                        for server in servers {
                            r.load_dns_tokens(server.id);
                        }
                    }
                    Err(problem) => view.servers.problem = Some(problem),
                }
            },
        );
    }

    fn dns_server(&mut self, id: &str) -> Option<&mut CloudflareDnsServerView> {
        self.view
            .cloudflare
            .zone
            .as_mut()
            .and_then(|z| z.servers.servers.iter_mut().find(|s| s.id == id))
    }

    fn load_dns_tokens(&mut self, server_id: String) {
        let asked = server_id.clone();
        self.cf(
            "cloudflare.dnsTokens",
            Some(json!({ "serverId": server_id })),
            move |r, result: Result<Vec<DnsTokenDto>, String>| {
                let zone = r.zone_name();
                let Some(server) = r.dns_server(&asked) else {
                    return;
                };
                server.loading = false;
                match result {
                    Ok(tokens) => {
                        let held = tokens.iter().find(|t| t.zone == zone);
                        server.has_token = held.is_some();
                        server.made_here = held.is_some_and(|t| t.made_here);
                        server.detail = server_detail(server.has_token, server.made_here, &zone);
                        server.problem = None;
                    }
                    Err(problem) => server.problem = Some(problem),
                }
            },
        );
    }

    fn provision(&mut self, server_id: String, params: serde_json::Value) {
        if let Some(server) = self.dns_server(&server_id) {
            server.busy = true;
            server.problem = None;
        }
        let asked = server_id;
        self.cf(
            "cloudflare.provisionDnsToken",
            Some(params),
            move |r, result: Result<OkDto, String>| {
                if let Some(server) = r.dns_server(&asked) {
                    server.busy = false;
                }
                match result {
                    Ok(done) => {
                        r.view.notice = Some(done.message);
                        r.load_dns_tokens(asked);
                    }
                    Err(problem) => {
                        if let Some(server) = r.dns_server(&asked) {
                            server.problem = Some(problem);
                        }
                    }
                }
            },
        );
    }

    fn dns_token_mint(&mut self, server_id: String) {
        let Some(zone) = self.zone_id() else {
            return;
        };
        let params = json!({"serverId": server_id, "zoneId": zone, "mode": "mint"});
        self.provision(server_id, params);
    }

    fn dns_token_paste(&mut self, server_id: String, token: String) {
        let token = Zeroizing::new(token);
        let Some(zone) = self.zone_id() else {
            return;
        };
        let trimmed = Zeroizing::new(token.trim().to_owned());
        if trimmed.is_empty() {
            return;
        }
        let name = self
            .dns_server(&server_id)
            .map_or_else(String::new, |s| s.name.clone());
        self.ask_biometric(
            format!("Send a DNS token to {name}"),
            Pending::DnsToken {
                server_id,
                zone_id: zone,
                token: trimmed,
            },
        );
    }

    pub(super) fn dns_token_checked(
        &mut self,
        server_id: String,
        zone_id: String,
        token: Zeroizing<String>,
        confirmed: bool,
    ) {
        if !confirmed {
            if let Some(server) = self.dns_server(&server_id) {
                server.problem = Some(NOT_CONFIRMED_TOKEN.to_owned());
            }
            return;
        }
        let params = json!({
            "serverId": server_id, "zoneId": zone_id, "mode": "paste", "token": token.as_str(),
        });
        self.provision(server_id, params);
    }

    fn dns_token_remove(&mut self, server_id: String) {
        let zone = self.zone_name();
        let Some(server) = self.dns_server(&server_id).cloned() else {
            return;
        };
        let detail = if server.made_here {
            "The server forgets it, and the token Runova made is deleted at Cloudflare. Wildcard certificates there stop renewing until it has a token again."
        } else {
            "The server forgets it. The token itself stays on Cloudflare; delete it there if nothing else uses it."
        };
        let made_here = server.made_here;
        self.ask(
            asking(
                format!("Remove the DNS token from {}?", server.name),
                detail.to_owned(),
                "Remove the token",
            ),
            move |runner| {
                if let Some(server) = runner.dns_server(&server_id) {
                    server.busy = true;
                }
                let asked = server_id.clone();
                runner.cf(
                    "cloudflare.removeDnsToken",
                    Some(json!({"serverId": server_id, "zone": zone, "deleteAtCloudflare": made_here})),
                    move |r, result: Result<OkDto, String>| {
                        if let Some(server) = r.dns_server(&asked) {
                            server.busy = false;
                        }
                        match result {
                            Ok(done) => {
                                r.view.notice = Some(done.message);
                                r.load_dns_tokens(asked);
                            }
                            Err(problem) => {
                                if let Some(server) = r.dns_server(&asked) {
                                    server.problem = Some(problem);
                                }
                            }
                        }
                    },
                );
            },
        );
    }
}

#[uniffi::export]
impl Engine {
    pub fn cloudflare_new_widget(&self) {
        self.run(|r| r.open_widget_form(None));
    }

    pub fn cloudflare_edit_widget(&self, sitekey: String) {
        self.run(move |r| r.open_widget_form(Some(sitekey)));
    }

    pub fn cloudflare_close_widget_form(&self) {
        self.run(|r| r.view.cloudflare.widget_form = None);
    }

    pub fn cloudflare_save_widget(&self, draft: WidgetDraft) {
        self.run(move |r| r.save_widget(draft));
    }

    pub fn cloudflare_delete_widget(&self, sitekey: String) {
        self.run(move |r| r.delete_widget(sitekey));
    }

    /// Asks for the phone's own check, then shows the widget's secret.
    pub fn cloudflare_reveal_secret(&self, sitekey: String) {
        self.run(move |r| r.reveal_secret(sitekey));
    }

    pub fn cloudflare_hide_secret(&self) {
        self.run(Runner::hide_secret);
    }

    /// With `now` the old secret stops at once; without, it keeps working for two hours.
    pub fn cloudflare_rotate_secret(&self, sitekey: String, now: bool) {
        self.run(move |r| r.rotate_secret(sitekey, now));
    }

    pub fn cloudflare_dns_token_mint(&self, server_id: String) {
        self.run(move |r| r.dns_token_mint(server_id));
    }

    /// A token pasted on the phone goes only after the phone's own check.
    pub fn cloudflare_dns_token_paste(&self, server_id: String, token: String) {
        self.run(move |r| r.dns_token_paste(server_id, token));
    }

    pub fn cloudflare_dns_token_remove(&self, server_id: String) {
        self.run(move |r| r.dns_token_remove(server_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_kept_once_in_lower_case() {
        let typed = vec![
            " Example.com ".to_owned(),
            "example.com.".to_owned(),
            String::new(),
            "Shop.example.com".to_owned(),
        ];
        assert_eq!(clean_domains(&typed), ["example.com", "shop.example.com"]);
    }

    #[test]
    fn the_snippet_carries_the_site_key() {
        let html = snippet("0x4AAA");
        assert!(html.contains("data-sitekey=\"0x4AAA\""));
        assert!(html.starts_with("<script src=\"https://challenges.cloudflare.com"));
    }
}
