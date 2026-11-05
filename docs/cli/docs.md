---
summary: "CLI reference for `allbot docs` (search the live docs index)"
read_when:
  - You want to search the live AllBot docs from the terminal
title: "docs"
---

# `allbot docs`

Search the live docs index.

Arguments:

- `[query...]`: search terms to send to the live docs index

Examples:

```bash
allbot docs
allbot docs browser existing-session
allbot docs sandbox allowHostControl
allbot docs gateway token secretref
```

Notes:

- With no query, `allbot docs` opens the live docs search entrypoint.
- Multi-word queries are passed through as one search request.
