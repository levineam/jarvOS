'use strict';

function assertIssueIdentity(value, issueIdentifier, location, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const field of ['issueIdentifier', 'itemId', 'workItemId']) {
    if (value[field] != null && String(value[field]) !== issueIdentifier) {
      throw new Error(`${location}.${field} must match command.resource.id`);
    }
  }
  if (value.issue?.identifier != null && String(value.issue.identifier) !== issueIdentifier) {
    throw new Error(`${location}.issue.identifier must match command.resource.id`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (['workReference', 'workRef', 'beadsReference'].includes(key) && child != null) {
      const identifier = typeof child === 'string' ? child : child.itemId || child.id || child.ref;
      if (identifier == null || String(identifier) !== issueIdentifier) throw new Error(`${location}.${key} must match command.resource.id`);
    }
    if (child && typeof child === 'object') assertIssueIdentity(child, issueIdentifier, `${location}.${key}`, seen);
  }
}

module.exports = { assertIssueIdentity };
