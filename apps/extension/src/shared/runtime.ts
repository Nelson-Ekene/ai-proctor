import type { InternalRequest, InternalResponse } from '../messages';

/** Sends a typed message from an extension page to the service worker. */
export function send(request: InternalRequest): Promise<InternalResponse> {
  return chrome.runtime.sendMessage<InternalRequest, InternalResponse>(request);
}

/** Small DOM helper for extension pages (textContent only, never innerHTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string; id?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className !== undefined) node.className = props.className;
  if (props.id !== undefined) node.id = props.id;
  node.append(...children);
  return node;
}
