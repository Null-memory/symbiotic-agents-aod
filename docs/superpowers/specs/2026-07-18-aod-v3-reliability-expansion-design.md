# AOD V3 Reliability Expansion Design

## Goal

Move AOD from a functional local orchestrator to a dependable daily collaboration workbench. V3 adds reusable Agent seats, adapter diagnostics, one approval inbox, process leases with recovery, and operational metrics without weakening the existing human merge gates.

## Delivery Phases

1. **Reusable Agent seats:** a group may contain multiple seats backed by the same adapter. Each seat has its own stable key, display name, role, instructions, turn history, process metadata, and session snapshot identity.
2. **Adapter diagnostics:** configurable probes report executable discovery, version, authentication readiness, latency, and the last failure without storing CLI credentials.
3. **Approval inbox:** existing task, group, conflict, run, and PR states are projected into one list of explicit operator decisions. Approval actions call the existing domain operations rather than bypassing them.
4. **Process leases and recovery:** every Agent process records a lease, heartbeat, output timestamp, PID, and terminal outcome. Startup recovery distinguishes a live process, a stale process, and an unverifiable process.
5. **Operational metrics:** run and adapter aggregates expose duration, attempts, timeout rate, failure reasons, concurrency utilization, and optional token/cost values reported by adapters.

## Phase 1: Reusable Agent Seats

`agent_group_members.agent` remains the adapter key, while `agent_group_members.key` becomes the unique seat identity within a group. The database must allow repeated adapters but continue rejecting duplicate seat keys. Existing databases are migrated transactionally by rebuilding only `agent_group_members`; existing rows and moderator IDs are preserved.

The group editor becomes a dynamic roster. Operators add a seat, choose its adapter and role, name it, describe its responsibility, select one moderator, and remove seats. Default groups still start with Codex executor, Claude reviewer, and Antigravity fixer. Editing an existing group preserves member keys; new keys are generated deterministically from the selected adapter with numeric suffixes.

Starting a group session freezes every seat into `member_snapshot_json`. Discussion turns continue to use the adapter configuration selected by the seat, but prompts and environment variables identify the unique member ID. Therefore three Claude Code seats run as three independent participants with separate responsibilities and outputs while sharing the configured Claude Code executable.

## Safety And Compatibility

- Group keys remain unique and are the only group-local identity accepted by `moderatorKey`.
- At least one executor and reviewer remain mandatory; a fixer remains mandatory when repairs are enabled.
- Existing session snapshots are immutable and require no migration.
- Existing groups retain their members and moderator after schema migration.
- Global Agent concurrency still counts processes, not adapter types.
- No phase automatically applies conflict patches, merges task branches, or merges GitHub PRs.

## Interfaces

Phase 1 keeps the current group APIs. `POST /api/groups` and `PATCH /api/groups/:id` accept repeated `agent` values as long as every member `key` is unique. Responses continue returning the adapter in `agent` and expose each seat separately in `members`.

Later phases add:

- `GET /api/agents/health` and `POST /api/agents/:agent/check`
- `GET /api/approvals` and typed approval action endpoints
- process lease and heartbeat fields in runtime state
- `GET /api/metrics` with run and adapter aggregates

## Verification

Phase 1 is complete when domain tests accept repeated adapters, migration tests prove old databases preserve rows while removing only the adapter uniqueness constraint, integration tests create and run a group with three Claude Code seats, and Chrome verifies dynamic roster creation and editing without horizontal overflow.

Later phases require probe failure/authentication cases, approval action authorization and idempotency, daemon restart recovery cases, and metric aggregation tests.
