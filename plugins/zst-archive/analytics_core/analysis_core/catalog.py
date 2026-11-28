"""Canonical first-batch operator and dashboard contracts."""

from dataclasses import asdict, dataclass


VERSION = "v2-commercial/2.0"
STATES = ("ready", "exploratory", "insufficient_data", "unsupported_source",
          "missing_fields", "unavailable_dependency", "running", "failed")


@dataclass(frozen=True)
class Capability:
    id: str
    title: str
    family: str
    method: str
    unit: str
    fields: tuple[str, ...]
    output: tuple[str, ...]
    support: int = 1


def _metric(mid, title, family, method, unit, fields, output, support=1):
    return Capability(mid, title, family, method, unit, tuple(fields.split()), tuple(output.split()), support)


SELECTED = {c.id: c for c in (
    _metric("SL01", "声量、增长与变化", "overview", "count_delta_growth", "documents", "created_utc", "days weeks months"),
    _metric("SL02", "全库归档声量比", "archive", "matched_admitted_threads_over_admitted_threads", "threads", "retrieval_census archive_ledger", "numerator denominator rate per_million population days"),
    _metric("SL03", "作者、线程及有效讨论", "overview", "distinct_and_direct_meaningful_rate", "documents", "thread_id author_key focus", "threads authors meaningful_documents meaningful_rate denominator"),
    _metric("SL26", "语料去重与质量", "quality", "normalized_exact_simhash_hamming", "documents", "text", "before kept exact near groups"),
    _metric("SR01", "分组语料对比", "compare", "group_count_and_dynamics", "documents", "group", "groups"),
    _metric("SR03", "分组与时序覆盖", "compare", "group_document_share_and_trend", "documents", "group created_utc", "groups"),
    _metric("SR04", "社区特征词与代表词汇", "lexical", "group_vs_rest_dirichlet_log_odds_and_sublinear_tfidf", "terms", "focus", "terms by_group tokenizers"),
    _metric("SR05", "方向性特有词", "lexical", "dirichlet_log_odds", "terms", "focus group", "comparisons", 2),
    _metric("SR06", "多词搭配与名词短语", "lexical", "boundary_aware_ngrams_and_noun_chunks", "phrases", "focus", "bigrams trigrams noun_phrases syntax_documents"),
    _metric("SR17", "互动分布对比", "engagement", "per_platform_per_channel_percentiles", "observations", "source engagement_channels group", "channels"),
    _metric("SR08", "共用主题空间", "topic", "potion_pca_hdbscan_or_minibatch_kmeans_ctfidf", "documents", "focus potion", "topics noise diagnostics model"),
    _metric("SR24", "主题日历", "topic", "assigned_topic_by_utc_day", "documents", "created_utc topic_membership", "cells days topics"),
    _metric("SR25", "主题星期小时", "topic", "assigned_topic_by_utc_weekday_hour", "documents", "created_utc topic_membership", "cells timezone"),
    _metric("SR29", "主题代表内容", "topic", "own_topic_centroid_and_independent_threads", "documents", "topic_membership focus", "topics"),
    _metric("SL04", "异常声量", "temporal", "past_only_rolling_z_30_days", "documents", "created_utc collection_coverage", "days anomalies window_days min_history_days", 8),
    _metric("SL15", "异常区间和区间主题", "temporal", "group_alert_windows_and_recluster", "documents", "created_utc collection_coverage focus potion", "events", 8),
    _metric("SL17", "异常事件生命周期", "temporal", "anomaly_window_phases_and_observed_peak", "documents", "created_utc collection_coverage", "lifecycles"),
    _metric("SL30", "异常事件证据摘要", "temporal", "extractive_event_terms_entities_attributes_and_membership", "documents", "created_utc collection_coverage focus potion", "summaries"),
    _metric("SL07", "情感与观点结构", "sentiment", "scope_opinion_gate_and_polarity", "documents", "focus", "labels coverage by_group by_day"),
    _metric("SL09", "正负口碑", "sentiment", "positive_over_positive_and_negative", "documents", "focus", "positive negative denominator positive_rate negative_rate by_group by_day"),
    _metric("PR02", "主动需求规模", "demand", "grounded_active_need_count", "documents", "focus", "hits denominator rate states"),
    _metric("PR03", "主动需求密度", "demand", "grounded_active_need_over_research_documents", "ratio", "focus", "hits denominator rate states"),
    _metric("OD03", "显式功能请求", "demand", "grounded_feature_request", "documents", "focus", "hits denominator rate states"),
    _metric("OD04", "明确未满足需求", "demand", "explicit_unmet_need_excluding_inferred_partial_solutions", "documents", "focus", "hits denominator rate states"),
    _metric("OD05", "需求语义聚类", "passages", "grounded_active_need_passage_clusters", "passages", "focus potion", "clusters support noise diagnostics"),
    _metric("OD06", "痛点簇", "passages", "grounded_pain_passage_clusters", "passages", "focus potion", "clusters support noise diagnostics"),
    _metric("OD30", "需求、痛点与使用价格语境", "passages", "separate_need_and_pain_and_explicit_context", "passages", "focus potion", "need pain contexts"),
    _metric("PR24", "价格关注与语境", "price", "money_and_price_clause_attention", "documents", "focus", "documents denominator rate facts roles"),
    _metric("MI24", "价格分布", "price", "separate_currency_period_target_amount_role", "price_mentions", "focus", "facts cohort_keys cohorts omitted_mentions"),
    _metric("MI28", "购买决策阶段", "price", "descriptive_grounded_multilabel_purchase_stage", "documents", "focus", "stages denominator overlap_possible"),
    # Phase 2 Commercial Intelligence Metrics (S2-02: 5 bridged + S2-03: 6 decision-grade + S2-06: MI13)
    _metric("PR01", "品类讨论规模", "commercial", "category_scale_with_kind_split", "documents", "focus kind", "documents posts comments threads authors days"),
    _metric("MI03", "每百万归档关注度", "commercial", "archive_population_per_million", "threads/M", "retrieval_census archive_ledger", "threads_per_million numerator denominator rate days"),
    _metric("MI05", "品牌声量排行", "commercial", "normalized_brand_alias_voice", "documents", "focus", "brands discovered_candidates total_brand_mentions denominator"),
    _metric("MI06", "样本品牌声量份额", "commercial", "additive_brand_share_of_voice", "ratio", "focus", "brands total_brand_mentions sum_sov_share unbranded_documents unbranded_rate"),
    _metric("MI07", "品牌提及覆盖率", "commercial", "brand_mention_coverage_rate", "ratio", "focus", "covered_documents unmatched_documents denominator coverage_rate unmatched_rate"),
    _metric("MI14", "直接竞品比较关系", "commercial", "same_sentence_brand_comparison_and_switch", "edges", "focus", "pairs total_comparison_documents total_edges"),
    _metric("MI13", "品牌共提关联网络", "commercial", "document_brand_cooccurrence_lift_npmi", "edges", "focus", "edges total_edges denominator"),
    _metric("PR07", "品类属性负面率", "commercial", "clause_attribute_negative_rate", "ratio", "focus", "attributes denominator formula"),
    _metric("MI19", "品牌×属性情感矩阵", "commercial", "clause_target_attribute_sentiment_matrix", "cells", "focus", "brands attributes cells denominator"),
    _metric("SL08", "净情感指数", "commercial", "signed_net_sentiment_index", "ratio", "focus", "net_sentiment positive negative denominator by_brand by_day"),
    _metric("PR13", "使用场景需求分布", "commercial", "multilabel_scenario_and_active_demand", "documents", "focus", "scenarios covered_documents denominator"),
    _metric("OD16", "用户变通方案", "commercial", "structured_workaround_and_diy_extraction", "documents", "focus", "documents rate categories cases"),
)}


CONDITIONAL = {}


ALIASES = {}


@dataclass(frozen=True)
class Panel:
    title: str
    metrics: tuple[str, ...]
    chart: str
    filters: tuple[str, ...]


PANELS = {
    "P01": Panel("讨论规模与覆盖", ("SL01", "SL02", "SL03"), "line / cards", ("dates", "groups", "sources")),
    "P02": Panel("语料与去重", ("SL26",), "bar / expandable table", ("dates", "groups", "sources")),
    "P03": Panel("分组与互动", ("SR01", "SR03", "SR17"), "line / boxplot / table", ("dates", "groups", "sources")),
    "P04": Panel("词汇与差异", ("SR04", "SR05", "SR06"), "bar / diverging bar", ("dates", "groups", "sources")),
    "P05": Panel("主题结构与代表内容", ("SR08", "SR29"), "bar / table", ("dates", "groups", "sources")),
    "P06": Panel("主题时间分布", ("SR24", "SR25"), "calendar / heatmap", ("dates", "groups", "sources")),
    "P07": Panel("声量异常与事件", ("SL04", "SL15"), "line / expandable table", ("dates", "groups", "sources")),
    "P08": Panel("生命周期", ("SL17", "SL30"), "timeline / table", ("dates", "groups", "sources")),
    "P09": Panel("情感与口碑", ("SL07", "SL09", "SL08"), "stacked bar / line", ("dates", "groups", "sources")),
    "P10": Panel("主动需求与显式诉求", ("PR02", "PR03", "OD03", "OD04"), "bar / cards", ("dates", "groups", "sources")),
    "P11": Panel("未满足需求与痛点", ("OD05", "OD06", "OD30"), "table / bar", ("dates", "groups", "sources")),
    "P12": Panel("价格与购买决策", ("PR24", "MI24", "MI28"), "histogram / table", ("dates", "groups", "sources")),
    "P13": Panel("品牌格局与竞品比较", ("MI05", "MI06", "MI07", "MI14", "MI13"), "bar / table", ("dates", "groups", "sources")),
    "P14": Panel("品牌属性口碑、场景与变通", ("PR07", "MI19", "PR13", "OD16", "PR01", "MI03"), "heatmap / bar / table", ("dates", "groups", "sources")),
}


def manifest():
    return {"schema_version": VERSION, "states": STATES, "capabilities": [asdict(c) for c in SELECTED.values()],
            "panels": {pid: asdict(p) for pid, p in PANELS.items()}, "aliases": ALIASES,
            "conditional": [asdict(c) for c in CONDITIONAL.values()]}
