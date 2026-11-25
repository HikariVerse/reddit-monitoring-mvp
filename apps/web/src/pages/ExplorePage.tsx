import { useProjectsQuery } from '../api/hooks';
import { explorePath } from '../lib/archiveRoutes';
import { ProjectArchiveSearch } from '../components/ArchiveWorkspace';
import { Alert } from '../components/ui/alert';
import { Select } from '../components/ui/select';
import { useI18n } from '../i18n/translations';

export function ExplorePage({ search, onNavigate }: { search: string; onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  const params = new URLSearchParams(search);
  const requested = params.get('projectId');
  const projects = useProjectsQuery(true);
  const project = projects.data?.projects.find(item => item.id === requested);
  return <section className="archive-explore archive-stack">
    <header className="archive-actions archive-explore-header">
      <div><h1>{t('Explore', '探索')}</h1><p>{t('Explore offline Reddit archives', '离线 Reddit 归档数据探索')}</p></div>
      {project && <a href={`/projects?view=collect&archive=1&projectId=${encodeURIComponent(project.id)}`}>{t('Back to Data Intake', '返回数据接入')}</a>}
    </header>
    <div className="ds-card archive-stack archive-explore-panel">
      {projects.isPending && <p role="status">{t('Loading projects…', '正在读取项目…')}</p>}
      {projects.error && <Alert role="alert">{projects.error.message}</Alert>}
      {projects.data && <label className="wb-field">
        {t('Current project', '当前项目')}
        <Select value={project?.id ?? ''} onChange={event => {
          if (event.target.value) onNavigate(explorePath(event.target.value));
        }}>
          <option value="">{t('Select a project', '选择项目')}</option>
          {projects.data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>}
      {projects.isSuccess && !project && <p>{requested
        ? t('The requested project is unavailable.', '无法访问指定项目。')
        : t('Select a project to see its archive links.', '选择项目以查看已关联的归档。')}</p>}
      {project && <ProjectArchiveSearch key={project.id} project={project.id} refId={params.get('archiveRefId')} onNavigate={onNavigate} />}
    </div>
  </section>;
}
