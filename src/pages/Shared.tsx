import { Navigate, useParams } from 'react-router-dom';
import { decodeConfig } from '../workspace/shareCodec';

/** Shared links open the workspace with the decoded configuration. */
export default function Shared() {
  const { payload } = useParams();
  const cfg = payload ? decodeConfig(payload) : null;
  if (!cfg)
    return (
      <div className="page narrow empty-state">
        <h1>This shared link could not be read</h1>
        <p>It may have been cut off when it was copied.</p>
      </div>
    );
  return <Navigate replace to={`/lab/${cfg.e ?? 'shared'}?cfg=${payload}`} />;
}
