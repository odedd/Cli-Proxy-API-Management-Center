import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** Balance is not availability: shared scopes count once; paused grants remain banked. */
export function bankedClaudeResets(
  status: AnthropicResetGrantStatus | null | undefined,
  now: number
) {
  if (!status) return null;
  return status.grants.reduce(
    (sum, grant) =>
      (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
      (!grant.endsAt || Date.parse(grant.endsAt) > now)
        ? sum + grant.resetsLeft
        : sum,
    0
  );
}

/** Prefer the upstream recommendation; otherwise use stable ID ordering. */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return undefined;
  const usable = status.grants.filter(
    (grant) =>
      !anthropicResetGrantBlocker(status, grant.id) &&
      (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
      (!grant.endsAt || Date.parse(grant.endsAt) > now)
  );
  return (
    usable.find((grant) => grant.id === status.nextGrantId) ??
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  );
}
