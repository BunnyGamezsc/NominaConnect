const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

export const REDIRECT_CODES = Object.freeze([307, 308]);
export const DEFAULT_REDIRECT_CODE = 308;

export function normalizeRedirectTarget(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") {
    throw new Error("Redirect target is required (e.g. home.bunny.internal).");
  }
  let rest = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  rest = rest.replace(/^\/+/, "");
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  let path = slash === -1 ? "" : rest.slice(slash);
  path = path.split(/[?#]/)[0] ?? "";
  if (!HOSTNAME_PATTERN.test(host)) {
    throw new Error(`Invalid redirect target: ${input}. Use a hostname like home.bunny.internal or a URL like https://home.bunny.internal.`);
  }
  if (path !== "" && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(path)) {
    throw new Error(`Invalid redirect target path: ${input}.`);
  }
  const cleanPath = path === "/" ? "" : path.replace(/\/+$/, "");
  return `https://${host}${cleanPath}`;
}

export function normalizeRedirectCode(input) {
  if (input === undefined || input === null || input === "") {
    return DEFAULT_REDIRECT_CODE;
  }
  const code = Number(input);
  if (!REDIRECT_CODES.includes(code)) {
    throw new Error(`Invalid redirect code: ${input}. Use 307 or 308.`);
  }
  return code;
}

export function redirectTargetHost(target) {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
