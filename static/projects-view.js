(function projectsViewModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvosProjectsView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function makeProjectsView() {
  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function coverageText(data) {
    const projectIds = data.scope?.projectIds || [];
    const suffix = data.capturedAt ? ` · as of ${esc(data.capturedAt)}` : '';
    return `Partial provider scope${projectIds.length ? ` · ${projectIds.length} admitted root${projectIds.length === 1 ? '' : 's'}` : ''}${suffix}`;
  }

  function render(data, activeId) {
    if (!data || data.status !== 'ok') {
      return `<section class="projects-unavailable card"><div class="page-kicker">provider unavailable</div><h2>Projects cannot be verified right now</h2><p>${esc(data?.reason || 'The authorized Projects provider did not return current data.')}</p><p class="project-scope">Partial coverage only · no registry fallback used</p></section>`;
    }
    if (!data.projects?.length) {
      return `<section class="projects-unavailable card"><div class="page-kicker">empty scope</div><h2>No admitted projects</h2><p>The provider returned no projects for its declared scope.</p><p class="project-scope">${coverageText(data)}</p></section>`;
    }
    const active = data.projects.find((project) => project.id === activeId) || data.projects[0];
    const evidence = active.completionEvidence?.length
      ? `<ul class="project-evidence">${active.completionEvidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : '<p class="project-unknown">Completion evidence unavailable</p>';
    return `<div class="projects-shell">
      <aside class="project-list card" aria-label="Projects">
        <p class="project-scope">${coverageText(data)}</p>
        ${data.projects.map((project) => `<button type="button" class="project-row ${project.id === active.id ? 'active' : ''}" data-project-id="${esc(project.id)}">
          <span><b>${esc(project.title)}</b><small>${esc(project.outcome)}</small></span><i>${esc(project.lifecycle)}</i>
        </button>`).join('')}
      </aside>
      <article class="project-detail card" data-active-project="${esc(active.id)}">
        <div class="page-kicker">selected project</div>
        <h2>${esc(active.title)}</h2>
        <section><h3>Outcome</h3><p>${esc(active.outcome)}</p></section>
        <section><h3>Definition of done</h3>${active.definitionOfDone ? `<p>${esc(active.definitionOfDone)}</p>` : '<p class="project-unknown">Definition unavailable</p>'}</section>
        <section><h3>Completion evidence</h3>${evidence}</section>
        <section><h3>Next step</h3>${active.nextStep ? `<p>${esc(active.nextStep)}</p>` : '<p class="project-unknown">Next step unavailable</p>'}</section>
        ${data.omissions?.length ? `<p class="project-omissions">Provider omissions: ${data.omissions.map(esc).join(' · ')}</p>` : ''}
      </article>
    </div>`;
  }

  return { render, coverageText };
});
