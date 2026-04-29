// Centralised dictionary mapping failure_reason identifiers to UX buckets.
// Source of truth for the dashboard — if swat renames an enum, the regression
// test (failureReasons.test.js) breaks immediately.

const FAILURE_REASONS = {
  cancelled_by_user: {
    bucket: 'cancelled', label: 'Cancelled', icon: '\u{274C}',
    hint: 'User cancelled this operation.', action: null,
  },
  process_exited_without_completion: {
    bucket: 'crashed', label: 'Crashed', icon: '\u{1F4A5}',
    hint: 'The agent exited without writing a completion. Inspect the agent log.',
    action: { label: 'View agent log', file: 'agent.log' },
  },
  classify_spawn_failed: {
    bucket: 'setup', label: 'Setup Failed', icon: '\u{1F6E0}\u{FE0F}',
    hint: 'Could not start the classifier process.',
    action: { label: 'View classify log', file: 'classify.log' },
  },
  classify_move_failed: {
    bucket: 'setup', label: 'Setup Failed', icon: '\u{1F6E0}\u{FE0F}',
    hint: 'Could not move the operation into its squad directory \u2014 usually a transient file lock. Retry.',
    action: { label: 'Retry dispatch', kind: 'redispatch' },
  },
  provision_failed: {
    bucket: 'setup', label: 'Setup Failed', icon: '\u{1F6E0}\u{FE0F}',
    hint: 'Workspace provisioning failed.',
    action: { label: 'View classify log', file: 'classify.log' },
  },
  launch_failed: {
    bucket: 'setup', label: 'Setup Failed', icon: '\u{1F6E0}\u{FE0F}',
    hint: 'Agent could not be launched after provisioning.',
    action: { label: 'View classify log', file: 'classify.log' },
  },
  classify_no_squad: {
    bucket: 'config', label: 'No Squad', icon: '\u{1F4E6}',
    hint: 'Classifier did not match any installed squad. Install or extend a squad\u2019s scope.',
    action: { label: 'Browse squads', href: '#squads' },
  },
  classify_squad_not_installed: {
    bucket: 'config', label: 'Squad Missing', icon: '\u{1F4E6}',
    hint: 'Classified to a squad that is not installed locally.',
    action: { label: 'Install squad', kind: 'install' },
  },
};

const FAILURE_BUCKETS = {
  cancelled: { label: 'Cancelled', dotClass: 'cancelled' },
  crashed:   { label: 'Crashed',   dotClass: 'crashed'   },
  setup:     { label: 'Setup',     dotClass: 'setup'     },
  config:    { label: 'Config',    dotClass: 'config'    },
};

// Resolve a failure_reason string to its bucket info, or null if unknown.
function getFailureBucket(reason) {
  const entry = FAILURE_REASONS[reason];
  if (!entry) return null;
  return FAILURE_BUCKETS[entry.bucket] || null;
}
