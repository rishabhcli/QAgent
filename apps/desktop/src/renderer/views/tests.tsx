import type { Project, Provenance, TestCase } from '@qagent/contracts';
import { Beaker, Command, MousePointer2 } from 'lucide-react';
import { EmptyState } from '../components/empty-state.js';
import { SourceStamp } from '../components/source-stamp.js';

export function TestsView({
  tests,
  projects,
  provenance,
}: {
  tests: TestCase[];
  projects: Project[];
  provenance: Provenance;
}) {
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  return (
    <div className="view-stack">
      <section className="simple-heading">
        <div>
          <p className="eyebrow">Grounded checks</p>
          <h2>Tests</h2>
          <p>
            Loaded from each trusted project’s <span className="mono">.qagent.yml</span>.
          </p>
        </div>
        <SourceStamp provenance={provenance} />
      </section>
      {tests.length === 0 ? (
        <EmptyState
          icon={Beaker}
          title="No test cases recorded"
          detail="Tests appear after QAgent discovers a configured project."
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
                  <code>{JSON.stringify(test.definition)}</code>
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
