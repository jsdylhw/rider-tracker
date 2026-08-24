---
name: coach-training
description: Give evidence-based training or recovery guidance from selected activities and structured training metrics. Use for next-session suggestions, weekly plans, recovery choices, and training-load interpretation.
---

# Coach Training

Resolve the relevant history once with a typed `resolve_activities` request and obtain deterministic load, trend, comparison, and report evidence. Prefer `inspect_selection`, `calculate_history_metrics`, and `summarize_recent_training_load`; use `summarize_activities` or `compare_activities` when their established output matches the question. Call `generate_training_advice` only when the user explicitly asks for a concrete next-session or weekly recommendation. Use `navigate_selection` for follow-up references without re-resolving the activity range.

State the training objective, supporting evidence, proposed session, intensity control, and a stop or recovery condition. Treat activity-only fatigue signals as uncertain and avoid medical diagnosis. The main Agent remains responsible for the final explanation; tool output supplies evidence rather than an independent conversational answer.
