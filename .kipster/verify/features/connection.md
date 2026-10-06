# Connection and compatibility

## Sub-features

- Saved backend address and trusted-owner bootstrap.
- Protocol compatibility gating and reconnect recovery.

## How to get to it (user point of view)

Open the provided UI origin. Its verification index selects this instance before startup. Settings → Connection shows the address; Settings → Updates shows protocol/version details.

## Driving it

| User action                                                  | Exact command                               | Observable result                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Open the connected workspace, inspect its address and reload | `node .kipster/verify/drive.mjs connection` | Settings contains the allocated UI origin; saved connection equals that origin and real bootstrap advertises documents. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

No default-port discovery is permitted. Never replace the address with an installed backend. The command covers compatible bootstrap and reload; older/newer protocol blocking and connection-error screens need separate injected responses and remain unverified here.
