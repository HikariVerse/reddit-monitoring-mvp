import { ExploreInsightsWorkspace } from '../components/explore/ExploreInsightsWorkspace';

export function ExplorePage({ search }: { search: string; onNavigate: (path: string) => void }) {
  const params = new URLSearchParams(search);
  const requested = params.get('projectId');
  return <ExploreInsightsWorkspace initialProjectId={requested ?? undefined} />;
}
