/**
 * Host half of the bundle.
 *
 * Everything this plugin does happens in the browser: the composer button reads
 * the draft, asks the local engine for a translation and submits it. No Host
 * service, tool or event is involved, so `apply` stays empty — but the bundle
 * still needs a Host entry so the Loader has a row to load.
 */
export function apply() {}
