export function countAccessRules(policy) {
  return (policy.acls?.length ?? 0) + (policy.grants?.length ?? 0);
}
