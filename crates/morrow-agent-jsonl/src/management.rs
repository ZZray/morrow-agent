//! One bounded Host management request per process. No model or tool loop.
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};

use anyhow::{ensure, Result};
use morrow_agent_harness::{management as host, orchestration, TaskOptions};
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};

use crate::{
    evidence,
    protocol::{TaskConfig, FRAME_BYTES},
};

const RESULT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    kind: String,
    version: u32,
    id: String,
    request: Request,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    Project,
    Global,
    Builtin,
}
impl Scope {
    fn name(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
            Self::Builtin => "builtin",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum GoalCommand {
    Status,
    Accept,
    Pause,
    Resume,
    Stop,
}
impl GoalCommand {
    fn name(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Accept => "accept",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Stop => "stop",
        }
    }
}

#[derive(Default)]
struct Resources(BTreeMap<String, String>);
impl<'de> Deserialize<'de> for Resources {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ResourceVisitor;
        impl<'de> Visitor<'de> for ResourceVisitor {
            type Value = Resources;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("unique resource paths mapped to UTF-8 text")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<Resources, M::Error> {
                let mut entries = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if entries.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate resource path"));
                    }
                }
                Ok(Resources(entries))
            }
        }
        deserializer.deserialize_map(ResourceVisitor)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Trigger {
    id: String,
    revision: String,
    source_ref: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mandate {
    id: String,
    revision: String,
    authorization_ref: String,
    configuration_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    id: String,
    trigger_id: String,
    mandate_id: String,
    task: TaskConfig,
    session_id: String,
    session_path: PathBuf,
    cwd: PathBuf,
    configuration_sha256: String,
    options: TaskOptions,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceScope {
    task_id: String,
    session_id: String,
    evidence_dir: PathBuf,
}

#[derive(Deserialize)]
#[serde(remote = "morrow_agent_harness::ProvenanceQuery", deny_unknown_fields)]
struct ProvenanceFilters {
    task_id: Option<String>,
    session_id: Option<String>,
    run_id: Option<String>,
    kind: Option<morrow_agent_harness::ProvenanceKind>,
    artifact_id: Option<String>,
    skill_name: Option<String>,
    bundle_hash: Option<String>,
    host_receipt_id: Option<String>,
    status: Option<morrow_agent_harness::ProvenanceStatus>,
    time_from_ms: Option<i64>,
    time_to_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    ProvenanceQuery {
        scopes: Vec<EvidenceScope>,
        #[serde(with = "ProvenanceFilters")]
        query: morrow_agent_harness::ProvenanceQuery,
    },
    ResolveRoots {
        state_dir: PathBuf,
        cwd: PathBuf,
        global: Option<PathBuf>,
    },
    SkillCatalog {
        roots: host::LibraryRoots,
        #[serde(default)]
        offset: usize,
        limit: Option<usize>,
    },
    SkillVerification {
        roots: host::LibraryRoots,
        scope: Scope,
        name: String,
    },
    SkillRead {
        roots: host::LibraryRoots,
        scope: Scope,
        name: String,
        path: Option<String>,
        offset: Option<u64>,
        max_bytes: Option<u64>,
    },
    SkillCreate {
        roots: host::LibraryRoots,
        scope: Scope,
        name: String,
        description: String,
        instructions: String,
        #[serde(default)]
        resources: Resources,
    },
    SkillInstall {
        roots: host::LibraryRoots,
        scope: Scope,
        source_dir: PathBuf,
    },
    SkillRemove {
        roots: host::LibraryRoots,
        scope: Scope,
        name: String,
        expected_hash: String,
    },
    SkillEnable {
        roots: host::LibraryRoots,
        scope: Scope,
        name: String,
        expected_hash: String,
        enabled: bool,
    },
    ContextSnapshot {
        session: PathBuf,
        cwd: PathBuf,
    },
    ContextCommand {
        session: PathBuf,
        cwd: PathBuf,
        command: String,
        #[serde(default)]
        compact: bool,
    },
    ContextAddReference {
        session: PathBuf,
        cwd: PathBuf,
        kind: String,
        text: String,
        #[serde(default)]
        compact: bool,
    },
    GoalSnapshot {
        session: PathBuf,
        cwd: PathBuf,
    },
    JobSnapshot {
        session: PathBuf,
        cwd: PathBuf,
        device: String,
        session_id: String,
        job_id: Option<String>,
    },
    GoalControl {
        session: PathBuf,
        cwd: PathBuf,
        goal_id: String,
        command: GoalCommand,
        command_id: String,
        expected_revision: u64,
        reviewed_run: String,
    },
    QueueSnapshot {
        directory: PathBuf,
    },
    QueueEvents {
        directory: PathBuf,
        #[serde(default)]
        after: u64,
    },
    QueueCancel {
        directory: PathBuf,
        assignment_id: String,
        at_ms: u64,
    },
    QueueWatchdog {
        directory: PathBuf,
        at_ms: u64,
    },
    QueueEnqueue {
        directory: PathBuf,
        trigger: Trigger,
        mandate: Mandate,
        assignment: Box<Assignment>,
        at_ms: u64,
    },
}

fn absolute(path: &std::path::Path) -> Result<()> {
    ensure!(path.is_absolute() && path.as_os_str().len() <= 4096, "management requires bounded absolute paths");
    Ok(())
}

fn roots(value: &host::LibraryRoots) -> Result<()> {
    for path in [
        &value.environment_dir,
        &value.global_knowledge,
        &value.project_knowledge,
        &value.global_skills,
        &value.project_skills,
    ] {
        absolute(path)?;
    }
    Ok(())
}

fn apply(request: Request, command_id: &str) -> Result<Value> {
    match request {
        Request::ProvenanceQuery { scopes, query } => {
            ensure!(scopes.len() == 1, "one explicit evidence scope per management query required");
            let scope = scopes.into_iter().next().unwrap();
            absolute(&scope.evidence_dir)?;
            Ok(serde_json::to_value(morrow_agent_harness::query_provenance(
                &[morrow_agent_harness::EvidenceScope {
                    task_id: scope.task_id,
                    session_id: scope.session_id,
                    evidence_dir: scope.evidence_dir,
                }],
                &query,
            )?)?)
        }
        Request::ResolveRoots { state_dir, cwd, global } => {
            absolute(&state_dir)?;
            absolute(&cwd)?;
            if let Some(path) = &global {
                absolute(path)?;
            }
            Ok(serde_json::to_value(host::resolve_roots(&state_dir, &cwd, global.as_deref())?)?)
        }
        Request::SkillCatalog { roots: library, offset, limit } => {
            roots(&library)?;
            host::skill_catalog_page(&library, offset, limit.unwrap_or(32))
        }
        Request::SkillVerification { roots: library, scope, name } => {
            roots(&library)?;
            host::skill_verification(&library, scope.name(), &name)
        }
        Request::SkillRead { roots: library, scope, name, path, offset, max_bytes } => {
            roots(&library)?;
            let mut args = json!({"scope":scope.name(),"name":name});
            if let Some(value) = path {
                args["path"] = json!(value);
            }
            if let Some(value) = offset {
                args["offset"] = json!(value);
            }
            if let Some(value) = max_bytes {
                args["max_bytes"] = json!(value);
            }
            host::skill_operation(&library, command_id, "skill_read", args)
        }
        Request::SkillCreate { roots: library, scope, name, description, instructions, resources } => {
            roots(&library)?;
            ensure!(
                !description.trim().is_empty() && description.len() <= 512 && !instructions.trim().is_empty(),
                "skill description or instructions invalid"
            );
            host::skill_operation(
                &library,
                command_id,
                "skill_create",
                json!({"scope":scope.name(),"name":name,"description":description,"instructions":instructions,"resources":resources.0}),
            )
        }
        Request::SkillInstall { roots: library, scope, source_dir } => {
            roots(&library)?;
            absolute(&source_dir)?;
            host::skill_operation(
                &library,
                command_id,
                "skill_install",
                json!({"scope":scope.name(),"source_dir":source_dir}),
            )
        }
        Request::SkillRemove { roots: library, scope, name, expected_hash } => {
            roots(&library)?;
            host::skill_operation(
                &library,
                command_id,
                "skill_remove",
                json!({"scope":scope.name(),"name":name,"expected_hash":expected_hash}),
            )
        }
        Request::SkillEnable { roots: library, scope, name, expected_hash, enabled } => {
            roots(&library)?;
            host::skill_operation(
                &library,
                command_id,
                "skill_enable",
                json!({"scope":scope.name(),"name":name,"expected_hash":expected_hash,"enabled":enabled}),
            )
        }
        Request::ContextSnapshot { session, cwd } => {
            absolute(&session)?;
            absolute(&cwd)?;
            host::context_snapshot(&session, &cwd)
        }
        Request::ContextCommand { session, cwd, command, compact } => {
            absolute(&session)?;
            absolute(&cwd)?;
            ensure!(command.len() <= 65536, "context command too long");
            let value = host::context_command(&session, &cwd, &command, command_id)?;
            Ok(if compact { json!({"command_id":value["command_id"],"output":value["output"]}) } else { value })
        }
        Request::ContextAddReference { session, cwd, kind, text, compact } => {
            absolute(&session)?;
            absolute(&cwd)?;
            ensure!(
                !kind.trim().is_empty() && kind.len() <= 128 && !kind.chars().any(char::is_control),
                "invalid reference kind"
            );
            let value = host::context_add_reference(&session, &cwd, &kind, text, command_id)?;
            Ok(if compact {
                json!({"command_id":value["command_id"],"reference_id":value["reference_id"]})
            } else {
                value
            })
        }
        Request::GoalSnapshot { session, cwd } => {
            absolute(&session)?;
            absolute(&cwd)?;
            host::goal_snapshot(&session, &cwd)
        }
        Request::JobSnapshot { session, cwd, device, session_id, job_id } => {
            absolute(&session)?;
            absolute(&cwd)?;
            for id in [&device, &session_id].into_iter().chain(job_id.iter()) {
                ensure!(
                    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control),
                    "invalid Job observation identity"
                );
            }
            host::job_snapshot(&session, &cwd, &device, &session_id, job_id.as_deref())
        }
        Request::GoalControl { session, cwd, goal_id, command, command_id, expected_revision, reviewed_run } => {
            absolute(&session)?;
            absolute(&cwd)?;
            for id in [&goal_id, &command_id] {
                ensure!(
                    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control),
                    "invalid goal control identity"
                );
            }
            ensure!(
                reviewed_run.len() <= 256 && !reviewed_run.chars().any(char::is_control),
                "invalid reviewed Run identity"
            );
            host::goal_control(
                &session,
                &cwd,
                &goal_id,
                command.name(),
                &command_id,
                Some(expected_revision),
                &reviewed_run,
            )
        }
        Request::QueueSnapshot { directory } => {
            absolute(&directory)?;
            host::queue_snapshot(&directory)
        }
        Request::QueueEvents { directory, after } => {
            absolute(&directory)?;
            host::queue_events(&directory, after)
        }
        Request::QueueCancel { directory, assignment_id, at_ms } => {
            absolute(&directory)?;
            host::queue_cancel(&directory, &assignment_id, at_ms)?;
            Ok(Value::Null)
        }
        Request::QueueWatchdog { directory, at_ms } => {
            absolute(&directory)?;
            host::queue_watchdog(&directory, at_ms)
        }
        Request::QueueEnqueue { directory, trigger, mandate, assignment, at_ms } => {
            absolute(&directory)?;
            absolute(&assignment.session_path)?;
            absolute(&assignment.cwd)?;
            absolute(&assignment.task.evidence_dir)?;
            host::queue_enqueue(
                &directory,
                orchestration::Trigger { id: trigger.id, revision: trigger.revision, source_ref: trigger.source_ref },
                orchestration::Mandate {
                    id: mandate.id,
                    revision: mandate.revision,
                    authorization_ref: mandate.authorization_ref,
                    configuration_sha256: mandate.configuration_sha256,
                },
                orchestration::AssignmentSpec {
                    id: assignment.id,
                    trigger_id: assignment.trigger_id,
                    mandate_id: assignment.mandate_id,
                    task: assignment.task.into(),
                    session_id: assignment.session_id,
                    session_path: assignment.session_path,
                    cwd: assignment.cwd,
                    configuration_sha256: assignment.configuration_sha256,
                    options: assignment.options,
                },
                at_ms,
            )
        }
    }
}

fn response(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    if bytes.len() > FRAME_BYTES {
        return Err("management_frame_rejected");
    }
    // Deserialize the original bytes so duplicate object fields remain errors.
    let frame: Frame = serde_json::from_slice(bytes).map_err(|_| "management_frame_rejected")?;
    if frame.kind != "manage"
        || frame.version != 1
        || frame.id.is_empty()
        || frame.id.len() > 256
        || frame.id.trim() != frame.id
        || frame.id.chars().any(char::is_control)
    {
        return Err("management_frame_rejected");
    }
    // The client derives the same permitted directory from its original request.
    // Only Session and queue operations can return a checked local result file.
    let result_directory = match &frame.request {
        Request::ProvenanceQuery { scopes, .. } if scopes.len() == 1 => {
            Some(scopes[0].evidence_dir.join("management-results"))
        }
        Request::ContextSnapshot { session, .. }
        | Request::ContextCommand { session, .. }
        | Request::ContextAddReference { session, .. }
        | Request::GoalSnapshot { session, .. }
        | Request::GoalControl { session, .. }
        | Request::JobSnapshot { session, .. } => {
            let mut path = session.as_os_str().to_os_string();
            path.push(".management");
            Some(PathBuf::from(path))
        }
        Request::QueueSnapshot { directory }
        | Request::QueueEvents { directory, .. }
        | Request::QueueCancel { directory, .. }
        | Request::QueueWatchdog { directory, .. }
        | Request::QueueEnqueue { directory, .. } => Some(directory.join("management-results")),
        _ => None,
    };
    let mut reply = match apply(frame.request, &frame.id) {
        Ok(value) => json!({"kind":"management_result","version":1,"id":frame.id,"ok":true,"value":value}),
        Err(error) => {
            json!({"kind":"management_result","version":1,"id":frame.id,"ok":false,"error":error.to_string()})
        }
    };
    let mut output = serde_json::to_vec(&reply).map_err(|_| "management_delivery_unknown")?;
    if output.len() + 1 > FRAME_BYTES {
        if output.len() > RESULT_BYTES || reply["ok"] != true {
            return Err("management_response_too_large");
        }
        let directory = result_directory.ok_or("management_response_too_large")?;
        fs::create_dir_all(&directory).map_err(|_| "management_delivery_unknown")?;
        let target = directory.join(format!("{}.json", morrow_agent_harness::core::fresh_id()));
        let reference = evidence::write_new(&target, &reply["value"]).map_err(|_| "management_delivery_unknown")?;
        reply = json!({"kind":"management_result","version":1,"id":frame.id,"ok":true,"value_ref":reference});
        output = serde_json::to_vec(&reply).map_err(|_| "management_delivery_unknown")?;
        if output.len() + 1 > FRAME_BYTES {
            return Err("management_response_too_large");
        }
    }
    output.push(b'\n');
    Ok(output)
}

pub fn stdio(bytes: &[u8]) -> Result<(), &'static str> {
    let output = response(bytes)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&output).and_then(|_| stdout.flush()).map_err(|_| "management_delivery_unknown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_version_unknown_duplicate_and_malformed_management_fields() {
        for bytes in [
            r#"{"kind":"manage","version":2,"id":"x","request":{"operation":"queue_snapshot","directory":"/tmp"}}"#,
            r#"{"kind":"manage","version":1,"version":1,"id":"x","request":{"operation":"queue_snapshot","directory":"/tmp"}}"#,
            r#"{"kind":"manage","version":1,"id":"x","extra":true,"request":{"operation":"queue_snapshot","directory":"/tmp"}}"#,
            r#"{"kind":"manage","version":1,"id":"x","request":{"operation":"queue_snapshot","directory":"/tmp","directory":"/tmp"}}"#,
            r#"{"kind":"manage","version":1,"id":"x","request":{"operation":"queue_snapshot","directory":"/tmp","extra":true}}"#,
            r#"{"kind":"manage","version":1,"id":"x","request":{"operation":"queue_events","directory":"/tmp","after":-1}}"#,
        ] {
            assert_eq!(response(bytes.as_bytes()).unwrap_err(), "management_frame_rejected");
        }
        assert!(serde_json::from_str::<Resources>(r#"{"a":"one","a":"two"}"#).is_err());
    }
}
