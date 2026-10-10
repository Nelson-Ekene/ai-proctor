import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// A tiny history router: the dashboard has four screens, so a routing library is not needed.

export type Route =
  | { name: 'sessions' }
  | { name: 'report'; sessionId: string }
  | { name: 'policy' }
  | { name: 'notFound' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '/sessions') return { name: 'sessions' };
  if (pathname === '/policy') return { name: 'policy' };
  const report = /^\/sessions\/([^/]+)$/.exec(pathname);
  if (report?.[1]) return { name: 'report', sessionId: decodeURIComponent(report[1]) };
  return { name: 'notFound' };
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(to: string): void {
  window.history.pushState(null, '', to);
  for (const listener of listeners) listener();
}

/** Current pathname and search string; re-renders on navigation. */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(
    subscribe,
    () => window.location.pathname + window.location.search,
  );
  const url = new URL(href, 'http://local');
  return { pathname: url.pathname, search: url.search };
}

export function Link({
  to,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
