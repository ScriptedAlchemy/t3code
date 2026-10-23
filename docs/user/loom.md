# Loom

The Loom shows a project's threads and agents on one timeline, so you can see what ran when and
how threads relate. It is available on web and desktop.

## Open the Loom

- In the sidebar, open the project picker and select the timeline icon next to a project.
- In the command palette, run **Open Loom**. A project that exists in more than one environment
  lists one entry per environment.

The Loom opens on the last seven days. Use **24h**, **7d**, or **30d** to change the span, the
arrows to move earlier or later, and **Now** to return to the latest window. The window, filters,
selection, and collapsed lanes are in the URL, so a link reopens the same view.

## Read the timeline

Each lane is a thread. Forks and subagent threads nest under the thread that started them; use the
arrow beside a lane to collapse its children. A parent that is outside the window appears in
italics. A lane whose parent was deleted shows a broken-link icon.

- **Runs.** A dashed line is time spent queued or preparing. The bar is the time the provider
  worked, until it reported completion. A run with no recorded start or end shows only what is
  known.
- **Checkpoints.** Diamonds, with the number of files changed. Grey means no files changed.
- **Pull requests.** Squares, placed when the pull request was linked to the thread.
- **Test commands.** Triangles for commands that look like test runs. Red means the command
  exited with an error. The Loom does not count passed or failed tests.
- **Agent tasks.** Circles for provider tasks that have no thread of their own.
- **Transfers.** Curves connect forks, handoffs, and subagent results between threads. A provider
  handoff within one thread is a small chevron on its lane.

Drag the timeline or scroll sideways to pan. Hold Ctrl or Cmd and scroll to zoom, and select
**Fit** to see the whole window.

## Filter and navigate

Filter lanes by title, run status, provider, model, or branch. **Search lanes** narrows the lanes
shown without reloading. Select a mark to see it in the event list beside the timeline. The event
list holds the same activity in time order; select an entry to open its thread, its checkpoint
diff, or its pull request.

Very busy windows are limited in size. When that happens, a note says what was left out, such as
older runs, and **Older lanes** shows the next set of threads. The **As of** time shows when the
timeline was read; select refresh to update it.
