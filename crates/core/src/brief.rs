//! Brief rendering for lead and direction spawns. The brief is the first
//! user-role message of the Codex thread — it must carry everything the agent
//! cannot discover on its own: mandate, scope, and bus identity.

/// Which bus party a spawned thread acts as.
pub fn direction_party(direction_id: i64) -> String {
    direction_id.to_string()
}

pub const LEAD_PARTY: &str = "lead";

/// The bus usage block appended to every brief. `bus_url` is this thread's
/// per-thread MCP endpoint (registered as the `weft-bus` MCP server).
fn bus_block(party: &str, bus_url: &str) -> String {
    format!(
        "\n\n## Thread bus\n\
         You are party `{party}` on this issue's thread bus. An MCP server \
         `weft-bus` is attached to this thread (endpoint {bus_url}) with two \
         tools:\n\
         - `bus_post(to, text)` — message another participant (`lead` or a \
         direction id). Reports, questions, and completion notices go here.\n\
         - `bus_read()` — drain your inbox (fallback pull; messages are \
         normally injected straight into this conversation)."
    )
}

/// First message for a direction (worker) thread.
pub fn direction_brief(
    issue_title: &str,
    direction_name: &str,
    spec: &str,
    mandate: &str,
    reason: &str,
    repo_name: &str,
    party: &str,
    bus_url: &str,
) -> String {
    let spec_line = if spec.is_empty() {
        String::new()
    } else {
        format!("\nTask:\n{spec}\n")
    };
    let mandate_line = if mandate == "impl-only" {
        "Mandate: impl-only — the scope is fully specified; build straight away."
    } else {
        "Mandate: plan+impl — plan your own direction first, then build it."
    };
    let reason_line = if reason.is_empty() {
        String::new()
    } else {
        format!("\nWhy this repo must change: {reason}")
    };
    format!(
        "You are direction `{direction_name}` on issue: {issue_title}\n\
         Repo: {repo_name} (you write ONLY this repo; your working directory \
         is its dedicated worktree).\n\
         {spec_line}\
         {mandate_line}{reason_line}\n\
         When done, post a completion summary to `lead` via the bus."
    ) + &bus_block(party, bus_url)
}

/// First message for an issue's lead thread.
pub fn lead_brief(issue_title: &str, directions: &[(i64, String)], bus_url: &str) -> String {
    let mut lines = format!(
        "You are the lead on issue: {issue_title}\n\
         Coordinate the directions below; you do not write code yourself.\n\
         Directions:\n"
    );
    for (id, name) in directions {
        lines.push_str(&format!("- `{id}`: {name}\n"));
    }
    lines.push_str(
        "Track their bus reports, answer their questions, and synthesize the \
         final outcome for the human.",
    );
    lines + &bus_block(LEAD_PARTY, bus_url)
}

/// Envelope for a bus message injected into a recipient's Codex thread.
pub fn bus_envelope(from: &str, text: &str) -> String {
    format!("[bus message from {from}]\n{text}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn direction_brief_carries_identity_and_mandate() {
        let b = super::direction_brief(
            "Fix login",
            "backend-fix",
            "Create hello.txt containing 'hi'",
            "plan+impl",
            "sessions expire early",
            "api",
            "3",
            "http://127.0.0.1:47810/bus/1/3/mcp",
        );
        assert!(b.contains("Fix login"));
        assert!(b.contains("Create hello.txt"));
        assert!(b.contains("plan+impl"));
        assert!(b.contains("sessions expire early"));
        assert!(b.contains("party `3`"));
        assert!(b.contains("weft-bus"));
    }

    #[test]
    fn lead_brief_lists_directions() {
        let b = super::lead_brief(
            "Fix login",
            &[(3, "backend-fix".to_string()), (4, "frontend-copy".to_string())],
            "http://127.0.0.1:47810/bus/1/lead/mcp",
        );
        assert!(b.contains("`3`: backend-fix"));
        assert!(b.contains("`4`: frontend-copy"));
        assert!(b.contains("party `lead`"));
    }
}
