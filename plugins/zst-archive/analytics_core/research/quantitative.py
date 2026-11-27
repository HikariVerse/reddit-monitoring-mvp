"""Exposure-aware time series and within-unit association operators."""

from collections import Counter, defaultdict
from itertools import combinations
import math
import warnings

import numpy as np
import pandas as pd
from scipy.stats import fisher_exact, norm, theilslopes


def temporal(counts, exposure, unit):
    frame = pd.DataFrame({"count": counts, "exposure": exposure}).dropna().sort_index()
    frame = frame[(frame.exposure > 0) & (frame["count"] >= 0)]
    if unit == "eligible_documents":
        frame = frame[frame["count"] <= frame.exposure]
    if not len(frame):
        return {"unit": unit, "days": 0, "weeks": 0, "slope": None, "trend": None, "changes": [], "anomalies": []}
    frame.index = pd.to_datetime(frame.index)
    frame["rate"] = frame["count"] / frame.exposure
    weekly = frame.resample("W-MON", label="left", closed="left").sum().query("exposure > 0")
    rates = weekly["count"] / weekly.exposure
    beta = theilslopes(rates, (weekly.index - weekly.index[0]).days / 7) if len(weekly) >= 4 else None
    summary = {"unit": unit, "days": len(frame), "weeks": len(weekly), "slope": None, "trend": None, "changes": [], "anomalies": [],
               "daily_persistence": float((frame["count"] > 0).mean()),
               "weekly_persistence": float((weekly["count"] > 0).mean()),
               "weekly_counts": [{"week": str(index.date()), "count": int(row["count"]), "exposure": int(row.exposure)}
                                 for index, row in weekly.iterrows()]}
    if beta:
        summary["slope"] = {"per_week": float(beta.slope), "ci95": [float(beta.low_slope), float(beta.high_slope)], "method": "scipy_theil_sen"}
    if len(weekly) >= 6 and 0 < weekly["count"].sum() and rates.nunique() > 1:
        summary["trend"] = fit_glm(weekly, unit)
    if len(frame) >= 21 and frame.rate.nunique() > 1:
        scaled = (frame.rate - frame.rate.mean()) / frame.rate.std()
        try:
            import ruptures
        except ImportError:
            pass
        else:
            changes = ruptures.Pelt(model="l2", min_size=7, jump=1).fit(scaled.to_numpy()).predict(pen=3 * math.log(len(frame)))
            summary["changes"] = [str(frame.index[i].date()) for i in changes if i < len(frame)]
            summary["change_method"] = "ruptures_pelt_retrospective"
    for i in range(14, len(frame)):
        prior = frame.iloc[max(0, i - 28):i]
        current = frame.iloc[i]
        baseline = (prior["count"].sum() + .5) / (prior.exposure.sum() + 1)
        expectation = baseline * current.exposure
        residual = (current["count"] - expectation) / math.sqrt(max(1, expectation))
        if current["count"] >= 3 and residual > 3.5:
            summary["anomalies"].append({"date": str(frame.index[i].date()), "observed": int(current["count"]),
                                         "expected": float(expectation), "score": float(residual), "exposure": int(current.exposure)})
    return summary


def fit_glm(weekly, unit):
    try:
        import statsmodels.api as sm
        from statsmodels.tools.sm_exceptions import PerfectSeparationWarning
    except ImportError:
        return None
    timeline = (weekly.index - weekly.index[0]).days.to_numpy(dtype=float) / 7
    predictor = sm.add_constant(timeline)
    observed = weekly["count"].to_numpy()
    exposure = weekly.exposure.to_numpy()
    with warnings.catch_warnings():
        warnings.simplefilter("error", PerfectSeparationWarning)
        try:
            if unit == "eligible_documents":
                name = "binomial"
                model = sm.GLM(np.column_stack([observed, exposure - observed]), predictor, family=sm.families.Binomial()).fit()
            else:
                name = "poisson"
                model = sm.GLM(observed, predictor, offset=np.log(exposure), family=sm.families.Poisson()).fit()
                dispersion = float(model.pearson_chi2 / max(1, model.df_resid))
                if dispersion > 1.6:
                    alpha = max(1e-6, float(((observed - model.mu) ** 2 - model.mu).sum() / (model.mu ** 2).sum()))
                    name = "negative_binomial"
                    model = sm.GLM(observed, predictor, offset=np.log(exposure), family=sm.families.NegativeBinomial(alpha=alpha)).fit()
        except (ValueError, np.linalg.LinAlgError, PerfectSeparationWarning):
            return None
    if not model.converged or not np.isfinite(model.params).all() or not np.isfinite(model.conf_int()).all():
        return None
    return {"method": "statsmodels_glm", "family": name, "coefficient_per_week": float(model.params[1]),
            "ci95": model.conf_int()[1].tolist(), "p_value": float(model.pvalues[1]), "observations": len(weekly)}


def association(transactions, *, min_support=3, accept=None, limit=40):
    """FP-Growth candidates followed by exact Fisher tests and BH FDR over tested pairs."""
    units = [(doc_id, set(items)) for doc_id, items in transactions]
    n = len(units)
    if n < min_support * 2:
        return {"rows": [], "units": n, "tests": 0, "method": "insufficient_support"}
    single = Counter(term for _, terms in units for term in terms)
    vocabulary = {term for term, _ in single.most_common(75) if single[term] >= min_support}
    if len(vocabulary) < 2:
        return {"rows": [], "units": n, "tests": 0, "method": "insufficient_vocabulary"}
    try:
        from mlxtend.frequent_patterns import fpgrowth
        from mlxtend.preprocessing import TransactionEncoder
    except ImportError:
        pairs = Counter(pair for _, items in units for pair in combinations(sorted(items & vocabulary), 2))
        candidate = [pair for pair, count in pairs.items() if count >= min_support]
        operator = "bounded_pair_count_fallback"
    else:
        encoded = [sorted(items & vocabulary) for _, items in units]
        tx = TransactionEncoder()
        table = pd.DataFrame(tx.fit_transform(encoded), columns=tx.columns_)
        result = fpgrowth(table, min_support=min_support / n, use_colnames=True, max_len=2)
        candidate = [tuple(sorted(items)) for items in result.itemsets if len(items) == 2]
        operator = "mlxtend_fp_growth"
    candidate = [pair for pair in candidate if accept is None or accept(*pair)]
    if not candidate:
        return {"rows": [], "units": n, "tests": 0, "method": operator}
    members = defaultdict(set)
    for i, (_, items) in enumerate(units):
        for item in items & vocabulary:
            members[item].add(i)
    rows = []
    for a, b in sorted(candidate):
        intersection = members[a] & members[b]
        co = len(intersection)
        observed = [co, single[a] - co, single[b] - co, n - single[a] - single[b] + co]
        odds = fisher_exact([observed[:2], observed[2:]], alternative="two-sided")
        smooth = np.asarray(observed) + .5
        log_or = math.log((smooth[0] * smooth[3]) / (smooth[1] * smooth[2]))
        half = norm.ppf(.975) * math.sqrt(float((1 / smooth).sum()))
        rows.append({"a": a, "b": b, "co": co, "a_count": single[a], "b_count": single[b], "units": n,
                     "lift": co * n / (single[a] * single[b]), "odds_ratio_ci95": [math.exp(log_or - half), math.exp(log_or + half)],
                     "p": float(odds.pvalue), "evidence_ref": sorted({units[i][0] for i in intersection})[:12]})
    rows.sort(key=lambda row: row["p"])
    previous, tests = 1., len(rows)
    for i in range(tests - 1, -1, -1):
        previous = min(previous, rows[i]["p"] * tests / (i + 1))
        rows[i]["q"] = previous
    rows.sort(key=lambda row: (row["q"], -row["co"], -row["lift"]))
    return {"rows": rows[:limit], "units": n, "tests": tests, "method": operator}
