"""Reproduce synthetic numeric expectations independently of the TypeScript implementation."""
import json
import pathlib
from fractions import Fraction

CASES = [
    ("third_above", 1, 3, "0.333333333333333333"),
    ("negative_third_below", -1, 3, "-0.333333333333333333"),
    ("two_thirds_above", 2, 3, "0.666666666666666666"),
    ("large_integer_above", 9007199254740993, 1, "9007199254740992"),
    ("exact_tenth", 1, 10, "0.1"),
    ("negative_large_below", -9007199254740993, 1, "-9007199254740992"),
]
records = []
for name, numerator, denominator, threshold in CASES:
    left, right = Fraction(numerator, denominator), Fraction(threshold)
    order = (left > right) - (left < right)
    for comparator, matches in [
        ("equal", left == right), ("not_equal", left != right),
        ("less_than", left < right), ("less_than_or_equal", left <= right),
        ("greater_than", left > right), ("greater_than_or_equal", left >= right),
    ]:
        records.append(dict(name=name + "_" + comparator, numerator=str(numerator),
                            denominator=str(denominator), threshold=threshold,
                            comparator=comparator, order=order,
                            outcome="satisfied" if matches else "violated"))
expected = dict(oracle="Python fractions.Fraction; exact decimal thresholds; synthetic projection only",
                vectors=records)
path = pathlib.Path(__file__).with_name("policy-predicate-numeric-oracle-v1.json")
assert json.loads(path.read_text(encoding="utf-8")) == expected, "Independent oracle fixture changed"
print("Independent Fraction oracle verified: 36 synthetic comparator cases")
