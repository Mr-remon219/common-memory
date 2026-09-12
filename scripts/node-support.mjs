// Keep in sync with package.json engines: Node 22.19+ on the 22 line, or 24+.
export const nodeRange = '^22.19.0 || >=24.0.0';
export function supportsNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major === 22 && minor >= 19 || major >= 24;
}
