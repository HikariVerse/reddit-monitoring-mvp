export const explorePath = (project: string, reference?: string) => '/explore?' + new URLSearchParams({
  projectId: project, ...(reference ? { archiveRefId: reference } : {}),
}).toString();
