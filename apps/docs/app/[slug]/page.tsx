import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookOpen, CheckCircle2, CircleAlert, Info } from 'lucide-react';
import { documents, navigation, type CalloutTone } from '../content';

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(documents).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const document = documents[slug];
  return document ? { title: document.title, description: document.summary } : {};
}

export default async function DocumentationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = documents[slug];
  if (!document) notFound();
  const flatItems = navigation.flatMap((group) => group.items);
  const position = flatItems.findIndex((item) => item.slug === slug);
  const previous = flatItems[position - 1];
  const next = flatItems[position + 1];

  return (
    <div className="docs-shell">
      <aside className="sidebar">
        <div className="sidebar-label">
          <BookOpen size={15} aria-hidden="true" />
          Documentation
        </div>
        <nav aria-label="Documentation">
          {navigation.map((group) => (
            <section className="nav-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => (
                <Link href={`/${item.slug}/`} key={item.slug}>
                  {item.title}
                </Link>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <main id="main-content" className="document">
        <article>
          <header className="document-header">
            <p className="eyebrow">{document.category}</p>
            <h1>{document.title}</h1>
            <p className="summary">{document.summary}</p>
            <p className="verified">Last verified for v0.2.0-beta.1</p>
          </header>
          {document.sections.map((section) => (
            <section className="content-section" id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.steps && (
                <ol>
                  {section.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              {section.bullets && (
                <ul>
                  {section.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              )}
              {section.code && (
                <pre tabIndex={0}>
                  <code>{section.code}</code>
                </pre>
              )}
              {section.table && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {section.table.headers.map((header) => (
                          <th key={header}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.table.rows.map((row) => (
                        <tr key={row.join('|')}>
                          {row.map((cell) => (
                            <td key={cell}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {section.callout && (
                <Callout tone={section.callout.tone}>{section.callout.text}</Callout>
              )}
            </section>
          ))}
          <nav className="page-nav" aria-label="Adjacent documentation pages">
            {previous ? (
              <Link href={`/${previous.slug}/`}>
                <span>Previous</span>
                {previous.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link className="next" href={`/${next.slug}/`}>
                <span>Next</span>
                {next.title}
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </article>
      </main>
    </div>
  );
}

function Callout({ tone, children }: { tone: CalloutTone; children: React.ReactNode }) {
  const Icon = tone === 'warning' ? CircleAlert : tone === 'success' ? CheckCircle2 : Info;
  return (
    <aside className={`callout ${tone}`}>
      <Icon size={19} aria-hidden="true" />
      <p>{children}</p>
    </aside>
  );
}
