# Training Agent route experiments

This directory preserves the three standalone route experiments that originally
lived under `services/training-agent/demo`. They are not part of the Training
Agent package and production code must not import them.

Run their Python tests from this directory so the preserved `demo` package name
continues to resolve:

```bash
python -m pytest -q demo
```

Each experiment keeps its original README, local launcher, fixtures, and optional
deployment assets. The maintained route providers live under
`services/training-agent/integrations/route_providers` and have their own tests.
