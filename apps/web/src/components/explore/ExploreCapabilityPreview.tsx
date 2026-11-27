import { Network, Sparkles, Target, TrendingUp, Users } from 'lucide-react';
import type { ExploreScenarioId } from '../../../../../packages/contracts/src/explore';
import { useI18n } from '@/i18n/translations';
import { Badge } from '../ui/badge';
import { Card, CardContent } from '../ui/card';

function PreviewMiniGraphic({ id }: { id: ExploreScenarioId }) {
  if (id === 'pulse') {
    return (
      <svg className="explore-preview-graphic" width="76" height="36" viewBox="0 0 76 36" fill="none" aria-hidden="true">
        <path d="M4 30 L18 22 L30 25 L44 13 L56 17 L72 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 30 L18 22 L30 25 L44 13 L56 17 L72 6 L72 34 L4 34 Z" fill="currentColor" fillOpacity="0.1" />
      </svg>
    );
  }
  if (id === 'audience') {
    return (
      <svg className="explore-preview-graphic" width="76" height="36" viewBox="0 0 76 36" fill="none" aria-hidden="true">
        <rect x="4" y="4" width="66" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.82" />
        <rect x="4" y="15" width="46" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.55" />
        <rect x="4" y="26" width="28" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.28" />
      </svg>
    );
  }
  if (id === 'topics') {
    return (
      <svg className="explore-preview-graphic" width="76" height="40" viewBox="0 0 76 40" fill="none" aria-hidden="true">
        <line x1="14" y1="22" x2="32" y2="10" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="32" y1="10" x2="52" y2="18" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="14" y1="22" x2="36" y2="31" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="36" y1="31" x2="52" y2="18" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <line x1="52" y1="18" x2="66" y2="30" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <circle cx="14" cy="22" r="5" fill="currentColor" fillOpacity="0.85" />
        <circle cx="32" cy="10" r="4" fill="currentColor" fillOpacity="0.6" />
        <circle cx="52" cy="18" r="6" fill="currentColor" fillOpacity="0.95" />
        <circle cx="36" cy="31" r="3.5" fill="currentColor" fillOpacity="0.45" />
        <circle cx="66" cy="30" r="4" fill="currentColor" fillOpacity="0.35" />
      </svg>
    );
  }
  return (
    <svg className="explore-preview-graphic" width="76" height="36" viewBox="0 0 76 36" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="52" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.55" />
      <rect x="4" y="15" width="38" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.35" />
      <rect x="4" y="26" width="58" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.82" />
      <circle cx="69" cy="7.2" r="2.5" fill="currentColor" fillOpacity="0.35" />
      <circle cx="69" cy="18.2" r="2.5" fill="currentColor" fillOpacity="0.55" />
      <circle cx="69" cy="29.2" r="2.5" fill="currentColor" fillOpacity="0.82" />
    </svg>
  );
}

const PREVIEW_TILES: readonly {
  id: ExploreScenarioId;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  icon: typeof TrendingUp;
}[] = [
  {
    id: 'pulse',
    titleEn: 'Market Pulse & Scale',
    titleZh: '市场热度与讨论全局',
    descEn: 'Volume trend · Anomalies · Discussion activity',
    descZh: '声量趋势 · 异常变化 · 讨论活跃度',
    icon: TrendingUp,
  },
  {
    id: 'audience',
    titleEn: 'Audience & Language',
    titleZh: '受众社区与语言特征',
    descEn: 'Source mix · Communities · Distinctive terms',
    descZh: '来源分布 · 社区画像 · 高频表达',
    icon: Users,
  },
  {
    id: 'topics',
    titleEn: 'Topics & Rhythm',
    titleZh: '主题聚类与时空节律',
    descEn: 'Topic clusters · Semantic links · Time rhythm',
    descZh: '主题归纳 · 语义关联 · 时间分布',
    icon: Network,
  },
  {
    id: 'voice',
    titleEn: 'Voice, Demand & Pricing',
    titleZh: '口碑、需求与商业机会',
    descEn: 'Sentiment · Pain points · Price attention',
    descZh: '情绪线索 · 用户痛点 · 价格关注',
    icon: Target,
  },
];

export function ExploreCapabilityPreview() {
  const { t } = useI18n();
  return (
    <Card className="explore-surface-card gap-0 py-0 shadow-xs">
      <CardContent className="p-0">
        <div className="explore-preview-head">
          <div>
            <h2 className="explore-preview-title">
              <Sparkles size={16} className="text-primary" />
              <span>{t('Start with a Question', '从一个问题开始')}</span>
            </h2>
            <p className="explore-card-desc">
              {t(
                'Once exploration finishes, results, exact evidence, and next-step guidance will appear based on data availability.',
                '探索完成后，系统将按数据可用性展示分析结果、证据与后续挖掘方向。',
              )}
            </p>
          </div>
          <Badge variant="outline" className="rounded-full px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {t('Capability Preview', '能力预览')}
          </Badge>
        </div>

        <div className="explore-preview-grid">
          {PREVIEW_TILES.map((tile) => {
            const Icon = tile.icon;
            return (
              <div key={tile.id} className="explore-preview-tile">
                <div className="explore-preview-tile-left">
                  <div className="explore-preview-icon">
                    <Icon size={17} />
                  </div>
                  <div className="min-w-0">
                    <div className="explore-preview-tile-title">{t(tile.titleEn, tile.titleZh)}</div>
                    <p className="explore-preview-tile-desc">{t(tile.descEn, tile.descZh)}</p>
                  </div>
                </div>
                <PreviewMiniGraphic id={tile.id} />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
