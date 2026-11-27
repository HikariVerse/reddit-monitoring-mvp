"""Registry-driven result presentation and arithmetic checks."""

import math
import numbers

from . import common as CM, registry as REG
from . import evidence as EV
from .v4_metrics import BRAND_REQUIRED, DATE_REQUIRED


def check_formula(result, rule):
    value, num, den = (result.get(key) for key in ("value", "numerator", "denominator"))
    if rule == "difference":
        inputs = result.get("formula_inputs", {})
        current, previous = inputs.get("current"), inputs.get("previous")
        if not all(isinstance(x, numbers.Real) and math.isfinite(x) for x in (value, current, previous)):
            return "formula_inputs_missing"
        return None if math.isclose(value, current - previous, abs_tol=.00051) else "formula_mismatch"
    if not all(isinstance(x, numbers.Real) and math.isfinite(x) for x in (value, num, den)) or den <= 0:
        return "formula_inputs_missing"
    if rule in {"proportion", "per_million"} and not 0 <= num <= den:
        return "numerator_outside_population"
    if rule == "signed_proportion" and abs(num) > den:
        return "numerator_outside_population"
    if rule == "balance" and not 0 <= num <= den:
        return "numerator_outside_population"
    target = {"per_million": lambda: num / den * 1e6, "balance": lambda: 1 - num / den,
              "growth": lambda: (num - den) / den}.get(rule, lambda: num / den)()
    if not math.isclose(value, target, abs_tol=0.00051, rel_tol=1e-8):
        return "formula_mismatch"
    return None


def finalize(scope, module, out, runtime_ms, parameters):
    available = out.get("metrics", {})
    charts = out.get("charts", {})
    metrics = {}
    populations = scope.meta.get("populations", {})
    research = populations.get("research")
    semantic = populations.get("semantic", {})
    doc_ids = set(scope.docs["doc_id"]) | set(scope.context["doc_id"])
    brand_support = int(CM.known_brand_mask(scope.docs).sum()) if scope.n and BRAND_REQUIRED.intersection(available) else 0
    known_days = int(scope.docs["date"].nunique())
    for definition in REG.by_module(module):
        mid = definition["metric_id"]
        metric = dict(available.get(mid) or CM.M(mid, None, n=scope.n,
                                                 reason="范围没有该指标所需的有效内容"))
        metric["unit"] = metric.get("unit") or definition["unit"]
        population_key = definition["population_requirements"]
        population = metric.get("population") or semantic.get(population_key) or research
        object_data = metric.get("data")
        if object_data is None:
            object_data = charts.get(definition.get("chart_key"))
        evidence = metric.get("evidence_ref") or []
        membership = metric.get("membership")
        nested = EV.nested_contract(object_data, doc_ids)
        replayable = EV.archive_query(scope) if population_key == "archive" and metric.get("value") is not None else None
        substantive = bool(replayable or (membership and membership["complete"]) or nested["objects"] or evidence)
        flags = []
        valid = [doc_id for doc_id in evidence if doc_id in doc_ids]
        if len(valid) != len(evidence):
            flags.append("unresolved_evidence")
        if nested["unresolved"] or (membership and not set(membership["doc_ids"]) <= doc_ids):
            flags.append("unresolved_nested_evidence")
        value = metric["value"]
        minimum = definition["quality_rules"]["min_support"]
        support = metric.get("denominator") if minimum else metric.get("numerator")
        reasons = {
            "unresolved_evidence": "证据引用无法解析",
            "formula_inputs_missing": "公式输入不完整",
            "numerator_outside_population": "分子超出总体定义",
            "formula_mismatch": "指标值未通过分子分母对账",
            "non_finite": "结果超出有效数值范围",
            "insufficient_support": f"有效支持量少于 {minimum}",
            "archive_only": "仅有归档召回统计",
            "small_scope": "核心样本少于 200 篇",
            "exploratory_method": "当前方法用于探索",
            "unresolved_nested_evidence": "结果对象内存在无法解析的证据",
            "brand_support_unverified": "可验证的品牌、公司或其产品证据不足",
            "time_support_missing": "缺少足够的有效时间支持",
            "no_substantive_evidence": "当前结果尚无可复查的证据链",
        }
        state = "available"
        if value is None:
            state = "insufficient_data"
        elif isinstance(value, numbers.Real) and not math.isfinite(value):
            flags.append("non_finite")
        elif definition.get("formula"):
            error = check_formula(metric, definition["formula"])
            if error:
                flags.append(error)
        if flags:
            state = "invalid"
        elif mid in BRAND_REQUIRED and brand_support < 3 and value is not None:
            flags.append("brand_support_unverified")
            state = "insufficient_data"
        elif mid in DATE_REQUIRED and not known_days and value is not None:
            flags.append("time_support_missing")
            state = "insufficient_data"
        elif minimum and state == "available" and (support is None or support < minimum):
            flags.append("insufficient_support")
            state = "insufficient_data"
        elif population_key != "archive" and state == "available":
            if scope.n < 200:
                flags.append("small_scope")
            if definition["quality_rules"]["exploratory"]:
                flags.append("exploratory_method")
            if not substantive:
                flags.append("no_substantive_evidence")
            if flags:
                state = "exploratory"
        hidden = state in {"invalid", "insufficient_data"}
        metrics[mid] = {
            **metric, "metric_version": definition["metric_version"], "method_version": definition["method_version"],
            "analysis_id": module, "scope": scope.meta.get("scope_id"), "output_type": definition["output_type"],
            "population": population, "parameters": parameters, "quality_status": state, "quality_flags": flags,
            "support_count": support, "evidence_ref": valid, "runtime_ms": runtime_ms, "data": object_data,
            "evidence_contract": {"direct": len(valid), "nested": nested, "query": replayable, "membership": membership},
            "quality_dependencies": {"brand_support": brand_support if mid in BRAND_REQUIRED else None,
                                     "observed_days": known_days if mid in DATE_REQUIRED else None},
            "diagnostic_value": value if hidden else None, "value": None if hidden else value,
            "reason": "；".join(reasons[f] for f in flags) or metric.get("reason", ""),
            "status": "empty" if hidden else "ok",
        }
    out["metrics"] = metrics
    if scope.n < 200 or any(x["quality_status"] == "invalid" for x in metrics.values()):
        out["insight"] = []
    return CM.clean_json(out)
