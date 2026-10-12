import { loadProjects } from '../navigation/project-navigator.js';

// Local registry of known Flow projects (name, url, campaign, last_used).
// No browser needed — answers "which project am I in / which exist" without
// a page round-trip.
export async function handleListProjects() {
  const store = loadProjects();
  const projects = [...(store.projects || [])]
    .sort((a, b) => new Date(b.last_used || b.created_at || 0) - new Date(a.last_used || a.created_at || 0))
    .map((p) => ({ name: p.name || null, url: p.url || null, campaign: p.campaign || null,
      last_used: p.last_used || null, tasks: Array.isArray(p.tasks) ? p.tasks.length : 0 }));
  return { status: 'success', count: projects.length, projects };
}
