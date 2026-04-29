import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

interface Props {
  content: string
  className?: string
}

function MarkdownImpl({ content, className }: Props) {
  return (
    <div className={cn('vibe-md text-[13px] text-text-primary leading-relaxed break-words [overflow-wrap:anywhere] max-w-full min-w-0', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node: _n, ...props }) => <h1 className="text-lg font-bold mt-3 mb-2" {...props} />,
          h2: ({ node: _n, ...props }) => <h2 className="text-base font-bold mt-3 mb-1.5" {...props} />,
          h3: ({ node: _n, ...props }) => <h3 className="text-sm font-semibold mt-2 mb-1" {...props} />,
          h4: ({ node: _n, ...props }) => <h4 className="text-[13px] font-semibold mt-2 mb-1" {...props} />,
          p: ({ node: _n, ...props }) => <p className="my-1.5" {...props} />,
          ul: ({ node: _n, ...props }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />,
          ol: ({ node: _n, ...props }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />,
          li: ({ node: _n, ...props }) => <li className="leading-relaxed" {...props} />,
          strong: ({ node: _n, ...props }) => <strong className="font-semibold text-text-primary" {...props} />,
          em: ({ node: _n, ...props }) => <em className="italic" {...props} />,
          code: ({ node: _n, className: cls, children, ...props }: any) => {
            // 언어 태그 있는 fenced block ( ```sql ) 또는 여러 줄 fenced block ( ``` 언어 없음 )
            // 둘 다 block 으로 취급. 그렇지 않으면 인라인 `code` 로 처리.
            const hasLang = /language-/.test(cls || '')
            const text = Array.isArray(children)
              ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
              : typeof children === 'string' ? children : ''
            const isBlock = hasLang || text.includes('\n')
            return isBlock ? (
              <code className={cn(cls, 'text-[12px] font-mono text-stone-100')} {...props}>{children}</code>
            ) : (
              <code className="px-1 py-0.5 rounded bg-chip text-[12px] font-mono break-all" {...props}>{children}</code>
            )
          },
          pre: ({ node: _n, ...props }) => (
            <pre
              className="my-2 p-2 rounded-md bg-bg-code text-stone-100 text-[12px] overflow-x-auto max-w-full whitespace-pre-wrap break-words"
              {...props}
            />
          ),
          blockquote: ({ node: _n, ...props }) => (
            <blockquote className="border-l-2 border-border pl-3 my-2 text-text-secondary" {...props} />
          ),
          a: ({ node: _n, ...props }) => (
            <a className="text-primary hover:underline" target="_blank" rel="noreferrer" {...props} />
          ),
          hr: () => <hr className="my-3 border-border-subtle" />,
          img: ({ node: _n, alt, ...props }) => (
            <img
              alt={alt}
              className="my-2 max-w-full rounded-md border border-border-subtle"
              loading="lazy"
              {...props}
            />
          ),
          table: ({ node: _n, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table className="text-[12px] border-collapse" {...props} />
            </div>
          ),
          th: ({ node: _n, ...props }) => (
            <th className="border border-border-subtle px-2 py-1 bg-chip font-semibold text-left" {...props} />
          ),
          td: ({ node: _n, ...props }) => (
            <td className="border border-border-subtle px-2 py-1" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

const Markdown = memo(MarkdownImpl, (prev, next) =>
  prev.content === next.content && prev.className === next.className
)
export default Markdown
