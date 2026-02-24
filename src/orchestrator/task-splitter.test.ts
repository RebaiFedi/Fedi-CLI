import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTask } from './task-splitter.js';

test('splitTask routes mixed frontend+backend work to specialized prompts', () => {
  const split = splitTask('Build a React dashboard with backend API auth.');

  assert.equal(
    split.claudeTask,
    'Focus on the FRONTEND aspects of this task: Build a React dashboard with backend API auth.',
  );
  assert.equal(
    split.codexTask,
    'Focus on the BACKEND aspects of this task: Build a React dashboard with backend API auth.',
  );
});

test('splitTask routes frontend-only work and asks backend to support infra', () => {
  const split = splitTask('Create a responsive UI layout and animation for the landing page.');

  assert.equal(
    split.claudeTask,
    'Implement this frontend task: Create a responsive UI layout and animation for the landing page.',
  );
  assert.equal(
    split.codexTask,
    'Support the frontend by setting up any needed backend infrastructure for: Create a responsive UI layout and animation for the landing page.',
  );
});

test('splitTask routes backend-only work and asks frontend for supporting interfaces', () => {
  const split = splitTask('Implement API routes with database migrations.');

  assert.equal(
    split.claudeTask,
    'Create any frontend interfaces needed for: Implement API routes with database migrations.',
  );
  assert.equal(
    split.codexTask,
    'Implement this backend task: Implement API routes with database migrations.',
  );
});

test('splitTask falls back to generic frontend/backend split when no keywords match', () => {
  const split = splitTask('test');

  assert.equal(split.claudeTask, 'Handle the frontend/UI aspects of: test');
  assert.equal(split.codexTask, 'Handle the backend/infrastructure aspects of: test');
});
