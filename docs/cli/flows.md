---
summary: "Redirect: flow commands live under `allbot tasks flow`"
read_when:
  - You encounter allbot flows in older docs or release notes
title: "flows (redirect)"
---

# `allbot tasks flow`

Flow commands are subcommands of `allbot tasks`, not a standalone `flows` command.

```bash
allbot tasks flow list [--json]
allbot tasks flow show <lookup>
allbot tasks flow cancel <lookup>
```

For full documentation see [Task Flow](/automation/taskflow) and the [tasks CLI reference](/cli/index#tasks).
