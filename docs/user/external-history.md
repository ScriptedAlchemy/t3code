# Search conversations outside T3

Open **Settings → Labs → Zack → External history** and turn on **Allow external history search** for the selected environment. The same interface is available from conversation summaries. Web, desktop, and mobile search the selected T3 server's sources, including when you connect remotely.

External history finds supported agent conversations automatically. You do not need to enter paths or enable a provider for local transcript discovery. Choose a ready source, enter text, and search. **Refresh sources** checks for newly available stores.

## Automatically discovered history

T3 checks the default and configured homes for Claude Code, Codex, Pi, and OpenCode. Shared homes appear once. Claude Code and Pi use local transcripts. OpenCode uses its current local database format; older formats appear as unsupported. Codex uses its existing app-server history reader and requires an enabled provider with a compatible installed version.

Claude sessions marked as T3 conversations and Codex conversations with a T3 originator are excluded. T3's managed homes and inference histories are excluded from local discovery. Older sessions without an origin marker can still appear. T3 never scans Downloads.

Directory filters appear when the selected source supports them. Archived conversations are available only for sources that support that filter. Providers without a verified readable history format appear with a reason under the source list.

## Add a ChatGPT export

ChatGPT exports are optional. Expand **Add a ChatGPT export**, then add the path to an extracted `conversations.json` file under **ChatGPT export paths**. [Export your ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) first. Numbered conversation JSON files can each be added on a separate line. Paths refer to files on the selected T3 server.

T3 supports the conversation-array export format with a message mapping and current branch. It searches visible user, assistant, and tool text on that branch. Media objects, hidden messages, and abandoned branches are excluded. An unsupported export shape or incomplete branch returns an error.

Replace an export to include newer conversations, then search again. Remove its configured path to stop offering it.

## Search and verify evidence

Search matches literal text without regard to case across complete visible messages and tool evidence. It can find old messages and messages earlier in long conversations. Search automatically skips pages without matches and shows the total number of items examined during the search. You can stop and resume scanning. Use **Continue search** to look for more matches.

Open a match to read its original visible evidence in pages. A digest binds the result to the complete evidence. Changed or missing sources require a new search. Appending to a local transcript can invalidate an earlier result. Pages preserve Unicode boundaries. Oversized evidence produces an explicit capacity error. Very large ChatGPT exports can take longer because loading a later conversation reads the file prefix again.

Connected agents can use `t3_external_history` to discover sources, search, and verify original text. Delegated subagents cannot use it. Search does not import or resume a conversation, generate summaries, or create a disk index. Turning it off refuses subsequent searches and agent reads without deleting the original history.
