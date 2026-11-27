import { ExploreInsightsWorkspace } from '../components/explore/ExploreInsightsWorkspace';

export function ExplorePage({ search, onNavigate }: { search: string; onNavigate: (path: string) => void }) {
  const params = new URLSearchParams(search);
  return (
    <ExploreInsightsWorkspace
      initialProjectId={params.get('projectId') ?? undefined}
      initialArchiveRefId={params.get('archiveRefId') ?? undefined}
      initialStudyId={params.get('studyId') ?? undefined}
      initialQuery={params.get('query') ?? undefined}
      returnTo={params.get('returnTo') ?? undefined}
      onNavigate={onNavigate}
    />
  );
}
