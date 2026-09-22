# @openmep/mcp

An MCP server that gives any agent OpenMEP's deterministic HVAC duct sizing.
No editor, CAD host, account, or network access: the agent describes the ducts,
the engine sizes them.

```json
{
  "mcpServers": {
    "openmep": { "command": "npx", "args": ["-y", "-p", "@openmep/mcp", "openmep-mcp"] }
  }
}
```

Claude Code: `claude mcp add openmep -- npx -y -p @openmep/mcp openmep-mcp`.
Requires Node.js 24+. Transport: stdio.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `size_duct` | `cfm`, optional `role` (`main`/`branch`/`runout`), `airflowType` (`supply`/`return`/`exhaust`/`outside-air`), `existing` section (`{diameterIn}` or `{shape: rect\|oval, widthIn, heightIn}`) | Recommended standard round diameter, velocity, friction; for an existing section its circular equivalent and `ok`/`undersized`/`oversized` |
| `size_duct_network` | `items`: terminals with `requiredCfm`, segments (optionally with `existing`), fittings, equipment, linked by `connectedItemRefs` | Every loaded segment's CFM, role, recommendation, and grade; findings for missing CFM, disconnected terminals, dangling references, mixed systems, undersized and oversized runs |

Both tools are read-only and idempotent. Invalid input comes back as a tool
error naming the field (`NetworkInputError [invalid-item]: items[2].requiredCfm: ...`)
so the model can correct it.

Example prompt that works in a fresh Claude Code session with only this server:

> I have a furnace feeding a supply trunk that tees into two runouts: bedroom 1
> needs 120 CFM, bedroom 2 needs 90 CFM, and the living room is fed off the trunk
> end at 200 CFM. All drawn as 6 inch round. One return grille in the hall at
> 410 CFM on a 10 inch drop. Is anything undersized?

The agent builds the network in one `size_duct_network` call and reports 7, 6,
and 8 in runouts, an 11 in trunk, and a return drop just under size at 10 in.

## Engineering basis and limits

Equal friction at 0.08 in. w.g./100 ft with role-based velocity caps per system,
rounded up to standard round diameters; see
[`@openmep/hvac-domain`](../hvac-domain#engineering-basis) for the formula,
sources, and what is excluded (fitting losses, static pressure summation, fan
selection). Airflow is a design input the server never estimates. Treat results
as preliminary sizing for an engineer to review.

The server uses the official MCP TypeScript SDK and speaks the
`initialize`-handshake protocol revisions (through `2025-11-25`), which current
clients support.

## Library

```ts
import { createOpenMepServer } from "@openmep/mcp";
await createOpenMepServer().connect(transport); // any MCP server transport
```
