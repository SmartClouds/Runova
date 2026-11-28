//! What the demo computer answers, from one JSON file per feature. Each method maps to
//! `{"result": value}`, `{"error": {"code", "message"}}`, or for a stream
//! `{"events": [...], "bytes": ["text", ...], "end": true}`. A stream with `"end": false` stays
//! open, as a terminal does. An answer that depends on what was asked for names the parameter in
//! `"by"` and keeps, in `"cases"`, the fields that differ for each value, laid over `"result"`. A
//! list answer has no fields, so its case holds the whole list for that value under `"result"`.

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

/// The answer files, each a JSON object keyed by method.
const FILES: &[(&str, &str)] = &[
    ("core", include_str!("answers/core.json")),
    ("terminals", include_str!("answers/terminals.json")),
    ("git", include_str!("answers/git.json")),
    ("status", include_str!("answers/status.json")),
    ("vault", include_str!("answers/vault.json")),
    ("agents", include_str!("answers/agents.json")),
    ("studio", include_str!("answers/studio.json")),
    ("cloudflare", include_str!("answers/cloudflare.json")),
    ("deploy", include_str!("answers/deploy.json")),
    ("ops", include_str!("answers/ops.json")),
    ("tasks", include_str!("answers/tasks.json")),
];

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Refusal {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Answer {
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<Refusal>,
    #[serde(default)]
    pub events: Vec<Value>,
    /// Stream bytes, as text.
    #[serde(default)]
    pub bytes: Vec<String>,
    #[serde(default = "ends")]
    pub end: bool,
    /// The parameter `cases` is keyed by.
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub cases: HashMap<String, Map<String, Value>>,
}

impl Answer {
    /// The result for these parameters: `result`, with the fields of the matching case laid over it.
    pub(crate) fn result_for(&self, params: Option<&Value>) -> Value {
        let mut result = self.result.clone().unwrap_or(Value::Null);
        let case = self
            .by
            .as_deref()
            .and_then(|by| params?.get(by)?.as_str())
            .and_then(|value| self.cases.get(value));
        // A list answer can not take fields, so its case gives the whole list under "result".
        if let Some(whole) = case
            .filter(|_| !result.is_object())
            .and_then(|c| c.get("result"))
        {
            return whole.clone();
        }
        if let (Some(case), Value::Object(fields)) = (case, &mut result) {
            for (key, value) in case {
                fields.insert(key.clone(), value.clone());
            }
        }
        result
    }
}

fn ends() -> bool {
    true
}

fn read() -> HashMap<String, Answer> {
    let mut all = HashMap::new();
    for (name, text) in FILES {
        let file: HashMap<String, Answer> = serde_json::from_str(text)
            .unwrap_or_else(|error| panic!("demo answers {name}.json: {error}"));
        for (method, answer) in file {
            assert!(
                all.insert(method.clone(), answer).is_none(),
                "{method} is answered twice"
            );
        }
    }
    all
}

pub(crate) fn answers() -> &'static HashMap<String, Answer> {
    static ANSWERS: OnceLock<HashMap<String, Answer>> = OnceLock::new();
    ANSWERS.get_or_init(read)
}

/// Every method the demo computer answers.
pub fn answered_methods() -> Vec<String> {
    let mut methods: Vec<String> = answers().keys().cloned().collect();
    methods.sort();
    methods
}
