/** Moves an element into another one (the map, say) while its component owns it. */
export function portal(node: HTMLElement, target: HTMLElement | null | undefined) {
  const move = (t: HTMLElement | null | undefined) => { if (t) t.appendChild(node); };
  move(target);
  return {
    update: move,
    destroy: () => node.remove(),
  };
}
