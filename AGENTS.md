# Project Rules

## Dependencies

- Default to the latest version of any library or framework.
- When in doubt about current API syntax or behavior, fetch up-to-date documentation rather than assuming based on older patterns.

## Error Handling

- Prefer typed errors. E.g., effect-TS over python catch. 
- Avoid fallbacks and silent defaults. When something fails, fail with a clear error.