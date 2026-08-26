# Training history output contract

Use the internal `kind=training_history_analysis` result as the evidence source. The presentation layer owns conversion to the versioned Web UI schema. Present:

1. A direct conclusion naming the current and baseline periods and its confidence.
2. A compact evidence table by dimension, with current value, baseline value, change and interpretation.
3. The evidence lanes supporting the interpretation.
4. Missing data and confounders, including unmatched routes, unavailable sensors or threshold changes.
5. One next measurement or standardized comparison that would most reduce uncertainty.

Do not hide contradictory evidence. If the structure reports `insufficient_data` or a dimension is `unavailable`, say so rather than replacing it with generic coaching advice.
