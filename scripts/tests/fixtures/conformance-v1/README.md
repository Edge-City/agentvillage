Fixtures for the conformance v1 service checks (scripts/tests/mini-apps-conformance.test.ts, `--service`).

- `mcp/` and `https-json/`: a `--fixtures` directory for the synthetic `acme` app, one per service kind.
  `<op>/<name>.request.json` is the arguments the suite sends; `<name>.json` is the answer it expects
  (for mcp, the tools/call `result`; an `error*` file is the `{code, detail}` body, or an MCP error
  answer: an `isError` result or a JSON-RPC error; the envelope tests build theirs inline).
- `mcp-tools.json`: what the local stub server's tools/list advertises.

The tests serve these from a local stub on 127.0.0.1 through a mocked resolver and dialer; nothing here
is ever sent to a real host.
