# Evaluate a generated mode

Apply [unslop](../../unslop/SKILL.md) and run the `skill-creator` skill's checks when it is installed. Check the frontmatter, links, naming collisions, visibility, and whether every rule matches its evidence. Show the concrete draft and meaningful gaps to the user without requiring another approval when they have already authorized landing it.

Evaluate reviews against the held-out PRs using the diff as it stood when the maintainer reviewed it. Exclude later fixes and discussion from the evaluating agent's input. Use an independent agent when allowed; otherwise report that independent evaluation remains unverified. Compare substantive asks and reasons with the actual review. A PR without an explicit verdict cannot be scored as an approval. A case without substantive asks cannot satisfy an overlapping-asks criterion.

Report per-person results and mismatches. Three held-out cases are a smoke test, not proof of fidelity. If evaluation exposes a missing rule, revise only when training evidence supports it. Once a holdout has guided an edit, label it as used and choose fresh cases for a new independent check. For a group, also check that ownership and disagreement routing preserve individual findings. Code-writing conventions need separate validation against authored changes; review agreement alone does not validate them.
