'use strict';

function assertIssueIdentity(value, binding, location, seen = new Set()) {
  const issueIdentifier = typeof binding === 'string' ? binding : binding.issueIdentifier;
  const workReference = typeof binding === 'string' ? null : binding.workReference;
  const itemId = workReference?.itemId || issueIdentifier;
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const field of ['issueIdentifier', 'itemId', 'workItemId']) {
    if (value[field] != null && String(value[field]) !== (field === 'issueIdentifier' ? issueIdentifier : itemId)) {
      throw new Error(`${location}.${field} must match command.resource.id`);
    }
  }
  if (value.issue?.identifier != null && String(value.issue.identifier) !== issueIdentifier) {
    throw new Error(`${location}.issue.identifier must match command.resource.id`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (['workReference', 'workRef', 'beadsReference'].includes(key) && child != null) {
      const identifier = typeof child === 'string' ? child : child.itemId || child.id || child.ref;
      if (workReference?.authority && typeof child === 'object' && child.authority !== workReference.authority) throw new Error(`${location}.${key} authority must match the host binding`);
      if (identifier == null || String(identifier) !== itemId) throw new Error(`${location}.${key} must match command.resource.id`);
    }
    if (child && typeof child === 'object') assertIssueIdentity(child, binding, `${location}.${key}`, seen);
  }
}

module.exports = { assertIssueIdentity };
