# sample-cli

A tiny command-line tool that prints statistics for a list of numbers. It exists so Deskhaven agents
have something small and real to work on.

```bash
npm test                      # runs the node:test suite (no install needed on Node 22)
npm start -- 3 5 8 13         # prints count, sum, mean, median
```

## Known issues

- `mean` is wrong for some inputs (see the failing test).
- `median` is not implemented yet.
- The CLI does not validate its arguments.
