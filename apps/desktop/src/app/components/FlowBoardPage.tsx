import { Navigate, useParams, useSearchParams } from 'react-router';

/** Keep saved production links opening the unified editing workspace with the workflow board view. */
export function FlowBoardPage() {
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.delete('agent');
  next.set('view', 'workflow');
  return <Navigate replace to={projectId ? `/editor/${projectId}?${next}` : '/'} />;
}
