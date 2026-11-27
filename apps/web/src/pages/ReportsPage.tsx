import { ReportDetailView } from '../components/reports/ReportDetailView';
import { ReportLibraryView } from '../components/reports/ReportLibraryView';
import { ReportRunProgressView } from '../components/reports/ReportRunProgressView';
import { ReportSchedulesPanel } from '../components/reports/ReportSchedulesPanel';
import { ReportWorkbenchView } from '../components/reports/ReportWorkbenchView';

export function ReportsPage({
  rawPathname,
  search,
  onNavigate,
}: {
  rawPathname: string;
  search: string;
  onNavigate: (path: string) => void;
}) {
  const sp = new URLSearchParams(search);
  const view = sp.get('view') || '';

  if (rawPathname === '/reports/new') {
    return <ReportWizardViewWrapper search={search} onNavigate={onNavigate} />;
  }
  const runMatch = /^\/reports\/runs\/([a-f0-9-]{36})$/i.exec(rawPathname);
  if (runMatch) {
    return <ReportRunProgressView runId={runMatch[1]} onNavigate={onNavigate} />;
  }
  const reportMatch = /^\/reports\/([a-f0-9-]{36})$/i.exec(rawPathname);
  if (reportMatch) {
    return <ReportDetailView reportId={reportMatch[1]} onNavigate={onNavigate} />;
  }
  if (view === 'list') {
    return (
      <div className="ds-page" style={{ display: 'grid', gap: 16 }}>
        <ReportLibraryView onNavigate={onNavigate} />
        <ReportSchedulesPanel onNavigate={onNavigate} />
      </div>
    );
  }
  return <ReportWorkbenchView onNavigate={onNavigate} />;
}

import { ReportWizardView } from '../components/reports/ReportWizardView';

function ReportWizardViewWrapper({ search, onNavigate }: { search: string; onNavigate: (path: string) => void }) {
  return <ReportWizardView search={search} onNavigate={onNavigate} />;
}
