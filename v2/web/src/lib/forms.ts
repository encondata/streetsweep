/**
 * A form's values as the browser holds them. Safari's autofill can fill a box without
 * firing `input`, so bound state may lag behind what's on screen; submit handlers read
 * the form itself and take these over the bound copies.
 */
export function formValues(el: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new FormData(el)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Copy the named fields from the submitted form into a bound object. */
export function syncFrom<T extends object>(target: T, el: HTMLFormElement) {
  const vals = formValues(el);
  for (const k of Object.keys(target) as (keyof T & string)[]) if (k in vals) (target as any)[k] = vals[k];
}
