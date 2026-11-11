import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { JiraIssue } from '../shared/contracts';
import { Dialog } from './dialogs';
import { usePreferences } from './i18n';

export default function DescriptionDialog({ issue, onClose }: { issue: JiraIssue; onClose(): void }) {
  const { t } = usePreferences();
  const description = issue.descriptionMarkdown ?? issue.description ?? '';
  return <Dialog title={t(`Описание ${issue.key}`, `Description for ${issue.key}`)} className="description-dialog" onClose={onClose}>
    <div className="description-content">
      <h3>{issue.summary}</h3>
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href && !window.jiraDag && /^https?:\/\//i.test(href)
          ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          : <span title={href}>{children}</span>,
        img: ({ alt }) => alt ? <span>{alt}</span> : null,
      }}>{description}</Markdown>
    </div>
  </Dialog>;
}
