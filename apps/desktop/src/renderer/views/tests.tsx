import type { Project, Provenance, TestCase } from '@qagent/contracts';
import { Beaker, Command, MousePointer2, Wrench } from 'lucide-react';
import { EmptyState } from '../components/empty-state.js';
import { SourceStamp } from '../components/source-stamp.js';
import { redactDisplayValue } from '../display-redaction.js';

export function TestsView({
  tests,
  projects,
  provenance,
  onOpenProjects,
}: {
  tests: TestCase[];
  projects: Project[];
  provenance: Provenance;
  onOpenProjects: () => void;
}) {
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const commandCount = tests.filter((test) => test.kind === 'command').length;
  const browserCount = tests.length - commandCount;
  return (
    <div className="view-stack tests-view">
      <section className="simple-heading">
        <div>
          <p className="eyebrow">Grounded checks</p>
          <h2>Tests</h2>
          <p>Loaded from each trusted project’s validated QAgent configuration.</p>
        </div>
        <SourceStamp provenance={provenance} />
      </section>
      <section className="test-catalog-signal" aria-label="Test catalog summary">
        <span>
          <strong>{tests.length}</strong>
          <small>Grounded checks</small>
        </span>
        <i aria-hidden="true" />
        <span>
          <strong>{commandCount}</strong>
          <small>Command</small>
        </span>
        <i aria-hidden="true" />
        <span>
          <strong>{browserCount}</strong>
          <small>Browser</small>
        </span>
        <span className="catalog-pulse" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </section>
      {tests.length === 0 ? (
        <EmptyState
          icon={Beaker}
          title="No test cases recorded"
          detail="Tests appear after QAgent discovers a configured project."
          action={
            <button type="button" className="button primary" onClick={onOpenProjects}>
              <Wrench size={16} /> Configure a project
            </button>
          }
        />
      ) : (
        <div className="test-list">
          {tests.map((test) => {
            const Icon = test.kind === 'command' ? Command : MousePointer2;
            return (
              <article className="test-row" key={test.id}>
                <span className="test-icon">
                  <Icon size={18} />
                </span>
                <div>
                  <div className="test-title">
                    <strong>{test.name}</strong>
                    <span>{test.kind}</span>
                  </div>
                  <p>{projectName.get(test.projectId) ?? 'Unknown project'}</p>
                  <code>{testDefinitionSummary(test)}</code>
                  <details className="test-definition">
                    <summary>Raw definition</summary>
                    <pre>{JSON.stringify(redactDisplayValue(test.definition), null, 2)}</pre>
                  </details>
                </div>
                <SourceStamp provenance={test.provenance} />
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function testDefinitionSummary(test: TestCase): string {
  if (test.kind === 'command') {
    const executable = test.definition.executable;
    const args = test.definition.args;
    if (typeof executable === 'string') {
      return [executable, ...(Array.isArray(args) ? args.filter(isString) : [])].join(' ');
    }
  }

  const flow = test.definition.flow;
  const target = test.definition.targetUrl ?? test.definition.url;
  const steps = test.definition.steps;
  if (typeof flow === 'string' && typeof target === 'string') return `${flow} · ${target}`;
  if (typeof flow === 'string') return flow;
  if (typeof target === 'string') return target;
  if (Array.isArray(steps)) {
    const firstStep = steps.find(isString);
    if (firstStep) return firstStep;
  }
  return 'Structured project check';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
