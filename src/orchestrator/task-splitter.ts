export interface TaskSplit {
  claudeTask: string;
  codexTask: string;
}

const FRONTEND_KEYWORDS = [
  'ui', 'frontend', 'react', 'vue', 'svelte', 'component', 'css', 'style',
  'html', 'page', 'layout', 'responsive', 'design', 'button', 'form',
  'modal', 'navigation', 'sidebar', 'header', 'footer', 'animation',
  'client', 'browser', 'dom', 'jsx', 'tsx', 'tailwind', 'sass', 'scss',
];

const BACKEND_KEYWORDS = [
  'api', 'backend', 'server', 'database', 'db', 'endpoint', 'rest',
  'graphql', 'auth', 'authentication', 'middleware', 'route', 'schema',
  'migration', 'query', 'sql', 'nosql', 'redis', 'docker', 'deploy',
  'config', 'env', 'service', 'controller', 'model', 'orm', 'prisma',
];

export function splitTask(task: string): TaskSplit {
  const lower = task.toLowerCase();
  const hasFrontend = FRONTEND_KEYWORDS.some(kw => lower.includes(kw));
  const hasBackend = BACKEND_KEYWORDS.some(kw => lower.includes(kw));

  if (hasFrontend && hasBackend) {
    return {
      claudeTask: `Focus on the FRONTEND aspects of this task: ${task}`,
      codexTask: `Focus on the BACKEND aspects of this task: ${task}`,
    };
  }

  if (hasFrontend) {
    return {
      claudeTask: `Implement this frontend task: ${task}`,
      codexTask: `Support the frontend by setting up any needed backend infrastructure for: ${task}`,
    };
  }

  if (hasBackend) {
    return {
      claudeTask: `Create any frontend interfaces needed for: ${task}`,
      codexTask: `Implement this backend task: ${task}`,
    };
  }

  // Generic: both work on it from their perspective
  return {
    claudeTask: `Handle the frontend/UI aspects of: ${task}`,
    codexTask: `Handle the backend/infrastructure aspects of: ${task}`,
  };
}
