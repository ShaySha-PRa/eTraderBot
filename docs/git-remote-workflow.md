# Remote Git workflow for agents

Use this guide for authorized uploads and branch merges, especially when the shell cannot reach the Git host but a connected GitHub tool is available. These transport instructions preserve the repository's existing review, CI, branch-protection and secret-handling requirements.

## 1. Establish the exact change and destination

1. Work in the Git repository. Read its current instructions, inspect status, local branches, worktrees and remote configuration. Derive the destination from the configured remote and the user's request; do not hardcode an account or push to an upstream repository by assumption.
2. Preserve unrelated changes. Stage named files only and review the staged diff. Check whitespace, local documentation links when applicable, and secrets; run the checks appropriate to the actual change. Store a fingerprint of the selected contents so concurrent edits cannot silently enter the upload.
3. Read the actual remote source and target refs. Local remote-tracking refs may be stale. Check relevant protection, required checks and any open PR review before moving a target branch.

Completion criterion: the selected files, parent commit, destination branch and expected remote head are explicit. Upload authorization already given in the conversation remains valid; do not ask for it again solely because the transport changes.

## 2. Choose an available transport

- In restricted agent sessions, prefer the connected GitHub tools when they support the required operation. Discover their current schemas; operation names commonly end in `github_fetch`, `github_create_tree`, `github_create_commit` and `github_update_ref`.
- Use native Git when its transport is available or the connected tools cannot preserve the required Git objects. After a DNS failure such as `Could not resolve hostname`, stop repeating the same SSH command and use the connected service if available.
- Keep authentication within the selected transport. Do not extract application tokens, print credentials, change global SSH configuration or disable host verification to work around a network failure.
- If neither transport can complete the operation, finish the authorized local work and report the precise remaining remote operation. A local commit is not a successful upload.

Completion criterion: a remote read succeeds through the selected transport, or the transport limitation is explicitly reported. Changing transport does not change authorization or bypass branch protection.

## 3. Connected GitHub path

### Existing commits already on the remote

If the requested source commit already exists remotely, no file re-upload is needed. Verify ancestry and required checks, then fast-forward the authorized target ref with the expected old SHA and `force: false`. An ordinary fast-forward preserves the existing commits without creating a separate merge commit.

If the target has diverged, perform a real merge with normal conflict resolution and verification, or use the existing PR flow. A forced ref update is not a merge.

### New reviewed changes whose parent is already on the remote

1. Capture the reviewed index: selected paths, blob contents, file modes, parent commit and `git write-tree` SHA. Read the upload contents from the index rather than mutable working files. Preserve modes, including executable files; represent deletions explicitly when present.
2. Create the remote tree on the parent's tree, using only the reviewed entries. Use blobs for binary content if the tool requires them. Require the returned tree SHA to equal the local staged tree SHA before proceeding.
3. Create the commit with the authorized parent and a public-safe message. At this stage it is an object, not a published branch update. Retrieve its full Git commit metadata and retain the returned SHA as the authoritative identity.
4. Materialize that exact commit locally before claiming local/remote synchronization. Use a functioning Git fetch when available; otherwise import only bytes whose Git object hash matches the remote SHA. See the metadata warning below.
5. Advance the local source ref only from the expected old commit to its verified descendant, with the index already matching that commit's tree. Preserve unrelated unstaged changes. For a dirty checkout, use a separate clean worktree to merge the target branch rather than resetting or stashing another session's work.
6. Update the authorized remote refs using an expected-head check and `force: false`. If the head changed, read it again and reconcile the new history; do not overwrite the other writer. If a protected target requires a PR, use that route and the repository's review-watching instructions.
7. Read the remote refs again, compare them with the intended commits, and synchronize local remote-tracking refs only after confirmation.

Commit identity warning: the Git data API's JSON dates may be normalized to UTC even when the original commit headers use another offset. Matching the tree and message does not reproduce the commit SHA. For an unsigned commit, exact reconstruction must preserve the tree, ordered parents, author/committer identities, timestamp offsets, any encoding header and message bytes including the trailing newline. Validate the complete object hash before writing it or moving refs. Preserve signed commit bytes exactly; never substitute invented metadata or discard a signature to make import succeed.

If existing unpublished local commits cannot be transferred exactly with the available tools, do not silently replace them with different API-created commits and call that a push. Preserve the local history and report the remaining transport requirement.

## 4. Completion checks

- The remote source and target refs point to the intended commits, with ancestry preserved and no force update.
- Local branch and remote-tracking refs agree with the observed remote state; the preserved worktree changes remain outside the commit unless explicitly included by the user.
- The committed files and modes match the reviewed staged tree. A tree object or unattached commit alone does not establish a completed upload.
- State the final commit IDs, merge method, checks performed and checks not performed. Distinguish existing acceptance evidence from tests run during this operation.

Keep user-specific paths, account details, credentials and diagnostic dumps out of public commits, PR descriptions and this guide.
