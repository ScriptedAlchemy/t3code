# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

Project-knowledge and conversation-summary references must revalidate their cited messages before
expansion or replay into a new provider history. Deleted threads/projects, rolled-back runs, and
digest mismatches make evidence unavailable; durable facts remain, but retained delivery excerpts
and derived summary statements are scrubbed. Archive is reversible visibility, not removal.
Projection rebuilds replay deletion, correction, and run-state events in order, so the final
projection applies the same exclusion without a second removal registry. Do not interpret this
as recalling copies already sent to a provider.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
