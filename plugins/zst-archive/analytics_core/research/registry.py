"""业务指标注册表（150 项：PR/SL/SR/OD/MI 各 30）。

每条记录包含：metric_id、名称、所属模块、单位、分母口径、依赖算子、最小样本、实现说明。
实际数值由各模块 compute() 产出，本表用于「指标中心」展示与一致性校验。
"""

from __future__ import annotations

MODULES = {
    "product": {"name": "选品分析", "prefix": "PR"},
    "listening": {"name": "舆情分析", "prefix": "SL"},
    "social": {"name": "社媒调研", "prefix": "SR"},
    "opportunity": {"name": "机会探索", "prefix": "OD"},
    "market": {"name": "市场研究", "prefix": "MI"},
}

# (id, 名称, 单位, 分母口径, 依赖算子)
DEFS: list[tuple[str, str, str, str, str]] = [
    # ---------------- 选品 PR ----------------
    ("PR01", "品类声量", "docs", "—", "count / distinct"),
    ("PR02", "主动需求规模", "docs", "—", "意图识别"),
    ("PR03", "主动需求密度", "ratio", "品类文档", "意图识别 + 比例"),
    ("PR04", "需求增长率", "ratio", "上一期需求占比", "时间序列 + 占比"),
    ("PR05", "需求增长斜率", "docs/day", "—", "Theil-Sen"),
    ("PR06", "需求持续性", "ratio", "覆盖天数", "日期聚合"),
    ("PR07", "品类负面率", "ratio", "明确正负评价", "属性级情感"),
    ("PR08", "满意度缺口", "ratio", "品牌属性三元组", "属性级情感"),
    ("PR09", "属性关注度", "ratio", "品类文档", "实体识别"),
    ("PR10", "属性重要性代理", "lift", "购买/体验意图基准率", "交叉统计"),
    ("PR11", "核心产品痛点", "docs", "—", "痛点正则 + 短语"),
    ("PR12", "功能请求分布", "docs", "—", "意图识别"),
    ("PR13", "场景需求分布", "docs", "—", "场景词典"),
    ("PR14", "场景关联强度", "lift", "需求基准率", "交叉统计"),
    ("PR15", "场景多样性", "entropy", "场景总频次", "熵"),
    ("PR16", "场景覆盖缺口", "count", "场景数", "未满足率 + 阈值"),
    ("PR17", "品牌覆盖率", "ratio", "需求文档", "实体识别"),
    ("PR18", "解决方案覆盖率", "ratio", "需求文档", "实体 + 型号 + 价格"),
    ("PR19", "求替代率", "ratio", "品类文档", "意图识别"),
    ("PR20", "产品迁移流向", "count", "—", "关系抽取"),
    ("PR21", "产品迁移原因", "count", "迁移边数", "属性级情感"),
    ("PR22", "价格锚点", "currency", "—", "价格抽取"),
    ("PR23", "预算区间", "currency", "价格表达数", "价格抽取 + 分位"),
    ("PR24", "价格敏感度", "ratio", "品类文档", "意图 + 痛点"),
    ("PR25", "价格价值判断", "count", "—", "价格带 × 情感"),
    ("PR26", "品牌集中度", "HHI", "品牌提及总数", "HHI / CRn"),
    ("PR27", "社区需求覆盖", "count", "全部社区", "社区聚合"),
    ("PR28", "选品机会综合评分", "score", "—", "多因子加权"),
    ("PR29", "选品机会排序", "count", "—", "排序"),
    ("PR30", "品类横向比较", "table", "—", "多 scope 对比"),
    # ---------------- 舆情 SL ----------------
    ("SL01", "绝对声量", "docs", "—", "日聚合"),
    ("SL02", "相对声量", "ratio", "基础语料同期量", "比例"),
    ("SL03", "独立讨论规模", "count", "—", "distinct 作者/线程"),
    ("SL04", "声量异常", "z", "历史窗口", "滚动 z / MAD"),
    ("SL05", "声量增长速度", "docs/day", "日均量", "一阶差分"),
    ("SL06", "声量加速度", "docs/day²", "—", "二阶差分"),
    ("SL07", "正负面分布", "count", "—", "属性级情感"),
    ("SL08", "净情感指数", "ratio", "明确正负评价", "情感聚合"),
    ("SL09", "负面率", "ratio", "明确正负评价", "情感聚合"),
    ("SL10", "负面声量增长", "ratio", "前半段负面数", "分段对比"),
    ("SL11", "负面率变化", "pp", "前半段负面率", "分段对比"),
    ("SL12", "情感强度", "ratio", "文档数", "极性绝对值"),
    ("SL13", "争议均衡度", "ratio", "正负总数", "1-|pos-neg|/(pos+neg)"),
    ("SL14", "核心负面因素", "count", "—", "属性三元组"),
    ("SL15", "异常事件发现", "count", "异常窗口数", "异常检测 + 聚类"),
    ("SL16", "事件簇规模", "docs", "—", "聚类"),
    ("SL17", "事件生命周期", "days", "—", "区间分析"),
    ("SL18", "事件持续时间", "days", "—", "区间分析"),
    ("SL19", "最早观测时间", "time", "—", "排序"),
    ("SL20", "最早观测社区", "community", "—", "排序"),
    ("SL21", "传播广度", "count", "—", "distinct 社区/作者"),
    ("SL22", "社区传播速度", "communities/day", "事件天数", "新增社区 / 天数"),
    ("SL23", "社区传播路径", "count", "—", "首现时间排序"),
    ("SL24", "社区态度差异", "std", "社区数", "情感分组"),
    ("SL25", "事件来源集中度", "HHI", "文档数", "HHI"),
    ("SL26", "模板内容比例", "ratio", "文档数", "重复检测"),
    ("SL27", "事件影响力代理", "score", "作者数", "互动量聚合"),
    ("SL28", "舆情风险评分", "score", "—", "加权评分"),
    ("SL29", "历史风险事件排序", "count", "—", "排序"),
    ("SL30", "事件自动摘要", "count", "—", "代表词 + 实体 + 原文"),
    # ---------------- 社媒 SR ----------------
    ("SR01", "社区讨论规模", "docs", "—", "分组聚合"),
    ("SR02", "社区活跃度", "docs/day", "—", "日期聚合"),
    ("SR03", "社区活跃趋势", "series", "—", "月度聚合"),
    ("SR04", "社区特征词", "count", "—", "log-odds + Dirichlet"),
    ("SR05", "社区差异词", "count", "—", "log-odds"),
    ("SR06", "社区高频短语", "count", "—", "n-gram"),
    ("SR07", "社区典型话术", "count", "—", "短语 + 聚类"),
    ("SR08", "社区主题结构", "count", "—", "属性/意图构成"),
    ("SR09", "社区属性关注度", "ratio", "社区文档", "实体识别"),
    ("SR10", "社区需求结构", "ratio", "社区文档", "意图识别"),
    ("SR11", "社区品牌偏好代理", "ratio", "社区文档", "实体识别"),
    ("SR12", "社区情感差异", "std", "社区数", "情感聚合"),
    ("SR13", "内容形态分布", "ratio", "文档数", "形态统计"),
    ("SR14", "文本长度分布", "chars", "文档数", "分位统计"),
    ("SR15", "链接域名分布", "count", "—", "URL 解析"),
    ("SR16", "Emoji 及表达习惯", "count", "—", "正则"),
    ("SR17", "互动量分布", "score", "文档数", "分位统计"),
    ("SR18", "互动结构", "corr", "帖子数", "Pearson"),
    ("SR19", "高互动内容特征", "count", "高低分组", "log-odds"),
    ("SR20", "社区参与集中度", "HHI", "社区文档", "HHI"),
    ("SR21", "社区作者重叠", "jaccard", "社区对", "Jaccard"),
    ("SR22", "社区语义相似度", "cosine", "社区对", "向量均值"),
    ("SR23", "社区圈层聚类", "count", "社区数", "标签传播"),
    ("SR24", "话题日历", "count", "—", "日期聚合"),
    ("SR25", "活跃周期", "count", "—", "星期×小时"),
    ("SR26", "模因及模板发现", "count", "—", "n-gram 复用"),
    ("SR27", "模因扩散", "count", "—", "首现 + 跨社区"),
    ("SR28", "自述特征统计", "count", "文档数", "正则（匿名聚合）"),
    ("SR29", "代表性社区内容", "count", "—", "中心最近样本"),
    ("SR30", "社区横向比较", "table", "—", "画像对比"),
    # ---------------- 机会 OD ----------------
    ("OD01", "主动需求发现", "docs", "—", "意图识别"),
    ("OD02", "痛点发现", "docs", "—", "痛点正则"),
    ("OD03", "功能缺口发现", "docs", "—", "意图识别"),
    ("OD04", "未满足需求发现", "docs", "需求文档", "品牌/购买证据缺失"),
    ("OD05", "需求语义聚类", "count", "—", "向量聚类"),
    ("OD06", "痛点语义聚类", "count", "—", "向量聚类"),
    ("OD07", "需求簇自动命名", "count", "簇数", "代表词"),
    ("OD08", "需求簇规模", "docs", "—", "聚类支持度"),
    ("OD09", "未满足需求率", "ratio", "需求片段", "聚类 + 覆盖"),
    ("OD10", "需求增长率", "ratio", "上期占比", "时间序列"),
    ("OD11", "需求趋势斜率", "ratio", "—", "斜率"),
    ("OD12", "需求持续性", "ratio", "覆盖天数", "日期聚合"),
    ("OD13", "新需求发现", "count", "簇数", "增长 + 首现"),
    ("OD14", "需求新颖度", "ratio", "簇数", "1-方案覆盖"),
    ("OD15", "新词及新表达出现率", "ratio", "末期词表", "首现词"),
    ("OD16", "变通方案发现", "docs", "—", "模板匹配"),
    ("OD17", "变通方案率", "ratio", "需求文档", "比例"),
    ("OD18", "组合需求发现", "count", "需求文档", "属性共现"),
    ("OD19", "属性组合支持度", "lift", "独立期望", "lift"),
    ("OD20", "组合场景需求", "count", "—", "场景 × 属性 × 需求"),
    ("OD21", "品牌提及覆盖", "ratio", "需求簇", "实体识别"),
    ("OD22", "明确解决方案覆盖", "ratio", "需求簇", "实体 + 型号"),
    ("OD23", "已有解决方案满意度", "ratio", "明确正负评价", "属性情感"),
    ("OD24", "价格接受信号", "ratio", "需求文档", "价格抽取"),
    ("OD25", "跨社区需求覆盖", "count", "—", "distinct 社区"),
    ("OD26", "需求跨社区泛化", "ratio", "全部社区", "比例"),
    ("OD27", "需求簇关系", "count", "—", "中心向量相似度"),
    ("OD28", "机会空白信号", "score", "—", "覆盖缺口组合"),
    ("OD29", "机会综合评分", "score", "—", "多因子加权"),
    ("OD30", "自动机会证据包", "count", "—", "证据检索"),
    # ---------------- 市场 MI ----------------
    ("MI01", "品类结构", "count", "—", "词典发现"),
    ("MI02", "品类层级关系", "count", "—", "短语 + 共现"),
    ("MI03", "品类相对关注度", "docs/M", "基础语料", "比例"),
    ("MI04", "品类结构变化", "distance", "月度数", "余弦距离"),
    ("MI05", "品牌声量", "docs", "—", "实体识别"),
    ("MI06", "品牌声量份额", "ratio", "品牌提及总数", "比例"),
    ("MI07", "品牌覆盖率", "ratio", "品类文档", "比例"),
    ("MI08", "品牌声量份额变化", "pp", "首月份额", "分段对比"),
    ("MI09", "品牌增长率", "ratio", "首月量", "环比"),
    ("MI10", "品牌集中度", "HHI", "品牌提及", "HHI / CRn"),
    ("MI11", "新兴品牌发现", "count", "品牌数", "首现 + 增长"),
    ("MI12", "新兴产品发现", "count", "—", "型号正则 + 首现"),
    ("MI13", "品牌共提关系", "count", "—", "文档共现 + lift"),
    ("MI14", "直接竞争关系", "count", "—", "比较句模板"),
    ("MI15", "替代关系", "count", "—", "替代模板"),
    ("MI16", "品类替代边界", "count", "—", "竞争网络 + 标签传播"),
    ("MI17", "品牌属性关联", "npmi", "—", "NPMI"),
    ("MI18", "品牌属性关注度", "count", "品牌三元组", "属性统计"),
    ("MI19", "品牌属性情感", "count", "—", "属性情感"),
    ("MI20", "品牌优势属性", "count", "品牌属性", "负面率阈值"),
    ("MI21", "品牌弱势属性", "count", "品牌属性", "负面率阈值"),
    ("MI22", "品牌定位图", "count", "—", "PCA"),
    ("MI23", "品牌定位相似度", "cosine", "品牌对", "余弦"),
    ("MI24", "价格带结构", "count", "—", "价格抽取"),
    ("MI25", "品牌价格认知", "count", "品牌数", "价格 × 品牌"),
    ("MI26", "属性购买关联", "lift", "购买基准率", "交叉统计"),
    ("MI27", "属性区分能力", "js", "品牌对", "JS 散度"),
    ("MI28", "购买阶段表达结构", "count", "—", "意图分组"),
    ("MI29", "品牌产品迁移", "count", "—", "关系抽取"),
    ("MI30", "品牌竞争演化", "series", "月度数", "时间 × 品牌"),
]

FORMULAS = {
    **dict.fromkeys(("PR03", "PR06", "PR07", "PR08", "PR09", "PR17", "PR18", "PR19", "PR24",
                     "SL02", "SL09", "SL26", "SR13", "OD09", "OD15", "OD17", "OD21", "OD22", "OD23",
                     "OD24", "MI06", "MI07"), "proportion"),
    "MI03": "per_million", "SL08": "signed_proportion", "SL10": "growth", "SL27": "quotient",
    "PR04": "growth", "MI09": "growth", "SL11": "difference", "MI08": "difference",
    "SL12": "proportion", "SL13": "balance",
}

OUTPUTS = {
    "PR13": ("distribution", "scenarios"), "PR20": ("graph", "migration"),
    "PR29": ("ranking", "product_ranking"), "PR30": ("table", "category_compare"),
    "SL14": ("ranking", "neg_drivers"), "SL15": ("clusters", "events"),
    "SL29": ("ranking", "events"), "SL30": ("text_summary", "events"),
    "SR03": ("timeseries", "community_trend"), "SR09": ("matrix", "attr_heatmap"),
    "SR10": ("distribution", "intent_structure"), "SR11": ("distribution", "brand_pref"),
    "SR13": ("distribution", "forms"), "SR30": ("table", "communities"),
    "OD05": ("clusters", "segments"), "OD27": ("graph", "segment_graph"),
    "OD29": ("ranking", "segments"), "MI01": ("hierarchy", "structure"), "MI06": ("distribution", "brands"),
    "MI13": ("graph", "competition"), "MI22": ("matrix", "positioning"),
    "MI30": ("timeseries", "evolution"),
}
DEFINITION_UPDATES = {
    "PR18": ("ratio", "有效需求文档", "明确方案状态与主题相关回复"),
    "SL02": ("ratio", "同范围准入归档帖子", "FTS 线程对账 / Population Ledger"),
    "SL27": ("score/author", "独立有效作者", "净得分求和 / 独立作者数"),
    "OD04": ("docs", "有效需求文档", "明确未满足需求状态"),
    "OD11": ("segments/day", "日级需求片段序列", "Theil–Sen"),
    "OD13": ("count", "具备历史匹配条件的需求簇", "首次观测和历史语义差异"),
    "OD14": ("ratio", "具备历史匹配条件的需求簇", "历史最近质心余弦距离"),
    "OD19": ("lift", "平滑后的独立期望", "有效需求文档内平滑 lift"),
    "OD21": ("ratio", "有效需求文档", "领域品牌提及"),
    "OD22": ("ratio", "有效需求文档", "明确方案状态与主题相关回复"),
    "OD23": ("ratio", "具有关联方案的需求文档", "对已有方案的明确不满"),
    "MI03": ("threads/M", "同范围准入归档帖子", "FTS 线程对账 / Population Ledger"),
    "PR05": ("share/week", "周级有效文档暴露量", "SciPy Theil–Sen 周需求占比"),
    "PR10": ("lift", "含价格/购买信息的同句交易单元及陪集", "FP-Growth / Fisher / BH-FDR"),
    "PR28": ("score", "满足条件的商品候选集合", "商品候选相对分位 + 可复查因子"),
    "PR29": ("count", "满足条件的商品候选集合", "类型化商品与排序"),
    "SL04": ("z", "目标日之前的日声量", "过去窗口滚动 z 分数"),
    "SR08": ("count", "各社区有效文档", "共享主题 + c-TF-IDF + 社区过度表达"),
    "SR23": ("count", "符合最小文档量的社区", "四层互近邻 + NetworkX Louvain"),
    "OD06": ("count", "独立抽取的痛点片段", "Potion + 密度聚类条件路由 + c-TF-IDF"),
    "OD18": ("count", "包含需求证据的句子", "同需求句的属性 FP-Growth / Fisher / BH-FDR"),
    "OD19": ("lift", "包含需求证据的句子", "支持条件下的同句属性组合"),
    "OD20": ("count", "包含需求证据的句子", "同需求句的场景×属性组合"),
    "OD29": ("score", "满足条件的需求簇集合", "需求簇相对分位 + 可复查因子"),
    "OD30": ("clusters", "发现的需求簇", "按簇回溯完整成员与代表原文"),
    "MI17": ("npmi", "核心正文句", "同句类型化目标和属性关联 + FP-Growth"),
    "MI26": ("lift", "核心正文句", "同句实购与属性 + FP-Growth / Fisher / BH-FDR"),
}

MIGRATION_READY = {"SL02", "MI03", "PR01", "PR03", "SL01"}
SUPPORTING = {"PR09", "PR12", "PR13", "PR27", "SR01", "SR03", "SR06", "SR14", "SR15", "SR16",
              "SR17", "OD08", "OD30", "MI02"}
MERGE_CANDIDATES = {"SL17", "SL18", "PR18", "OD22", "PR20", "MI29"}
DOMAIN_RESTRICTED = {"PR08", "PR17", "PR26", "SR11", "OD21", "MI05", "MI06", "MI07", "MI08", "MI09",
                     "MI10", "MI11", "MI13", "MI16", "MI17", "MI18", "MI19", "MI20", "MI21", "MI22", "MI23", "MI25", "MI27", "MI29", "MI30"}
UNRESOLVED = {"SL23", "SR27", "SR28", "MI16"}

REGISTRY: dict[str, dict] = {}
for mid, name, unit, denom, ops in DEFS:
    unit, denom, ops = DEFINITION_UPDATES.get(mid, (unit, denom, ops))
    mod = {"PR": "product", "SL": "listening", "SR": "social", "OD": "opportunity", "MI": "market"}[mid[:2]]
    default_type = {"docs": "count", "ratio": "ratio", "series": "timeseries", "table": "table"}
    output, chart = OUTPUTS.get(mid, (default_type.get(unit, "score" if unit != "count" else "count"), None))
    population = ("archive" if mid in {"SL02", "MI03"} else
                  "sentiment" if mid in {"PR07", "SL08", "SL09"} else
                  "active_need" if mid in {"PR17", "PR18", "OD17", "OD21", "OD22", "OD24"} else "research")
    formula = FORMULAS.get(mid)
    REGISTRY[mid] = {
        "metric_id": mid, "name": name, "module": mod, "module_name": MODULES[mod]["name"],
        "unit": unit, "denominator_rule": denom, "operators": ops,
        "business_name": name, "business_question": name, "description": f"{name}（{ops}）",
        "metric_version": "4.0", "method_version": "4.0", "status": "已接入",
        "implementation_status": "implemented",
        "output_type": output, "chart_key": chart,
        "statistical_unit": "thread" if population == "archive" else denom,
        "population_requirements": population, "dependencies": ops.split(" + "),
        "calculation_method": ops, "numerator_definition": "指标分子" if formula else None,
        "denominator_definition": None if denom == "—" else denom,
        "required_fields": ["archive", "retrieval"] if population == "archive" else ["doc_id", "thread_id"],
        "quality_rules": {"min_support": {"PR08": 20, "PR18": 10, "OD22": 10, "OD23": 10}.get(mid, 0),
                          "exploratory": mid not in FORMULAS},
        "evidence_strategy": "linked_solution" if mid in {"PR18", "OD22"} else "operator_references",
        "parameters": {}, "formula": formula,
        "migration_status": ("Unresolved" if mid in UNRESOLVED else "Ready" if mid in MIGRATION_READY else
                             "Merge Candidate" if mid in MERGE_CANDIDATES else "Domain Restricted" if mid in DOMAIN_RESTRICTED else
                             "Supporting" if mid in SUPPORTING else "Useful Experimental"),
    }


def all_defs() -> list[dict]:
    return [REGISTRY[k] for k in REGISTRY]


def by_module(module: str) -> list[dict]:
    return [r for r in REGISTRY.values() if r["module"] == module]
