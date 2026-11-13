# MiniMax (AllBot plugin)

Bundled MiniMax plugin for both:

- API-key provider setup (`minimax`)
- Token Plan OAuth setup (`minimax-portal`)

## Enable

```bash
allbot plugins enable minimax
```

Restart the Gateway after enabling.

```bash
allbot gateway restart
```

## Authenticate

OAuth:

```bash
allbot models auth login --provider minimax-portal --set-default
```

API key:

```bash
allbot setup --wizard --auth-choice minimax-global-api
```

## Notes

- MiniMax OAuth uses a user-code login flow.
- OAuth currently targets the Token Plan path.
