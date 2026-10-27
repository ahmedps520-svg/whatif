import { FULL_SITE_URL } from '../lib/target';

/** Shown in the preview build where a feature needs the full site. */
export function FullSiteNote({ text }: { text: string }) {
  return (
    <p className="small muted full-site-note">
      {text} on the full site:{' '}
      <a href={FULL_SITE_URL} target="_blank" rel="noreferrer">
        {FULL_SITE_URL.replace('https://', '')}
      </a>
    </p>
  );
}
