export const AUTHORITY_PATH_PATTERNS = [
  /^repository\.yaml$/,
  /^schema\/(?:repository|fact|proposal|review)\.v1\.schema\.json$/,
  /^memory\/facts\/fact\.[A-Za-z0-9_-]{8,128}\.yaml$/,
  /^memory\/proposals\/proposal\.[A-Za-z0-9_-]{8,128}\.yaml$/,
  /^memory\/reviews\/review\.[A-Za-z0-9_-]{8,128}\.yaml$/
] as const;
export function isAllowedAuthorityPath(path: string): boolean { return AUTHORITY_PATH_PATTERNS.some((pattern) => pattern.test(path)); }
