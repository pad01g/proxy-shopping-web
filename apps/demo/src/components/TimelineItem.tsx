import type { TimelineEntry } from '@proxy-shopping/core/browser';
import { useT } from '../i18n';
import { timelineLine } from '../i18n/timeline';
import { formatTime } from '../lib/format';

/**
 * One line of an order's or a case's timeline, rendered from its kind in the page's language. Values that
 * are data (another party's words, core's error messages) and the original text of unknown kinds are shown
 * as they are, marked data-i18n-exempt.
 */
export function TimelineItem({ entry, testid }: { entry: TimelineEntry; testid?: string }) {
  const m = useT();
  const l = timelineLine(entry, m);
  return (
    <li data-testid={testid} data-kind={entry.kind}>
      <time>{formatTime(entry.at)}</time>
      {l.original ? (
        <span data-i18n-exempt="unknown timeline kind">{l.text}</span>
      ) : (
        <>
          {l.text}
          {l.data !== undefined && <span data-i18n-exempt="timeline value">{l.data}</span>}
          {l.tail}
        </>
      )}
    </li>
  );
}
