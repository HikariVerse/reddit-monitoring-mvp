import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  Menu,
  Palette,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { SiftlineLogo } from '../components/BrandMark';
import { useLogo } from '../components/brandContext';
import { ExploreLiveDemoWidget, ReportExportLiveDemo } from '../components/public-home/ProductMotionDemos';
import { useTheme } from '../components/themeContext';
import { type Platform, validateSearchTerm } from '../contracts/api';
import { useI18n } from '../i18n/translations';

interface HomepageProps {
  isAuthenticated: boolean;
  onOpenAuth: (tab?: 'login' | 'register') => void;
  onEnterWorkbench: (targetPath?: string) => void;
  onGoFeed?: () => void;
  embedded?: boolean;
}

const PLATFORM_OPTIONS: Array<{ value: '' | Platform; label: string; labelZh: string }> = [
  { value: '', label: 'All Sources', labelZh: '全渠道资料' },
  { value: 'reddit', label: 'Reddit Archive & Live', labelZh: 'Reddit 归档与实时' },
  { value: 'x', label: 'X (Twitter)', labelZh: 'X 平台' },
  { value: 'bluesky', label: 'Bluesky', labelZh: 'Bluesky' },
  { value: 'web', label: 'Signal Focus / RSS', labelZh: '信息聚焦 / 资讯源' },
];

const SOLUTIONS_DATA = [
  {
    key: 'one-click-report-export',
    tag: 'ONE-CLICK REPORT EXPORT',
    titleEn: 'Generate grounded reports & export offline interactive HTML',
    titleZh: '一键生成研究报告与零外链离线交互 HTML 导出',
    descEn:
      'Auto-discover authorized sources, run real statistical panels, synthesize BLUF executive conclusions with DeepSeek, and export a standalone interactive HTML file with light/sepia/dark themes, SVG hover tooltips, and an evidence drawer.',
    descZh:
      '自动发现已授权资料并跑通真实统计分析，经 DeepSeek 结论先行核验归纳后，一键导出单文件离线交互 HTML——自带浅色/纸感/深色三主题、SVG 悬停气泡、观点筛选与原文证据抽屉。',
    route: '/reports',
    metric: '4 Templates',
    sub: 'Offline Interactive HTML',
    chartType: 'bars',
  },
  {
    key: 'one-click-explore',
    tag: 'INTELLIGENT EXPLORE',
    titleEn: 'One-click P01–P12 exploration across 31.5M+ archive & live posts',
    titleZh: '一键智能洞察探索：秒级贯通 3,149 万+ 归档与实时社媒',
    descEn:
      'Query multi-month Reddit archives via DuckDB + FTS5 and Potion INT8 semantic clustering alongside live X and project batches, turning any discovery into a saved report with zero recomputation.',
    descZh:
      '基于 DuckDB + FTS5 与 Potion INT8 语义引擎，一键生成 P01–P12 声量趋势、痛点聚类、口碑情感与价格带面板，并支持将探索结果零重算直转研究报告。',
    route: '/explore',
    metric: 'P01–P12',
    sub: 'DuckDB + Potion INT8',
    chartType: 'lines',
  },
  {
    key: 'signal-focus',
    tag: 'SIGNAL FOCUS',
    titleEn: 'Focused multi-source news digests & AI release intelligence',
    titleZh: '信息聚焦：多源去重聚合与 AI 一手发布情报',
    descEn:
      'Track T1/T2 tech media, official AI labs, and developer communities in one focused view with source-tier badges, rising terms, and one-click industry briefing generation.',
    descZh:
      '按频道追踪官方 AI 实验室、工程社区与 T1/T2 科技媒体，自动多源印证去重与热词升温识别，浏览时一键生成行业情报简报。',
    route: '/focus',
    metric: 'Multi-Source',
    sub: 'T1/T2 · Daily Digest',
    chartType: 'bubbles',
  },
  {
    key: 'four-templates-schedule',
    tag: 'WORKBENCH & SCHEDULES',
    titleEn: 'Four business report templates & automated periodic runs',
    titleZh: '四大业务场景模板与自动周期报告调度',
    descEn:
      'Choose Industry Briefing, E-Commerce Research, Social Listening, or Custom Modules, and schedule idempotent daily/weekly automated report generation.',
    descZh:
      '内置行业简报、电商研究、社媒舆情与自定义模块四大场景，支持幂等槽位约束的自动周期报告产出与随时暂停恢复。',
    route: '/reports',
    metric: 'Auto Slot',
    sub: 'Industry · Commerce · Social',
    chartType: 'gauge',
  },
  {
    key: 'project-l1-l2-l3',
    tag: 'RESEARCH SPACE',
    titleEn: 'Five-tab project space with L1/L2/L3 competitive analysis',
    titleZh: '项目五页签研究空间与 L1/L2/L3 竞品深度对比',
    descEn:
      'Organize overview, data pools, Explore/L1–L3 analytics, continuous monitors, and persisted reports in one workspace with Jaccard overlap and distinctive term comparisons.',
    descZh:
      '围绕概览、研究资料、分析与探索、采集与监测、研究报告五大页签沉淀课题，支持多品牌声量、Jaccard 重叠度与差异词量化对比。',
    route: '/projects',
    metric: '5 Tabs',
    sub: 'L1 · L2 · L3 Analytics',
    chartType: 'lines',
  },
  {
    key: 'bounded-collect-monitor',
    tag: 'LIVE COLLECTION & MONITORS',
    titleEn: 'Preflight-budgeted live collection & continuous monitors',
    titleZh: '预检限额实时补采与持续监测闭环',
    descEn:
      'Estimate provider quota before every crawl, run bounded TwitterAPIs/X keyword collection into auto-attached batches, and pause or resume monitors cleanly.',
    descZh:
      '所有外部采集强制预检配额与显式确认，限额拉取 X 等社媒新样本后自动挂接项目并续跑分析，监测计划支持一键暂停与恢复。',
    route: '/sources',
    metric: 'Budget Guard',
    sub: 'Preflight · Pause / Resume',
    chartType: 'gauge',
  },
  {
    key: 'thread-radar',
    tag: 'THREAD RADAR',
    titleEn: 'Inspect nested discussions up to 32 hops deep',
    titleZh: '深层还原最高 32 跳嵌套评论树与原声检索',
    descEn:
      'Switch cleanly between top-scored replies, filter-matched branches, and original poster follow-ups without triggering paid crawls.',
    descZh:
      '在热评排序、条件命中分支与楼主回复三大只读视图间秒级切换，配合痛点筛选与个人批注快速核验原始语境。',
    route: '/content',
    metric: '32 Hops',
    sub: 'Top · Matches · OP',
    chartType: 'bubbles',
  },
  {
    key: 'evidence-grounding',
    tag: 'EVIDENCE GROUNDING',
    titleEn: 'Zero-hallucination citation guard & traceable evidence drawer',
    titleZh: '防虚构引用校验与可溯源原文证据抽屉',
    descEn:
      'Every AI finding is validated against computed metric IDs and real document IDs (E-01..E-xx), with pure-data fallback if an LLM call times out.',
    descZh:
      '每条 AI 结论严格绑定已算指标与真实原文编号（E-01..E-xx），自动剔除无依据引用并在模型超时时无缝降级交付纯数据报告。',
    route: '/reports',
    metric: '100% Grounded',
    sub: 'E-xx Citation Check',
    chartType: 'bars',
  },
  {
    key: 'workspace-rbac',
    tag: 'SECURITY & RBAC',
    titleEn: 'Role-isolated scopes, archive grants & instant revocation',
    titleZh: '三角色权限矩阵、归档显式授权与实时撤权',
    descEn:
      'Isolate private batches and R4 archive grants across accounts, re-verifying permissions on report reads, evidence lookups, and HTML exports.',
    descZh:
      'Owner/Admin/Viewer 严格权限隔离，R4 归档与私有批次按账号显式授权，报告查阅、证据下钻与导出全程实时复核权限。',
    route: '/workspace',
    metric: '3 Roles',
    sub: 'Scope-Level Isolation',
    chartType: 'gauge',
  },
];

const STATS_DATA = [
  {
    num: '12',
    labelEn: 'Intelligent Explore Panels (P01–P12)',
    labelZh: 'P01–P12 一键智能洞察分析面板',
    descEn:
      'Covers volume trends, community engagement, lexical features, Potion INT8 semantic topic clusters, sentiment, active demand, pain points, and price bands.',
    descZh:
      '一键覆盖声量趋势、社区互动、高区分度短语、Potion INT8 语义聚类、情感口碑、主动需求、产品痛点与价格带决策阶段。',
  },
  {
    num: '4',
    labelEn: 'Business Report Templates & Offline HTML Export',
    labelZh: '四大业务报告模板与零外链离线导出',
    descEn:
      'Industry Briefing, E-Commerce Research, Social Listening, and Custom Reports—exportable as standalone interactive HTML with zero external scripts.',
    descZh:
      '涵盖行业简报、电商研究、社媒舆情与自定义报告，一键导出自带主题切换、SVG 气泡、观点筛选与证据抽屉的单文件离线 HTML。',
  },
  {
    num: '31.5M+',
    labelEn: 'Offline Archive Posts + Live Multi-Source Fusion',
    labelZh: '离线社区归档与实时多源融合底座',
    descEn:
      'Combine DuckDB + FTS5 archive discovery with live X collection, Signal Focus RSS digests, and strict role-based access controls.',
    descZh:
      '融合 DuckDB + FTS5 高速历史归档检索、实时社媒限额补采与信息聚焦多源日报，全程保留统计口径与权限边界。',
  },
];

const CHANNEL_PREVIEW_GROUPS = [
  { group: 'AI 一手与研发 · AI Firsthand', descEn: 'Official lab blogs, research releases & engineering notes', descZh: '官方研究博客、一手模型发布与研发动态', color: 'var(--teal)' },
  { group: '工程与基础 · Dev & Infra', descEn: 'Systems engineering, cloud infrastructure & developer tools', descZh: '基础架构、云原生与开发者工具讨论', color: 'var(--wisteria)' },
  { group: '科技与数码 · Tech Media', descEn: 'Technology reporting and product launches across T1/T2 sources', descZh: 'T1/T2 科技媒体报道与产品动态', color: 'var(--teal)' },
  { group: '科研与科普 · Science', descEn: 'Scientific preprints, journals & verified science journalism', descZh: '科研进展、学术期刊与科普来源', color: 'var(--wisteria)' },
  { group: '热榜与趋势 · Social Trends', descEn: 'Cross-community momentum across Reddit, X, Bluesky & HN', descZh: 'Reddit、X、Bluesky 与 HN 跨平台热度讨论', color: 'var(--teal)' },
];

const RESOURCES_DATA = [
  {
    titleEn: 'From One Question to an Offline Interactive HTML Report in Minutes',
    titleZh: '从一个业务问题到单文件离线交互 HTML 报告：全自动研究闭环拆解',
    descEn: 'See how resource discovery, DuckDB/Potion analytics, and BLUF synthesis eliminate manual copy-pasting.',
    descZh: '详解自动资料发现、12 维统计分析与 BLUF 结论先行归纳如何省去人工搬运数据与拼接文案。',
    tags: ['Report Export', 'BLUF Workflow'],
    tone: 'opal',
    route: '/reports',
  },
  {
    titleEn: 'Inside One-Click Explore: P01–P12 Panels Powered by DuckDB + Potion INT8',
    titleZh: '一键智能洞察探索：DuckDB 与 Potion INT8 如何秒级跑通 12 项业务分析',
    descEn: 'Discover how phrase-verified FTS5 queries, stratified sampling, and semantic clustering surface real buyer pain.',
    descZh: '拆解精准短语核验、分层抽样与语义聚类如何从海量讨论中提炼产品痛点、价位带与代表原声。',
    tags: ['Explore P01–P12', 'Semantics'],
    tone: 'dark',
    route: '/explore',
  },
  {
    titleEn: 'Zero-Hallucination Grounding & Pure-Data Fallback Architecture',
    titleZh: '零虚构引用校验与纯数据降级：让每一条 AI 结论都有原声可查',
    descEn: 'How strict scope/metric/evidence ID grounding protects decision quality and handles LLM faults gracefully.',
    descZh: '解析服务端如何逐条核验指标与 E-xx 证据引用，并在模型超时时无缝保留快照交付纯数据报告。',
    tags: ['Grounding', 'Trust & Safety'],
    tone: 'wisteria',
    route: '/reports',
  },
  {
    titleEn: 'Preflight Quotas & Scope Isolation for Multi-Role Research Teams',
    titleZh: '限额预检与范围级撤权：多角色研究团队的数据安全与成本防线',
    descEn: 'Keep paid external collection strictly bounded while enforcing instant permission checks across projects and exports.',
    descZh: '介绍第三方采集预算预检、暂停恢复闭环以及跨账户报告与归档权限实时复核机制。',
    tags: ['Collection Ops', 'RBAC'],
    tone: 'opal',
    route: '/sources',
  },
];

function MiniCardVisual({ type }: { type: string }) {
  if (type === 'gauge') {
    return (
      <div className="hp-sol-mock-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>
          <span>QUOTA &amp; DENSITY</span>
          <span style={{ color: 'var(--teal)' }}>DEMO</span>
        </div>
        <svg viewBox="0 0 180 95" style={{ width: '100%', height: 'auto', margin: '6px 0' }}>
          <path d="M 24 80 A 66 66 0 0 1 156 80" fill="none" stroke="#e9ece6" strokeWidth="14" strokeLinecap="round" />
          <path d="M 24 80 A 66 66 0 0 1 138 35" fill="none" stroke="var(--purple)" strokeWidth="14" strokeLinecap="round" />
          <text x="90" y="72" textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--ink)">
            84%
          </text>
          <text x="90" y="88" textAnchor="middle" fontSize="9" fill="#59645c">
            Safe headroom
          </text>
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
          <span>Daily req: 28/120</span>
          <span>Rev 3</span>
        </div>
      </div>
    );
  }
  if (type === 'bubbles') {
    return (
      <div className="hp-sol-mock-inner">
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>SIGNAL CLUSTERS</div>
        <svg viewBox="0 0 210 118" style={{ width: '100%', height: 'auto' }}>
          <line x1="20" y1="18" x2="195" y2="18" stroke="#eef1ef" />
          <line x1="20" y1="56" x2="195" y2="56" stroke="#eef1ef" />
          <line x1="20" y1="94" x2="195" y2="94" stroke="#eef1ef" />
          <circle cx="62" cy="52" r="24" fill="var(--purple)" opacity="0.88" />
          <circle cx="112" cy="70" r="28" fill="var(--teal)" opacity="0.85" />
          <circle cx="158" cy="40" r="18" fill="var(--wisteria)" opacity="0.92" />
          <circle cx="164" cy="84" r="12" fill="var(--apricot)" opacity="0.9" />
        </svg>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Pain vs. Discussion Density</div>
      </div>
    );
  }
  if (type === 'bars') {
    return (
      <div className="hp-sol-mock-inner">
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>DAILY SIGNAL BUCKETS</div>
        <svg viewBox="0 0 210 112" style={{ width: '100%', height: 'auto' }}>
          {[42, 68, 0, 84, 56, 92, 64].map((h, i) =>
            h === 0 ? (
              <line key={i} x1={18 + i * 26} y1="98" x2={34 + i * 26} y2="98" stroke="#cfd5d1" strokeDasharray="2 2" strokeWidth="2" />
            ) : (
              <rect
                key={i}
                x={18 + i * 26}
                y={98 - h}
                width="16"
                height={h}
                rx="3"
                fill={i % 2 === 0 ? 'var(--purple)' : 'var(--teal)'}
              />
            ),
          )}
        </svg>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Gap days preserved (no zero-fill)</div>
      </div>
    );
  }
  return (
    <div className="hp-sol-mock-inner">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>
        <span>OBSERVATION SNAPSHOTS</span>
        <span style={{ color: 'var(--purple)' }}>kaix · scrapebadger</span>
      </div>
      <svg viewBox="0 0 210 110" style={{ width: '100%', height: 'auto' }}>
        <line x1="12" y1="24" x2="198" y2="24" stroke="#eef1ef" />
        <line x1="12" y1="58" x2="198" y2="58" stroke="#eef1ef" />
        <line x1="12" y1="92" x2="198" y2="92" stroke="#eef1ef" />
        <path d="M 14 78 L 52 72 L 94 58 L 138 38 L 194 26" fill="none" stroke="var(--purple)" strokeWidth="2.4" />
        <path d="M 14 86 L 52 80 L 94 74 L 138 66 L 194 52" fill="none" stroke="var(--teal)" strokeWidth="2.2" />
        <path d="M 14 68 L 52 62 L 94 46 L 138 48 L 194 38" fill="none" stroke="var(--apricot)" strokeWidth="2" />
      </svg>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>UTC Daily Time Basis</div>
    </div>
  );
}

export function Homepage({ isAuthenticated, onOpenAuth, onEnterWorkbench, onGoFeed, embedded = false }: HomepageProps) {
  const { lang, setLang, t } = useI18n();
  const { activeLogo, setSwitcherOpen } = useLogo();
  const { palette, setStudioOpen } = useTheme();

  const [scrolled, setScrolled] = useState(false);
  const [openMega, setOpenMega] = useState<'product' | 'solutions' | 'resources' | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Hero query pill
  const [heroQuery, setHeroQuery] = useState('');
  const [heroMode, setHeroMode] = useState<'explore' | 'report'>('report');
  const [heroPlatform, setHeroPlatform] = useState<'' | Platform>('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeFilter, setScopeFilter] = useState('');
  const [heroError, setHeroError] = useState<string | null>(null);

  // Solutions accordion + carousel
  const [expandedSol, setExpandedSol] = useState<string | null>(null);
  const solTrackRef = useRef<HTMLDivElement>(null);
  const resTrackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Stats active row
  const [activeStat, setActiveStat] = useState(0);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-hp-reveal]'));
    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -30px 0px' },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  const handleHeroSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setHeroError(null);
    const trimmed = heroQuery.trim();
    if (trimmed) {
      const err = validateSearchTerm(trimmed);
      if (err) {
        setHeroError(err);
        return;
      }
    }
    if (heroMode === 'report') {
      const qs = new URLSearchParams();
      if (trimmed) qs.set('topic', trimmed);
      onEnterWorkbench(`/reports/new${qs.toString() ? `?${qs.toString()}` : ''}`);
      return;
    }
    const qs = new URLSearchParams();
    if (trimmed) qs.set('q', trimmed);
    if (heroPlatform) qs.set('platform', heroPlatform);
    onEnterWorkbench(`/explore${qs.toString() ? `?${qs.toString()}` : ''}`);
  };

  const scrollTrack = (ref: React.RefObject<HTMLDivElement | null>, dir: -1 | 1) => {
    ref.current?.scrollBy({ left: dir * 430, behavior: 'smooth' });
  };

  const filteredPlatforms = PLATFORM_OPTIONS.filter((p) =>
    `${p.label} ${p.labelZh} ${p.value}`.toLowerCase().includes(scopeFilter.toLowerCase()),
  );

  return (
    <div ref={rootRef} className="hp-root" onClick={() => scopeOpen && setScopeOpen(false)}>
      {!embedded && (
        <>
          {/* Top Announcement Ribbon */}
          <div className="hp-promo-strip">
            <strong>{t('EXPLORE SIFTLINE', '探索 SIFTLINE')}</strong>
            <span>
              {t(
                'The unified social, community & thread-aware market intelligence workbench',
                '面向社区讨论树、多渠道观测与痛点信号的统一市场情报工作台',
              )}
            </span>
          </div>

          {/* Sticky Semrush-Style Header */}
          <header className={`hp-header-wrap ${scrolled ? 'scrolled' : ''} ${openMega ? 'menu-open' : ''}`}>
        <div className="hp-header">
          <div className="hp-brand-cluster">
            <button
              type="button"
              className="hp-logo-btn"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <SiftlineLogo
                size={28}
                fontSize={20}
                subLabel={t('Market Intelligence', '市场信号情报')}
              />
            </button>
            <button
              type="button"
              className="hp-mark-pill"
              onClick={() => setSwitcherOpen(true)}
              title={t('Switch among 30 brand SVG marks', '切换 30 套品牌图标方案')}
            >
              <span>
                {activeLogo.num}/30
              </span>
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              className="hp-mark-pill"
              onClick={() => setStudioOpen(true)}
              title={t('Switch brand color palette presets or customize colors', '切换品牌配色预设或自定义颜色替换')}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 99,
                  background: palette.accent,
                  border: '1px solid rgba(0,0,0,0.2)',
                  display: 'inline-block',
                }}
              />
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 99,
                  background: palette.accent2,
                  marginLeft: -5,
                  border: '1px solid rgba(0,0,0,0.15)',
                  display: 'inline-block',
                }}
              />
              <Palette size={11} />
              <span>{lang === 'zh' ? palette.nameZh.split(' ')[0] : palette.nameEn.split(' ')[0]}</span>
              <ChevronDown size={12} />
            </button>
          </div>

          <nav className="hp-nav" aria-label="Main navigation">
            <button
              type="button"
              className={`hp-nav-item ${openMega === 'product' ? 'active' : ''}`}
              onClick={() => setOpenMega(openMega === 'product' ? null : 'product')}
            >
              {t('Product', '产品矩阵')} <ChevronDown size={14} />
            </button>
            <a className="hp-nav-item" href="#capabilities" onClick={() => setOpenMega(null)}>
              {t('Capabilities', '能力体系')}
            </a>
            <button
              type="button"
              className={`hp-nav-item ${openMega === 'solutions' ? 'active' : ''}`}
              onClick={() => setOpenMega(openMega === 'solutions' ? null : 'solutions')}
            >
              {t('Solutions', '场景方案')} <ChevronDown size={14} />
            </button>
            <button
              type="button"
              className={`hp-nav-item ${openMega === 'resources' ? 'active' : ''}`}
              onClick={() => setOpenMega(openMega === 'resources' ? null : 'resources')}
            >
              {t('Resources', '研究资源')} <ChevronDown size={14} />
            </button>
            {onGoFeed && (
              <button
                type="button"
                className="hp-nav-item"
                onClick={() => {
                  setOpenMega(null);
                  onGoFeed();
                }}
              >
                {t('Read Stories', '阅读信息流')}
              </button>
            )}
            <button
              type="button"
              className="hp-nav-item"
              onClick={() => {
                setOpenMega(null);
                onEnterWorkbench('/projects');
              }}
            >
              {t('Workbench', '进入工作台')} <ArrowUpRight size={14} />
            </button>
          </nav>

          <div className="hp-actions">
            <button
              type="button"
              className="hp-lang-chip"
              onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
              title="Toggle EN / 中文"
            >
              {lang === 'en' ? '中文' : 'EN'}
            </button>
            {onGoFeed && (
              <button
                type="button"
                className="sr-btn sr-btn--outline sr-btn--sm"
                onClick={onGoFeed}
              >
                {t('Read Stories', '阅读信息流')}
              </button>
            )}
            <button
              type="button"
              className="sr-btn sr-btn--outline sr-btn--sm"
              onClick={() => onOpenAuth('login')}
            >
              {isAuthenticated ? t('Switch Account', '切换账号') : t('Log In', '登录')}
            </button>
            <button
              type="button"
              className="sr-btn sr-btn--dark sr-btn--sm"
              onClick={() => onEnterWorkbench('/projects')}
            >
              {isAuthenticated ? t('Open Workbench', '打开工作台') : t('Start for free', '立即体验')}
            </button>
          </div>

          <button
            type="button"
            className="hp-mobile-toggle"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        {/* Mega Menus (Semrush 4-column + featured card) */}
        {openMega && (
          <div className="hp-megamenu" onMouseLeave={() => setOpenMega(null)}>
            <div className="hp-megamenu-inner">
              {openMega === 'product' && (
                <>
                  <div className="hp-mega-col">
                    <h4>{t('Monitoring & Overview', '项目监测与总览')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/projects'); }}>
                        {t('Projects Overview', '监测项目概览')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/projects'); }}>
                        {t('Daily Facets & Trends', 'UTC 分日趋势分析')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/projects'); }}>
                        {t('Cross-Provider Attribution', '跨渠道发现归因')}
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Research & Discovery', '内容检索与深挖')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content'); }}>
                        {t('Content Explorer', '内容流检索台')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?signal=pain'); }}>
                        {t('Pain Signal Filter', '中英文痛点信号筛选')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content'); }}>
                        {t('3-View Thread Tree', '三视图讨论评论树')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content'); }}>
                        {t('Batch Reddit Hydration', 'Reddit 批量评论水合')}
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Collection & Quotas', '来源与预算治理')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/sources'); }}>
                        {t('Sources & Capabilities', '采集来源与能力约束')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/sources'); }}>
                        {t('Push Ingest (1 MiB)', '外部标准化推流导入')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/sources'); }}>
                        {t('Provider Budgets', '渠道日/月预算额度')}
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Workspace & Access', '工作区与权限')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/workspace'); }}>
                        {t('Saved Queries & Notes', '保存查询与个人批注')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/settings'); }}>
                        {t('Machine API Keys', '机器 API 密钥管理')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/settings'); }}>
                        {t('Invite Codes (RBAC)', '团队邀请码与角色矩阵')}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {openMega === 'solutions' && (
                <>
                  <div className="hp-mega-col">
                    <h4>{t('By Use Case', '按研究场景')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?signal=pain'); }}>
                        {t('Buyer Pain Discovery', '客户痛点与抱怨挖掘')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?signal=discussion'); }}>
                        {t('High-Engagement Threads', '高热讨论帖跟踪')}
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('By Platform', '按目标平台')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?platform=reddit'); }}>Reddit (kaix / red_crawler)</button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?platform=x'); }}>X (twitterapis / scrapebadger)</button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content?platform=bluesky'); }}>Bluesky AppView</button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('By Team Role', '按团队角色')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/settings'); }}>Owner · Governance &amp; Admin Invites</button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/sources'); }}>Admin · Collection &amp; Quotas</button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/workspace'); }}>Viewer · Read &amp; Annotations</button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Data Exports', '流式导出')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content'); }}>
                        {t('Verified JSON Stream', '校验完整性的 JSON 导出')}
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/content'); }}>
                        {t('Formula-Safe CSV', '防公式注入 CSV 导出')}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {openMega === 'resources' && (
                <>
                  <div className="hp-mega-col">
                    <h4>{t('Data Standards', '数据口径规范')}</h4>
                    <div className="hp-mega-links">
                      <a className="hp-mega-link" href="#index" onClick={() => setOpenMega(null)}>
                        {t('Stored-Sample Coverage', '已存样本口径声明')}
                      </a>
                      <a className="hp-mega-link" href="#stats" onClick={() => setOpenMega(null)}>
                        {t('Non-Zero-Fill Trends', '空缺日期不补零原则')}
                      </a>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('API Contracts', '接口与系统探针')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/settings'); }}>
                        OpenAPI 3.0 Inspector
                      </button>
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onEnterWorkbench('/settings'); }}>
                        /healthz &amp; /readyz Probes
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Brand System', '品牌设计')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); setSwitcherOpen(true); }}>
                        {t('Explore 30 Logo Concepts', '浏览 30 套 SVG 品牌图标')}
                      </button>
                    </div>
                  </div>
                  <div className="hp-mega-col">
                    <h4>{t('Quick Launch', '快速开始')}</h4>
                    <div className="hp-mega-links">
                      <button className="hp-mega-link" onClick={() => { setOpenMega(null); onOpenAuth('register'); }}>
                        {t('Redeem Invite Code', '使用邀请码注册')}
                      </button>
                    </div>
                  </div>
                </>
              )}

              <div className="hp-mega-feature">
                <div className="hp-mega-feature-mock">
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                    <span>SIGNAL GATEWAY</span>
                    <span className="wb-pill wb-pill--purple">v1</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                    {t('Direct access to Siftline datasets via Machine Keys', '通过受限机器密钥直连 Siftline 数据网关')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>43-char Bearer · SHA-256 hashed</div>
                </div>
                <button
                  type="button"
                  className="hp-mega-link"
                  style={{ fontWeight: 700, color: 'var(--ink)' }}
                  onClick={() => {
                    setOpenMega(null);
                    onEnterWorkbench('/settings');
                  }}
                >
                  {t('Configure API Keys →', '前往配置机器密钥 →')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Mobile Menu Drawer */}
        {mobileMenuOpen && (
          <div style={{ background: 'var(--white)', borderTop: '1px solid var(--wb-border)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <button className="hp-mega-link" onClick={() => { setMobileMenuOpen(false); onEnterWorkbench('/projects'); }}>{t('Projects Overview', '监测项目概览')}</button>
            <button className="hp-mega-link" onClick={() => { setMobileMenuOpen(false); onEnterWorkbench('/content'); }}>{t('Content Explorer', '内容检索与评论树')}</button>
            <button className="hp-mega-link" onClick={() => { setMobileMenuOpen(false); onEnterWorkbench('/sources'); }}>{t('Sources & Budgets', '来源采集与预算')}</button>
            <button className="hp-mega-link" onClick={() => { setMobileMenuOpen(false); setSwitcherOpen(true); }}>{t('Switch Brand Logo (30)', '更换品牌图标 (30选1)')}</button>
            <button className="hp-mega-link" onClick={() => { setMobileMenuOpen(false); setStudioOpen(true); }}>{t('Color Palette Studio', '更换首页配色方案')}</button>
            <div style={{ display: 'flex', gap: 10, paddingTop: 10, borderTop: '1px solid var(--wb-border-soft)' }}>
              <button className="sr-btn sr-btn--outline sr-btn--sm" style={{ flex: 1 }} onClick={() => { setMobileMenuOpen(false); onOpenAuth('login'); }}>
                {t('Log In', '登录')}
              </button>
              <button className="sr-btn sr-btn--dark sr-btn--sm" style={{ flex: 1 }} onClick={() => { setMobileMenuOpen(false); onEnterWorkbench('/projects'); }}>
                {t('Workbench', '工作台')}
              </button>
            </div>
          </div>
        )}
      </header>
        </>
      )}

      {/* Hero Band (Mineral Opal -> Soft Wisteria gradient + Concentric Texture) */}
      <div className="hp-hero-band">
        <div className="hp-hero-bg" aria-hidden="true">
          <div className="hp-hero-rings" />
          <div className="hp-hero-rings hp-hero-rings--left" />
          <div className="hp-hero-slash" />
        </div>
        <section className="hp-hero">
          <div className="hp-hero-kicker">
            <span className="hp-live-dot" aria-hidden="true" />
            <span>
              {t(
                'One-Click Intelligent Explore · Automated Report & Offline HTML Export',
                '一键智能洞察探索 · 自动生成可溯源报告与离线交互 HTML 导出',
              )}
            </span>
          </div>
          <h1>
            {t(
              'Explore social signals. Export evidence-backed reports in one click.',
              '一键智能洞察探索，自动生成可溯源研究报告',
            )}
          </h1>
          <p className="hp-hero-sub">
            {t(
              'Connect 31.5M+ archived community discussions, live social channels, and Signal Focus digests—run P01–P12 analytics, synthesize grounded insights, and export standalone offline interactive HTML reports.',
              '贯通 3,149 万+ 历史社区归档、实时多源社媒与信息聚焦日报。输入研究问题，一键跑通 P01–P12 多维分析、DeepSeek 结论先行归纳与零外链离线交互 HTML 报告导出。',
            )}
          </p>

          {/* Hero Mode Toggle + Pill Search Container */}
          <div className="hp-hero-mode-bar" role="tablist" aria-label={t('Choose launch action', '选择快速启动方式')}>
            <button
              type="button"
              role="tab"
              aria-selected={heroMode === 'report'}
              className={`hp-hero-mode-btn ${heroMode === 'report' ? 'active' : ''}`}
              onClick={() => setHeroMode('report')}
            >
              {t('One-Click Report & Export', '一键生成报告与导出')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={heroMode === 'explore'}
              className={`hp-hero-mode-btn ${heroMode === 'explore' ? 'active' : ''}`}
              onClick={() => setHeroMode('explore')}
            >
              {t('One-Click Intelligent Explore', '一键智能洞察探索')}
            </button>
          </div>

          <form className="hp-search-tray" onSubmit={handleHeroSubmit} onClick={(e) => e.stopPropagation()}>
            <div className="hp-search-input-wrap">
              <Search size={17} color="#7a847e" />
              <input
                value={heroQuery}
                onChange={(e) => {
                  setHeroQuery(e.target.value);
                  setHeroError(null);
                }}
                placeholder={
                  heroMode === 'report'
                    ? t('Enter a business question (e.g. open ear headphones pain points)', '输入业务研究问题（如：开放式耳机用户痛点与口碑）')
                    : t('Enter keyword or phrase to explore (e.g. power station, shokz)', '输入洞察关键词或短语（如：power station、shokz）')
                }
                aria-label="Search market signals"
              />
              {heroMode === 'explore' && (
                <button
                  type="button"
                  className="hp-scope-btn"
                  onClick={() => setScopeOpen((v) => !v)}
                >
                  <span>
                    {heroPlatform
                      ? PLATFORM_OPTIONS.find((p) => p.value === heroPlatform)?.label
                      : t('All', '全渠道')}
                  </span>
                  <ChevronDown size={13} />
                </button>
              )}
            </div>

            {scopeOpen && (
              <div className="hp-scope-popover">
                <input
                  placeholder={t('Filter platform...', '筛选渠道平台...')}
                  value={scopeFilter}
                  onChange={(e) => setScopeFilter(e.target.value)}
                  autoFocus
                />
                {filteredPlatforms.map((opt) => (
                  <button
                    key={opt.value || 'all'}
                    type="button"
                    className={`hp-scope-option ${heroPlatform === opt.value ? 'active' : ''}`}
                    onClick={() => {
                      setHeroPlatform(opt.value);
                      setScopeOpen(false);
                    }}
                  >
                    <span>{lang === 'zh' ? opt.labelZh : opt.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{opt.value || '*'}</span>
                  </button>
                ))}
              </div>
            )}

            <button type="submit" className="sr-btn sr-btn--wisteria sr-btn--lg">
              {heroMode === 'report' ? t('Generate Report', '一键生成报告') : t('Explore Insights', '一键智能探索')}
            </button>
          </form>

          {heroError && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--sem-red)', fontWeight: 600 }}>
              {heroError}
            </div>
          )}

          <div className="hp-hero-hint">
            <span>{t('Try real scenarios:', '快捷体验研究方向：')}</span>
            {(lang === 'zh'
              ? ['开放式耳机用户痛点', '便携式储能电源', 'Claude 编程助手口碑', 'AI 行业动态']
              : ['open ear headphones', 'power station', 'Claude coding workflow', 'AI releases']
            ).map((sample) => (
              <button
                key={sample}
                type="button"
                className="hp-hero-chip"
                onClick={() => {
                  setHeroQuery(sample);
                  setHeroError(null);
                }}
              >
                {sample}
              </button>
            ))}
          </div>
        </section>

        {/* Dual Asymmetric Promo Cards — Spotlight #1: One-Click Explore + Signal Focus */}
        <section className="hp-promo-grid hp-reveal" data-hp-reveal>
          <div className="hp-promo-card hp-promo-card--primary">
            <div className="hp-promo-hatch sem-hatch-wisteria" />
            <div className="hp-promo-copy">
              <div>
                <div className="hp-promo-pill">{t('FEATURE 01 · P01–P12', '核心亮点 01 · P01–P12 全景面板')}</div>
                <h2>{t('One-Click Intelligent Explore', '一键智能洞察探索')}</h2>
              </div>
              <div>
                <p className="hp-promo-desc">
                  {t(
                    'Run DuckDB + FTS5 retrieval and Potion INT8 semantic clustering over 31.5M+ historical threads and live social feeds. Inspect trends, pain clusters, sentiment, price bands, and turn results into a report in one click.',
                    '贯通 3,149 万+ 离线社区归档与实时社媒，一键输出声量趋势、Potion 语义话题、产品痛点、口碑情感与价格带 12 维面板，任意发现直达原声证据并一键转研究报告。',
                  )}
                </p>
                <button
                  type="button"
                  className="sr-btn sr-btn--white"
                  onClick={() => onEnterWorkbench('/explore')}
                >
                  {t('Launch Intelligent Explore', '进入智能洞察探索')}
                </button>
              </div>
            </div>

            {/* Embedded Animated One-Click Explore Showcase */}
            <div className="hp-promo-frame">
              <ExploreLiveDemoWidget
                onExploreTopic={(q) => onEnterWorkbench(`/explore?q=${encodeURIComponent(q)}`)}
              />
            </div>
          </div>

          <div className="hp-promo-card hp-promo-card--secondary">
            <div className="hp-promo-hatch sem-hatch-wisteria" />
            <div style={{ position: 'relative', zIndex: 2 }}>
              <div className="hp-promo-pill hp-promo-pill--ink">{t('SIGNAL FOCUS', '实时聚合 · 每日精选')}</div>
              <h2>{t('Signal Focus', '信息聚焦')}</h2>
            </div>

            {/* Subtle Animated Live Channel Feed Preview */}
            <div className="hp-focus-mini-list" aria-hidden="true">
              {[
                { tag: 'T1', title: t('AI Labs & Model Releases', 'AI 一手发布与研发动态'), meta: t('Multi-source verified', '多源印证去重') },
                { tag: 'HOT', title: t('Tech Media & Industry Pulse', '科技媒体与产业焦点'), meta: t('Rising terms tracked', '热词升温识别') },
                { tag: 'BRIEF', title: t('1-Click Briefing Export', '按当前频道一键出简报'), meta: t('Auto daily/weekly', '支持周期自动生成') },
              ].map((row, idx) => (
                <div key={row.tag} className="hp-focus-mini-row" style={{ animationDelay: `${idx * 160}ms` }}>
                  <span className="hp-focus-mini-tag">{row.tag}</span>
                  <div style={{ minWidth: 0 }}>
                    <strong>{row.title}</strong>
                    <span>{row.meta}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ position: 'relative', zIndex: 2 }}>
              <p className="hp-promo-desc">
                {t(
                  'Read focused stories and daily digests by channel with transparent source tiers, and convert any channel into an industry briefing in one click.',
                  '按频道浏览多源去重的精选事件、热门与日报，清晰呈现来源分级与关联报道，并可一键按当前频道生成行业情报简报。',
                )}
              </p>
              <button
                type="button"
                className="sr-btn sr-btn--outline"
                onClick={onGoFeed}
              >
                {t('Open Signal Focus', '进入信息聚焦')}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Engine & Supply Logo Strip */}
      <section className="hp-logos-band hp-reveal" data-hp-reveal aria-label="Supported engines and data channels">
        {[
          { name: t('31.5M+ Reddit Archive', '3,149 万+ 离线归档'), dot: 'var(--purple)' },
          { name: 'DuckDB + Potion INT8', dot: 'var(--teal)' },
          { name: t('X · TwitterAPIs Live', 'X · 实时限额补采'), dot: '#527bc5' },
          { name: t('Signal Focus · RSS / HN', '信息聚焦 · RSS / HN'), dot: '#d68245' },
          { name: t('DeepSeek Grounded LLM', 'DeepSeek 核验归纳'), dot: 'var(--purple)' },
          { name: t('L1/L2/L3 Research Space', 'L1/L2/L3 专题研究'), dot: 'var(--teal)' },
          { name: t('Offline Interactive HTML', '单文件交互 HTML 导出'), dot: 'var(--ink)' },
        ].map((item) => (
          <div key={item.name} className="hp-source-emblem">
            <span style={{ width: 9, height: 9, borderRadius: 2, background: item.dot, display: 'inline-block' }} />
            <span>{item.name}</span>
          </div>
        ))}
      </section>

      {/* Enterprise Dark Showcase — Spotlight #2: One-Click Report Generation & Offline Interactive HTML Export */}
      <section className="hp-enterprise-wrap hp-reveal" data-hp-reveal>
        <div className="hp-enterprise-card">
          <div className="hp-prism-backdrop" />
          <div className="hp-enterprise-copy">
            <div className="hp-ent-badge">{t('FEATURE 02 · ONE-CLICK REPORT EXPORT', '核心亮点 02 · 一键报告生成与导出')}</div>
            <h2>{t('One-click reports. Interactive offline HTML.', '一键生成报告，离线交互 HTML 随身交付。')}</h2>
            <p>
              {t(
                'Cover Industry Briefings, E-Commerce Research, Social Listening, and Custom Modules. Auto-discover sources, run verified DeepSeek synthesis, and export a zero-dependency interactive HTML report with theme toggles, SVG hover tooltips, finding filters, and a traceable evidence drawer.',
                '覆盖行业情报简报、电商市场研究、社媒舆情洞察与自定义模块四大场景。自动发现资料、完成统计与 DeepSeek 结论先行归纳，一键导出零外链离线交互 HTML——自带浅色/纸感/深色切换、SVG 悬停气泡、观点筛选与原文证据抽屉。',
              )}
            </p>
            <div className="hp-ent-chips">
              <span>{t('4 Business Templates', '4 大业务模板')}</span>
              <span>{t('BLUF Conclusions', 'BLUF 结论先行')}</span>
              <span>{t('Zero-CDN Single HTML', '零外链单文件 HTML')}</span>
              <span>{t('Traceable Evidence Drawer', '可溯源证据抽屉')}</span>
            </div>
            <button
              type="button"
              className="sr-btn sr-btn--outline-light"
              onClick={() => onEnterWorkbench('/reports')}
            >
              {t('Open Report Workbench', '打开报告工作台')}
            </button>
          </div>

          <div className="hp-enterprise-mock">
            <ReportExportLiveDemo
              onLaunchReports={(tpl) => onEnterWorkbench(`/reports/new?template=${tpl}`)}
            />
          </div>
        </div>
      </section>

      {/* Capabilities / 9 Expandable Solutions Carousel (04-solutions & 16-solution-expanded) */}
      <section id="capabilities" className="hp-section">
        <div className="hp-section-top">
          <div>
            <div className="hp-eyebrow">
              {t('CAPABILITIES', '核心能力矩阵')} <span>( 9 )</span>
            </div>
            <h2 className="hp-h2-upper">
              {t('GET THE SIGNAL. FILTER THE NOISE. ACT FIRST.', '捕捉信号。过滤噪音。先人一步决策。')}
            </h2>
          </div>
          <div className="hp-circle-controls">
            <button
              type="button"
              className="hp-circle-btn"
              onClick={() => scrollTrack(solTrackRef, -1)}
              aria-label="Scroll capabilities left"
            >
              <ArrowLeft size={18} />
            </button>
            <button
              type="button"
              className="hp-circle-btn"
              onClick={() => scrollTrack(solTrackRef, 1)}
              aria-label="Scroll capabilities right"
            >
              <ArrowRight size={18} />
            </button>
          </div>
        </div>

        <div ref={solTrackRef} className="hp-solutions-track">
          {SOLUTIONS_DATA.map((sol) => {
            const isOpen = expandedSol === sol.key;
            return (
              <article key={sol.key} className={`hp-sol-card ${isOpen ? 'expanded' : ''}`}>
                <div
                  className="sem-hatch-mint"
                  style={{ position: 'absolute', right: 0, bottom: 0, width: 320, height: 240, pointerEvents: 'none' }}
                />
                <div className="hp-sol-card-head">
                  <div>
                    <div className="hp-sol-tag">{sol.tag}</div>
                    <h3 className="hp-sol-title">{lang === 'zh' ? sol.titleZh : sol.titleEn}</h3>
                  </div>
                  <button
                    type="button"
                    className="hp-sol-toggle"
                    onClick={() => setExpandedSol(isOpen ? null : sol.key)}
                    aria-label={isOpen ? 'Collapse capability card' : 'Expand capability card'}
                    aria-expanded={isOpen}
                  >
                    <Plus size={18} />
                  </button>
                </div>

                <div className="hp-sol-body">
                  {isOpen && (
                    <div className="hp-sol-extra">
                      <p>{lang === 'zh' ? sol.descZh : sol.descEn}</p>
                      <div>
                        <button
                          type="button"
                          className="sr-btn sr-btn--dark"
                          onClick={() => (sol.route === '/focus' && onGoFeed ? onGoFeed() : onEnterWorkbench(sol.route))}
                        >
                          {t('Open Module', '打开对应面板')}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="hp-sol-mock-frame">
                    <MiniCardVisual type={sol.chartType} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Stats & Facts Interactive Highlight Rows (05-stats-top & 06-stats-bottom) */}
      <section id="stats" className="hp-section" style={{ paddingTop: 28 }}>
        <div className="hp-section-top">
          <div>
            <div className="hp-eyebrow">{t('STATS AND FACTS', '系统基线与指标')}</div>
            <h2 className="hp-h2-upper">
              {t('THE ARCHITECTURE BUILT FOR EVIDENCE-FIRST RESEARCH', '为高保真证据研究而生的工程底座')}
            </h2>
          </div>
          <button
            type="button"
            className="sr-btn sr-btn--outline"
            onClick={() => onEnterWorkbench('/settings')}
          >
            {t('Inspect Contracts', '查看系统契约')}
          </button>
        </div>

        <div className="hp-stats-list">
          {STATS_DATA.map((st, idx) => (
            <div
              key={st.num + idx}
              className={`hp-stat-row ${activeStat === idx ? 'active' : ''}`}
              onMouseEnter={() => setActiveStat(idx)}
              onClick={() => setActiveStat(idx)}
            >
              <div className="hp-stat-box">
                <div className="hp-stat-arrow">
                  <ArrowUp size={56} strokeWidth={2.4} />
                </div>
                <div className="hp-stat-num-panel">
                  <div className="hp-stat-num tabular-nums">{st.num}</div>
                  <div className="hp-stat-label">{lang === 'zh' ? st.labelZh : st.labelEn}</div>
                </div>
              </div>
              <p className="hp-stat-desc">{lang === 'zh' ? st.descZh : st.descEn}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Dark Community Signal Visibility Index (07-ai-index-top & 08-ai-index-ranking) */}
      <section id="index" className="hp-index-band hp-reveal" data-hp-reveal>
        <div className="hp-index-curtain" />
        <div className="hp-index-inner">
          <div className="hp-sparkle-badge">
            <Sparkles size={38} color="var(--white)" />
          </div>
          <h2 className="hp-index-title">
            {t('SIGNAL FOCUS CHANNELS', '信息聚焦与社媒阵地')}
          </h2>
          <p className="hp-index-sub">
            {t(
              'Explore where industry breakthroughs, product pain points, and developer debates surface first—then turn any channel into a briefing.',
              '实时追踪行业突破、产品痛点与社区热议最先浮现的阵地，并一键转化为研究简报。',
            )}
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              className="sr-btn sr-btn--wisteria"
              onClick={() => onEnterWorkbench('/explore')}
            >
              {t('One-Click Explore', '一键智能洞察探索')} <ArrowUpRight size={16} />
            </button>
            <button
              type="button"
              className="sr-btn sr-btn--outline-light"
              onClick={onGoFeed}
            >
              {t('Browse Signal Focus', '进入信息聚焦')} <ArrowUpRight size={16} />
            </button>
          </div>

          <div className="hp-leaderboard">
            <div className="hp-lb-head">
              <span>{t('Channel Group', '信息聚焦频道分组')}</span>
              <span>{t('Scope', '覆盖范围')}</span>
              <span className="hp-lb-meta">{t('Live counts in Signal Focus', '实时条数请查看信息聚焦')}</span>
            </div>
            {CHANNEL_PREVIEW_GROUPS.map((row) => (
              <div key={row.group} className="hp-lb-row">
                <span style={{ fontWeight: 500 }}>{row.group}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>
                  {lang === 'zh' ? row.descZh : row.descEn}
                </span>
                <span style={{ fontSize: 11, color: row.color, fontWeight: 600 }}>
                  {t('Configured', '已接入')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Resources Horizontal Carousel (10-resources) */}
      <section className="hp-section hp-reveal" data-hp-reveal style={{ paddingTop: 12 }}>
        <div className="hp-section-top">
          <div>
            <div className="hp-eyebrow">
              {t('RESOURCES', '方法论与指南')} <span>( {RESOURCES_DATA.length} )</span>
            </div>
            <h2 className="hp-h2-upper">
              {t('STAY AHEAD OF WHAT MATTERS', '紧跟真实信号研究范式')}
            </h2>
          </div>
          <div className="hp-circle-controls">
            <button
              type="button"
              className="hp-circle-btn"
              onClick={() => scrollTrack(resTrackRef, -1)}
              aria-label="Scroll resources left"
            >
              <ArrowLeft size={18} />
            </button>
            <button
              type="button"
              className="hp-circle-btn"
              onClick={() => scrollTrack(resTrackRef, 1)}
              aria-label="Scroll resources right"
            >
              <ArrowRight size={18} />
            </button>
          </div>
        </div>

        <div ref={resTrackRef} className="hp-resources-track">
          {RESOURCES_DATA.map((res, idx) => (
            <article
              key={idx}
              className="hp-res-card"
              onClick={() => onEnterWorkbench(res.route)}
            >
              <div
                className="hp-res-cover"
                style={{
                  background:
                    res.tone === 'dark'
                      ? 'var(--dark-section-bg)'
                      : res.tone === 'wisteria'
                        ? 'var(--res-wisteria-bg)'
                        : 'var(--res-opal-bg)',
                  color:
                    res.tone === 'dark'
                      ? 'var(--white)'
                      : res.tone === 'wisteria'
                        ? 'var(--on-accent)'
                        : 'var(--ink)',
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SiftlineLogo size={20} fontSize={14} />
                  <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.7 }}>0{idx + 1}</span>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.15 }}>
                  {res.tags[0]}
                </div>
              </div>
              <h3>{lang === 'zh' ? res.titleZh : res.titleEn}</h3>
              <p>{lang === 'zh' ? res.descZh : res.descEn}</p>
              <div className="hp-res-tags">
                {res.tags.map((tg) => (
                  <span key={tg}>{tg}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Signature Semrush Footer (11-footer) */}
      {!embedded && (
      <footer className="hp-footer">
        <div className="hp-footer-grid">
          <div className="hp-footer-cta">
            <h3>{t('Get started with Siftline today', '立即开始使用 Siftline 工作台')}</h3>
            <p>
              {t(
                'Explore stored-sample projects, thread trees, and source budgets right in the browser.',
                '无需等待后端部署即可预览项目监测、评论树与渠道预算全景。',
              )}
            </p>
            <button
              type="button"
              className="sr-btn sr-btn--wisteria"
              onClick={() => onEnterWorkbench('/projects')}
            >
              {t('Open Live Workbench', '进入信息工作台')}
            </button>
          </div>

          <div className="hp-footer-col">
            <h5>{t('Workbench', '核心工作台')}</h5>
            <ul>
              <li><button onClick={() => onEnterWorkbench('/projects')}>{t('Monitoring Projects', '监测项目面板')}</button></li>
              <li><button onClick={() => onEnterWorkbench('/content')}>{t('Content Explorer', '内容检索与评论树')}</button></li>
              <li><button onClick={() => onEnterWorkbench('/sources')}>{t('Sources & Budgets', '来源采集与预算')}</button></li>
              <li><button onClick={() => onEnterWorkbench('/workspace')}>{t('Personal Workspace', '个人查询与批注')}</button></li>
            </ul>
          </div>

          <div className="hp-footer-col">
            <h5>{t('Collection Ops', '采集管道')}</h5>
            <ul>
              <li><button onClick={() => onEnterWorkbench('/sources')}>Reddit · kaix / red_crawler</button></li>
              <li><button onClick={() => onEnterWorkbench('/sources')}>X · twitterapis / scrapebadger</button></li>
              <li><button onClick={() => onEnterWorkbench('/sources')}>Bluesky AppView</button></li>
              <li><button onClick={() => onEnterWorkbench('/sources')}>Push Ingest (external_ingest)</button></li>
            </ul>
          </div>

          <div className="hp-footer-col">
            <h5>{t('Access & Security', '鉴权与契约')}</h5>
            <ul>
              <li><button onClick={() => onOpenAuth('login')}>{t('Sign In (app_session)', '会话登录')}</button></li>
              <li><button onClick={() => onOpenAuth('register')}>{t('Invite Registration', '邀请码注册')}</button></li>
              <li><button onClick={() => onEnterWorkbench('/settings')}>{t('Machine API Keys', '机器 API 密钥')}</button></li>
              <li><button onClick={() => setSwitcherOpen(true)}>{t('Logo Explorer (30)', '图标切换器 (30)')}</button></li>
              <li><button onClick={() => setStudioOpen(true)}>{t('Color Palette Studio', '配色替换工作台')}</button></li>
            </ul>
          </div>

          <div className="hp-footer-col">
            <h5>{t('Language', '界面语言')}</h5>
            <ul>
              <li><button onClick={() => setLang('en')}>English (US)</button></li>
              <li><button onClick={() => setLang('zh')}>简体中文 (ZH)</button></li>
            </ul>
          </div>
        </div>

        <div className="hp-footer-legal">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <SiftlineLogo size={22} fontSize={16} />
            <span>© 2026 SIFTLINE · Contract-aligned Frontend Prototype (prod@dd2feb2)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <span>Active Mark: {activeLogo.num} / {activeLogo.name}</span>
            <button
              type="button"
              className="hp-lang-chip"
              onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
            >
              {lang === 'en' ? 'English ▾' : '简体中文 ▾'}
            </button>
          </div>
        </div>

        <div className="hp-footer-wordmark-band">
          <div className="hp-footer-lines" />
          <div className="hp-giant-wordmark">SIFTLINE</div>
        </div>
      </footer>
      )}
    </div>
  );
}
