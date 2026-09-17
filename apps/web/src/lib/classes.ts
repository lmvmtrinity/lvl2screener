/** Joins utility class strings without template-literal interpolation.
 *
 *  Tailwind detects classes by scanning source text, so a class immediately
 *  followed by `${...}` in a template literal can be missed. Passing every
 *  class as its own string keeps detection reliable. */
export function classes(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}
