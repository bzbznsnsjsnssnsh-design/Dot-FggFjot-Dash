---
name: p-retry v7 AbortError
description: Compatibility note for retry helpers using the workspace's p-retry v7 package
---

`p-retry` v7 exposes `AbortError` as a named export rather than as a property on the default retry function.

**Why:** TypeScript compilation fails with `pRetry.AbortError` after the workspace uses the v7 API.

**How to apply:** Import `pRetry, { AbortError }` from `p-retry` and instantiate `AbortError` directly.