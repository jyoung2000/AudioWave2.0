declare module '*.css';

/**
 * `?inline` hands back the compiled stylesheet as a string instead of injecting it, which is how the
 * styleguide puts each product's own CSS inside a device frame rather than on its own page.
 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
