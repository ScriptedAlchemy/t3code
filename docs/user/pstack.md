# pstack

pstack is [Lauren Tan's](https://github.com/cursor/plugins/tree/main/pstack) set of rigorous agent
workflows, such as `architect`, `arena`, `how`, `why`, and `poteto-mode`. T3 Code ships it built in
and runs it the same way in every provider. Its multi-model steps can mix providers: one
`$pstack:architect` can run an Opus runner and a GPT runner side by side, whichever provider your
thread uses.

## Turn it on

On web and desktop, open **Settings → General** and turn on **pstack** under Behavior. On mobile,
open **Settings → Agent behavior**. The setting belongs to the environment, so turn
it on for each machine you want it on. Turning it off removes the `pstack:` skills from the composer
and keeps your model choices.

## Choose models once

Run `$pstack:setup-pstack` in any thread. It reads the providers and models this environment offers,
asks for a reasoning budget, shows every pstack role with its model, and saves your choices for every
provider's threads on this machine. Run it again to change them, or after you enable or add a
provider. Until you run it, pstack uses its own defaults where this environment offers those models.

## Run a workflow

Type `$` or `/` in the composer and pick a `pstack:` skill, for example `$pstack:architect design the
cache layer`. Start rigorous work with `$pstack:poteto-mode`; it picks the other skills as it goes.
Helper agents appear under the thread as tasks you can open, follow, or stop.

When a role's provider is turned off or no longer offers the model, that helper runs on your thread's
own model instead, and the reply says `Fallback: …`. Turn the provider back on, or run
`$pstack:setup-pstack` to choose another model.

## Good to know

- pstack runs on the machine the thread runs on. A linked machine needs pstack turned on and its own
  `$pstack:setup-pstack`, since its providers differ.
- Long-running workflows use T3 Code's scheduled tasks and pull request watching. Remove schedules you
  no longer need from the scheduled tasks list.
- Steps that need a Cursor-only feature, such as Bugbot setup or a Cursor cloud machine, are skipped
  with a one-line note in the reply.
- If you also installed pstack directly in Claude Code or Cursor, use the T3 Code `pstack:` skills
  inside T3 Code. They replace the native ones in the composer and are the ones that can mix
  providers.
